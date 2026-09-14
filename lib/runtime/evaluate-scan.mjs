/**
 * evaluate-scan.mjs — single-command evaluation of scan-results triage.
 *
 * Consumes data/scan-results-*.tsv, runs the liveness gate, fetches JD
 * evidence, then prepare -> respond -> commit through the provider-free
 * runtime. Unevaluated survivors stay in triage; only committed rows land
 * in applications.md.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { normalizeSource, normalizeUrlKey } from '../sources.mjs';
import { launchChromium } from './playwright-browser.mjs';
import {
  loadCandidateContext,
  postingAgeDays,
  resolveEligibilityGates,
  resolveGeographyGate,
  titleLevelCompatible,
} from './candidate-context.mjs';
import { captureHistoricalEvidence, plainTextFromHtml, probeAtsLiveness } from './historical-evidence.mjs';
import { evaluateWithProvider } from './orchestrator.mjs';
import { prepareTask } from './prepare.mjs';
import { createProvider } from './providers/index.mjs';
import { resolveRoutingProfile } from './route-shadow.mjs';
import { routeTask } from './router.mjs';
import { commitEvaluation, persistencePaths } from './transaction.mjs';
import { isoNow, record, sha256 } from './util.mjs';
import { classifyLiveness, isAtsHost, isSpaHost } from '../../liveness-core.mjs';

const SCAN_HEADER = 'url\tcompany\ttitle\tlocation\tsource\n';
const EVALUATE_QUEUE_NAME = 'evaluate-queue.tsv';
// Floor for "the fetch returned something usable at all".
const MIN_JD_CHARS = 200;
// Floor for "this is a complete posting worth assigning a defensible score to".
// Below this, required_evidence_complete stays UNKNOWN and the policy engine
// returns REVIEW_REQUIRED instead of letting a nav blob produce a 4.2/5.
const MIN_SCORABLE_JD_CHARS = 900;
// Cap retained page text so a 757-URL run does not hold every full DOM in memory.
const MAX_RETAINED_PAGE_CHARS = 20 * 1024;
const DEFAULT_MAX_AGE_DAYS = 21;
const LIVENESS_CACHE_TTL_HOURS = 12;

export function listScanResultFiles(dataDir) {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter(name => /^scan-results-\d{4}-\d{2}-\d{2}\.tsv$/i.test(name))
    .map(name => join(dataDir, name))
    .sort();
}

/** Durable handoff of the last plan's eval queue. Judge/sweep score only this. */
export function evaluateQueuePath(dataDir) {
  return join(dataDir, EVALUATE_QUEUE_NAME);
}

export function writeEvaluateQueue(path, rows) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeScanResultsTsv(path, rows);
  return path;
}

export function readEvaluateQueue(path) {
  if (!path || !existsSync(path)) return [];
  return parseScanResultsTsv(readFileSync(path, 'utf8')).map(row => ({ ...row, file: path }));
}

export function parseScanResultsTsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const start = /^url\tcompany\ttitle/i.test(lines[0]) ? 1 : 0;
  const rows = [];
  for (const line of lines.slice(start)) {
    const [url, company, title, location = '', source = 'unknown'] = line.split('\t');
    if (!url || !/^https?:\/\//i.test(url)) continue;
    rows.push({
      url: url.trim(),
      company: (company || '').trim(),
      title: (title || '').trim(),
      location: (location || '').trim(),
      source: normalizeSource((source || 'unknown').split('|')[0]) || 'unknown',
      raw_source: (source || 'unknown').trim(),
    });
  }
  return rows;
}

export function loadScanResults(filePaths) {
  // Dedupe on the requisition fingerprint, not the raw string: the same posting
  // arrives with different utm/tracking query tails from different feeds.
  const seen = new Set();
  const rows = [];
  for (const path of filePaths) {
    if (!existsSync(path)) continue;
    for (const row of parseScanResultsTsv(readFileSync(path, 'utf8'))) {
      const key = normalizeUrlKey(row.url) || row.url;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...row, file: path, url_key: key });
    }
  }
  return rows;
}

export function writeScanResultsTsv(path, rows) {
  const body = rows.map(row => [
    row.url,
    row.company || '',
    row.title || '',
    row.location || '',
    row.raw_source || row.source || 'unknown',
  ].join('\t')).join('\n');
  writeFileSync(path, `${SCAN_HEADER}${body}${body ? '\n' : ''}`, 'utf8');
}

export function guessResume(title = '') {
  return /\b(ml|machine learning|data scien|applied scien|ai engineer|deep learning|nlp|computer vision)\b/i.test(title)
    ? 'MLE'
    : 'SDE';
}

async function collectPageSignals(page) {
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
  const applyControls = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]'),
    );
    return candidates
      .filter(el => {
        // Keep sticky header Apply CTAs (Ashby/Greenhouse). Drop chrome noise only.
        if (el.closest('footer, [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (!el.getClientRects().length) return false;
        return Array.from(el.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
      })
      .map(el => {
        return [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title')]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      })
      .filter(Boolean)
      .slice(0, 60);
  });
  return { bodyText, applyControls };
}

async function checkOne(context, url) {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const status = response?.status() ?? 0;
    const spa = isSpaHost(page.url()) || isSpaHost(url);
    await page.waitForTimeout(spa ? 5000 : 2000);
    // Prefer waiting for real JD/apply chrome instead of guessing from an empty shell.
    if (spa) {
      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        if (text.trim().length >= 500) return true;
        const nodes = Array.from(document.querySelectorAll('a, button, [role="button"]'));
        return nodes.some(el => /\bapply\b/i.test(el.innerText || el.getAttribute('aria-label') || ''));
      }, { timeout: 8000 }).catch(() => {});
    }

    let { bodyText, applyControls } = await collectPageSignals(page);
    if (spa && bodyText.trim().length < 300) {
      await page.waitForTimeout(4000);
      ({ bodyText, applyControls } = await collectPageSignals(page));
    }

    const finalUrl = page.url();
    let verdict = classifyLiveness({ status, finalUrl, bodyText, applyControls });
    // Empty Playwright shells on ATS hosts are usually hydration/bot issues.
    // Probe the public ATS API before dropping or parking the URL.
    const needsAtsProbe = (
      (verdict.result === 'uncertain' && /empty SPA shell/i.test(verdict.reason || ''))
      || (verdict.result === 'expired' && /insufficient content/i.test(verdict.reason || ''))
    ) && isAtsHost(finalUrl || url);
    if (needsAtsProbe) {
      const probe = await probeAtsLiveness(url);
      if (probe.result === 'active') {
        verdict = { result: 'active', reason: probe.reason };
      } else if (probe.result === 'expired') {
        verdict = { result: 'expired', reason: probe.reason };
      } else {
        verdict = {
          result: 'uncertain',
          reason: `${verdict.reason}; API probe: ${probe.reason}`,
        };
      }
    }
    return {
      ...verdict,
      bodyText: bodyText.slice(0, MAX_RETAINED_PAGE_CHARS),
      finalUrl,
      httpStatus: status,
    };
  } catch (error) {
    return {
      result: 'uncertain',
      status: 'error',
      reason: error.message || 'navigation_failed',
      bodyText: '',
      finalUrl: url,
      httpStatus: 0,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function runLivenessGate(urls, { concurrency = 10, onProgress = null } = {}) {
  const unique = [...new Set(urls.filter(Boolean))];
  const browser = await launchChromium({ headless: true });
  // Match liveness-parallel / Chromium defaults. A custom bot UA made many
  // live ATS pages return empty shells that classifyLiveness marked expired.
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const results = new Map();
  let index = 0;
  async function worker() {
    while (index < unique.length) {
      const current = unique[index++];
      const verdict = await checkOne(context, current);
      results.set(current, verdict);
      onProgress?.({ done: results.size, total: unique.length, url: current, result: verdict.result });
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, unique.length)) }, () => worker()));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  return results;
}

const LIVENESS_CACHE_HEADER = 'url\tresult\treason\tchecked_at\n';

/** Read a previous liveness pass so a rerun does not re-probe every URL. */
export function readLivenessCache(path, { ttlHours = LIVENESS_CACHE_TTL_HOURS, now = Date.now() } = {}) {
  const cache = new Map();
  if (!path || !existsSync(path)) return cache;
  const ttlMs = Math.max(0, Number(ttlHours) || 0) * 3_600_000;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || /^url\t/i.test(line)) continue;
    const [url, result, reason = '', checkedAt = ''] = line.split('\t');
    if (!url || !['active', 'expired', 'uncertain'].includes(result)) continue;
    const stamp = Date.parse(checkedAt);
    if (!Number.isFinite(stamp) || now - stamp > ttlMs) continue;
    cache.set(url, { result, reason, checked_at: checkedAt, bodyText: '', cached: true });
  }
  return cache;
}

export function writeLivenessCache(path, verdicts) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = [...verdicts.entries()]
    .map(([url, verdict]) => [
      url,
      verdict.result,
      String(verdict.reason || '').replace(/\s+/g, ' ').slice(0, 200),
      verdict.checked_at || isoNow(),
    ].join('\t'))
    .join('\n');
  writeFileSync(path, `${LIVENESS_CACHE_HEADER}${body}${body ? '\n' : ''}`, { mode: 0o600 });
}

/**
 * Serialize a section of work. Provider calls run concurrently, but tracker
 * commits take a writer lock and reserve report numbers, so they must not.
 */
function createMutex() {
  let tail = Promise.resolve();
  return async function locked(fn) {
    const previous = tail;
    let release;
    tail = new Promise(resolve_ => { release = resolve_; });
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

async function runPool(items, limit, worker) {
  let cursor = 0;
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }));
}

export async function fetchJobEvidence(row, { fetchImpl = fetch, pageText = '' } = {}) {
  const captured = await captureHistoricalEvidence({
    caseId: sha256(row.url).slice(0, 12),
    sourceUrl: row.url,
    expectedTitle: row.title,
    fetchImpl,
  });
  if (captured.complete && captured.content) {
    return {
      ok: true,
      source_type: captured.source_type || row.source,
      content: captured.content,
      title: captured.title || row.title,
      liveness_state: captured.liveness_state || 'YES',
      posted_at: captured.posted_at || null,
      method: 'ats_api',
    };
  }

  const text = plainTextFromHtml(pageText || '');
  if (text.length >= MIN_JD_CHARS) {
    return {
      ok: true,
      source_type: row.source || 'unknown',
      content: text,
      title: row.title,
      liveness_state: 'YES',
      posted_at: null,
      method: 'page_text',
    };
  }

  // Generic HTML fetch for non-ATS URLs when Playwright text was empty. A bot
  // user-agent here draws 403s and challenge pages, so present as a browser.
  try {
    const response = await fetchImpl(row.url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    const html = await response.text();
    const content = plainTextFromHtml(html);
    if (response.ok && content.length >= MIN_JD_CHARS) {
      return {
        ok: true,
        source_type: row.source || 'unknown',
        content,
        title: row.title,
        liveness_state: 'YES',
        posted_at: null,
        method: 'http_html',
      };
    }
  } catch {
    /* reported below */
  }

  return {
    ok: false,
    error: captured.error_code || 'JD_FETCH_FAILED',
    source_type: row.source || 'unknown',
  };
}

/**
 * Build the task seed.
 *
 * Two evidence items: the untrusted posting, and the candidate's own record as
 * trusted first-party evidence. Without the second one there is nothing to
 * match a CV against, and the gates that decide APPLY-vs-CONSIDER can never
 * resolve, which held every result at CONSIDER regardless of fit.
 */
function buildSeed(row, evidence, livenessState, candidate) {
  const jdText = evidence.content;
  const scorable = jdText.length >= MIN_SCORABLE_JD_CHARS;
  const geography = resolveGeographyGate({
    locationText: row.location || '',
    jdText,
    context: candidate,
  });
  const eligibility = resolveEligibilityGates({
    jdText,
    livenessState: livenessState === 'uncertain' ? 'UNKNOWN' : 'YES',
    context: candidate,
    scorable,
  });

  const posting = {
    id: 'EV-1',
    source_type: evidence.source_type || row.source,
    uri: row.url,
    content: jdText,
    liveness_state: livenessState === 'uncertain' ? 'UNKNOWN' : 'YES',
    structured_fields: {
      required_evidence_complete: scorable ? 'YES' : 'UNKNOWN',
      ...(geography.value === 'UNKNOWN' ? {} : { geography_eligible: geography.value }),
      ...eligibility.gates,
    },
  };

  const evidenceItems = [posting];
  if (candidate?.available) evidenceItems.push({ ...candidate.evidence });

  return {
    seed: {
      company: row.company,
      role: evidence.title || row.title,
      url: row.url,
      resume: guessResume(evidence.title || row.title),
      source: row.source,
      evidence: evidenceItems,
    },
    gate_resolution: {
      scorable,
      geography: geography.value,
      geography_reason: geography.reason,
      eligibility_reasons: eligibility.reasons,
    },
  };
}

function pickProviderId(config, { provider, profile }) {
  if (provider) {
    if (!config.providers?.[provider]) throw new Error(`Unknown provider: ${provider}`);
    return provider;
  }
  if (profile) {
    const resolved = resolveRoutingProfile(config, profile);
    return resolved.judgment.provider;
  }
  throw new Error('evaluate requires --provider <id> or --profile <routing-profile>');
}

function removeEvaluatedUrls(filePaths, evaluatedUrls) {
  const removed = [];
  for (const path of filePaths) {
    if (!existsSync(path)) continue;
    const rows = parseScanResultsTsv(readFileSync(path, 'utf8'));
    const kept = rows.filter(row => !evaluatedUrls.has(row.url));
    const dropped = rows.length - kept.length;
    if (!dropped) continue;
    if (kept.length === 0) {
      unlinkSync(path);
      removed.push({ path, deleted: true, remaining: 0 });
    } else {
      writeScanResultsTsv(path, kept);
      removed.push({ path, deleted: false, remaining: kept.length });
    }
  }
  return removed;
}

/**
 * Evaluate scan-results triage through the runtime pipeline.
 *
 * Without `apply`, returns a plan only (optionally after liveness).
 * With `apply`, invokes a provider and commits successful evaluations.
 */
export async function evaluateScanResults({
  target,
  config = null,
  files = null,
  max = Infinity,
  apply = false,
  fromQueue = false,
  queuePath: queuePathOption = null,
  skipLiveness = false,
  provider = null,
  profile = null,
  concurrency = 10,
  evaluateConcurrency = 3,
  acknowledgeQuota = false,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  allowSenior = false,
  forceProvider = false,
  livenessCache = true,
  refreshLiveness = false,
  livenessTtlHours = LIVENESS_CACHE_TTL_HOURS,
  onProgress = null,
  fetchImpl = fetch,
  // Test-only seams. Production callers leave these unset.
  providerHandle: injectedProvider = null,
  livenessResults = null,
  fetchEvidence = null,
  candidateContext = null,
} = {}) {
  const paths = persistencePaths(target);
  const defaultQueuePath = evaluateQueuePath(paths.dataDir);
  const queuePath = queuePathOption ? resolve(queuePathOption) : defaultQueuePath;
  const triageFiles = files?.length ? files.map(path => resolve(path)) : listScanResultFiles(paths.dataDir);

  let selectedFiles;
  let candidates;
  let sourceMode;
  if (fromQueue) {
    if (!existsSync(queuePath)) {
      throw Object.assign(
        new Error(`No eval queue at ${queuePath}. Run npm run evaluate / evaluate:plan first.`),
        { code: 'EVAL_QUEUE_MISSING' },
      );
    }
    candidates = readEvaluateQueue(queuePath);
    if (Number.isFinite(max)) candidates = candidates.slice(0, max);
    selectedFiles = [...new Set([...triageFiles, queuePath])];
    sourceMode = 'queue';
    if (!candidates.length) {
      return record('EvaluateScanResultV1', {
        target: paths.target,
        files: selectedFiles,
        queue_path: queuePath,
        source: sourceMode,
        candidate_count: 0,
        candidates: [],
        apply: Boolean(apply),
        created_at: isoNow(),
        status: 'EMPTY',
        liveness: { active: 0, expired: 0, uncertain: 0 },
        results: [],
        message: `Eval queue is empty (${queuePath}). Run evaluate:plan to refill it.`,
      });
    }
  } else {
    selectedFiles = triageFiles;
    candidates = loadScanResults(selectedFiles).slice(0, Number.isFinite(max) ? max : undefined);
    sourceMode = 'triage';
  }

  const planFields = {
    target: paths.target,
    files: selectedFiles,
    queue_path: queuePath,
    source: sourceMode,
    candidate_count: candidates.length,
    candidates: candidates.map(row => ({
      url: row.url,
      company: row.company,
      title: row.title,
      source: row.source,
      file: row.file,
    })),
    apply: Boolean(apply),
    created_at: isoNow(),
  };

  if (!candidates.length) {
    return record('EvaluateScanResultV1', {
      ...planFields,
      status: 'EMPTY',
      liveness: { active: 0, expired: 0, uncertain: 0 },
      results: [],
    });
  }

  const candidate = candidateContext || loadCandidateContext({ root: null });
  const cachePath = livenessCache ? join(paths.runtimeDir, 'liveness-cache.tsv') : null;

  // Deterministic level filter runs first: a senior requisition should not cost
  // a liveness probe or a provider call, and must never surface as CONSIDER.
  const skipped = [];
  const eligible = [];
  for (const row of candidates) {
    const level = allowSenior
      ? { ok: true, band: 'ignored', reason: null }
      : titleLevelCompatible(row.title, candidate, { url: row.url });
    if (!level.ok) {
      skipped.push({ row, code: 'LEVEL_MISMATCH', reason: level.reason, band: level.band });
      continue;
    }
    // A definitively non-US location fails a hard policy gate anyway. Dropping
    // it here saves a liveness probe and a provider call per row.
    const geography = resolveGeographyGate({ locationText: row.location || '', context: candidate });
    if (geography.value === 'NO') {
      skipped.push({ row, code: 'GEOGRAPHY_INELIGIBLE', reason: geography.reason, band: level.band });
      continue;
    }
    eligible.push(row);
  }

  let livenessMap = new Map();
  let livenessCacheHits = 0;
  if (livenessResults) {
    livenessMap = livenessResults;
  } else if (!skipLiveness) {
    const cached = refreshLiveness
      ? new Map()
      : readLivenessCache(cachePath, { ttlHours: livenessTtlHours });
    const pending = [];
    for (const row of eligible) {
      const hit = cached.get(row.url);
      if (hit) {
        livenessMap.set(row.url, hit);
        livenessCacheHits++;
      } else {
        pending.push(row.url);
      }
    }
    if (pending.length) {
      const fresh = await runLivenessGate(pending, {
        concurrency,
        onProgress: progress => onProgress?.({
          stage: 'liveness',
          ...progress,
          done: progress.done + livenessCacheHits,
          total: eligible.length,
        }),
      });
      for (const [url, verdict] of fresh) livenessMap.set(url, { ...verdict, checked_at: isoNow() });
    }
    if (cachePath) {
      try {
        writeLivenessCache(cachePath, livenessMap);
      } catch { /* a cache write failure must not fail the run */ }
    }
  } else {
    for (const row of eligible) {
      livenessMap.set(row.url, { result: 'active', status: 'skipped', reason: 'skip_liveness', bodyText: '' });
    }
  }

  const expired = [];
  const uncertain = [];
  const active = [];
  for (const row of eligible) {
    const verdict = livenessMap.get(row.url) || { result: 'uncertain', reason: 'missing' };
    if (verdict.result === 'expired') expired.push({ row, verdict });
    else if (verdict.result === 'uncertain') uncertain.push({ row, verdict });
    else active.push({ row, verdict });
  }

  // Keep uncertain for evaluation (same policy as scan.md) but flag Notes via
  // presentation sanitizer/commit path through liveness_state UNKNOWN.
  const toEvaluate = [...active, ...uncertain];

  const gateSummary = {
    candidate_record: candidate.available,
    entry_level_only: Boolean(candidate.entry_level_only && !allowSenior),
    us_only: Boolean(candidate.us_only),
    level_skipped: skipped.length,
    max_age_days: Number(maxAgeDays) || 0,
    liveness_cache_hits: livenessCacheHits,
  };

  if (!apply) {
    // Deterministic rejects (level / geography) and expired postings must leave
    // the triage handoff even without --apply. Otherwise --max N keeps reading
    // the same rejected head of the file forever.
    const dropUrls = new Set([
      ...expired.map(item => item.row.url),
      ...skipped.map(item => item.row.url),
    ]);
    const triageUpdates = dropUrls.size
      ? removeEvaluatedUrls(selectedFiles.filter(path => path !== queuePath), dropUrls)
      : [];
    // Persist the survivors as the durable eval queue. Judge/sweep score only
    // this file, not the next N rows of scan-results.
    const queueRows = toEvaluate.map(({ row }) => row);
    writeEvaluateQueue(queuePath, queueRows);
    const pruned = skipped.length + expired.length;
    return record('EvaluateScanResultV1', {
      ...planFields,
      status: 'PLAN',
      liveness: {
        active: active.length,
        expired: expired.length,
        uncertain: uncertain.length,
      },
      gates: gateSummary,
      expired: expired.map(item => ({ url: item.row.url, reason: item.verdict.reason })),
      uncertain: uncertain.map(item => ({
        url: item.row.url,
        company: item.row.company,
        title: item.row.title,
        reason: item.verdict.reason,
      })),
      skipped: skipped.map(item => ({
        url: item.row.url,
        company: item.row.company,
        title: item.row.title,
        code: item.code,
        reason: item.reason,
      })),
      queue: toEvaluate.map(item => ({
        url: item.row.url,
        company: item.row.company,
        title: item.row.title,
        source: item.row.source,
        liveness: item.verdict.result,
        reason: item.verdict.reason,
      })),
      queue_path: queuePath,
      triage_updates: triageUpdates,
      pruned,
      results: [],
      message: [
        pruned ? `Pruned ${pruned} rejected row(s) from triage.` : null,
        `Eval queue saved (${queueRows.length}): ${queuePath}.`,
        'Score it with npm run evaluate:judge (or evaluate:sweep). No A–G reports written yet.',
      ].filter(Boolean).join(' '),
    });
  }

  if (!config) throw new Error('evaluate --apply requires --config');
  if (!acknowledgeQuota) throw new Error('evaluate invokes a provider and requires --acknowledge-quota');

  if (!toEvaluate.length) {
    const triageUpdates = removeEvaluatedUrls(selectedFiles, new Set([
      ...expired.map(item => item.row.url),
      ...skipped.map(item => item.row.url),
    ]));
    return record('EvaluateScanResultV1', {
      ...planFields,
      status: 'COMPLETED',
      liveness: {
        active: active.length,
        expired: expired.length,
        uncertain: uncertain.length,
      },
      gates: gateSummary,
      expired: expired.map(item => ({ url: item.row.url, reason: item.verdict.reason })),
      skipped: skipped.map(item => ({
        url: item.row.url,
        company: item.row.company,
        title: item.row.title,
        code: item.code,
        reason: item.reason,
      })),
      triage_updates: triageUpdates,
      results: [],
      committed: 0,
      failed: 0,
      message: skipped.length
        ? 'No candidates remained after the liveness and level gates.'
        : 'No live candidates remained after the liveness gate.',
    });
  }

  const providerId = pickProviderId(config, { provider, profile });
  const providerConfig = config.providers[providerId];
  // Routing normally refuses unqualified, unobserved, or quota-exhausted
  // providers. Evaluate used to override all three unconditionally, so an
  // unqualified model could author committed reports. The override is now an
  // explicit opt-in and is recorded in the result.
  //
  // A provider someone deliberately failed or retired is a different thing from
  // one that simply has no qualification record yet. The first needs an explicit
  // acknowledgement; the second is the normal state of a local opt-in model and
  // only needs to be reported.
  const blockingGaps = [];
  const recordedGaps = [];
  if (providerConfig.enabled === false) blockingGaps.push('provider_disabled');
  if (providerConfig.qualification?.qualified === false) blockingGaps.push('qualification_failed');
  if (providerConfig.qualification?.lifecycle_state === 'retired') blockingGaps.push('lifecycle_retired');
  if (!providerConfig.qualification) recordedGaps.push('never_qualified');
  else if (providerConfig.qualification.qualified !== true) recordedGaps.push('qualification_incomplete');
  const lifecycle = providerConfig.qualification?.lifecycle_state;
  if (lifecycle && lifecycle !== 'production' && lifecycle !== 'retired') recordedGaps.push(`lifecycle_${lifecycle}`);
  if (providerConfig.observation?.available !== true) recordedGaps.push('unobserved');

  if (blockingGaps.length && !forceProvider) {
    throw Object.assign(
      new Error(`Provider ${providerId} is disabled or has failed qualification (${blockingGaps.join(', ')}). Re-run with --force-provider to accept it anyway.`),
      { code: 'PROVIDER_NOT_QUALIFIED', details: { provider_id: providerId, gaps: blockingGaps } },
    );
  }
  const qualificationGaps = [...blockingGaps, ...recordedGaps];
  const overrideApplied = qualificationGaps.length > 0;
  const effectiveProviderConfig = overrideApplied
    ? {
      ...providerConfig,
      enabled: true,
      qualification: {
        ...(providerConfig.qualification || {}),
        qualified: true,
        lifecycle_state: 'production',
        confidence_interval_95: {
          lower: Math.max(0.99, Number(providerConfig.qualification?.confidence_interval_95?.lower || 0)),
          upper: 1,
        },
      },
      observation: {
        ...(providerConfig.observation || {}),
        available: true,
        observed_at: isoNow(),
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        latency_ms: Number(providerConfig.observation?.latency_ms || 1),
      },
    }
    : providerConfig;

  mkdirSync(paths.dataDir, { recursive: true });
  const providerHandle = injectedProvider || createProvider(providerId, effectiveProviderConfig, config);
  const slots = new Array(toEvaluate.length).fill(null);
  const committedUrls = new Set();
  const staleUrls = new Set();
  const evidenceFetcher = fetchEvidence || ((row, opts) => fetchJobEvidence(row, opts));
  const withCommitLock = createMutex();
  const ageLimitDays = Number(maxAgeDays) || 0;
  let triageUpdates = [];
  let completed = 0;

  try {
    await runPool(toEvaluate, evaluateConcurrency, async ({ row, verdict }, index) => {
      onProgress?.({
        stage: 'evaluate',
        phase: 'fetch',
        done: completed,
        total: toEvaluate.length,
        url: row.url,
        company: row.company,
        title: row.title,
      });
      try {
        const evidence = await evidenceFetcher(row, {
          fetchImpl,
          pageText: verdict.bodyText || '',
        });
        if (!evidence.ok) {
          slots[index] = {
            url: row.url,
            status: 'FETCH_FAILED',
            error: evidence.error,
            company: row.company,
            title: row.title,
          };
          return;
        }
        // True-age gate. modes/scan.md caps candidates at 21 days; the runtime
        // path had no equivalent, so stale reqs still earned full reports.
        const ageDays = postingAgeDays(evidence.posted_at);
        if (ageLimitDays > 0 && ageDays !== null && ageDays > ageLimitDays) {
          staleUrls.add(row.url);
          slots[index] = {
            url: row.url,
            status: 'SKIPPED_STALE',
            company: row.company,
            title: row.title,
            age_days: ageDays,
            error: `posting is ${ageDays} days old (limit ${ageLimitDays})`,
          };
          return;
        }
        const { seed, gate_resolution: gateResolution } = buildSeed(row, evidence, verdict.result, candidate);
        const task = prepareTask(seed);
        const evidenceContent = Object.fromEntries(
          seed.evidence.map(item => [item.id, item.content]),
        );
        const routed = routeTask(task, {
          ...config,
          providers: { [providerId]: effectiveProviderConfig },
          resource_pools: {
            ...(config.resource_pools || {}),
            [effectiveProviderConfig.resource_pool]: {
              ...(config.resource_pools?.[effectiveProviderConfig.resource_pool] || {}),
              schema: 'ResourcePoolV1',
              schema_version: 1,
              quota_state: 'AVAILABLE',
              remaining_ratio: 1,
              expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
              minimum_reserve_ratio: 0,
              emergency_reserve_ratio: 0,
            },
          },
        });
        if (routed.result !== 'ROUTED' || routed.provider_id !== providerId) {
          throw Object.assign(new Error(`Provider is not eligible: ${routed.reason || routed.result}`), {
            code: 'NO_ELIGIBLE_PROVIDER',
            details: routed,
          });
        }
        onProgress?.({
          stage: 'evaluate',
          phase: 'judge',
          done: completed,
          total: toEvaluate.length,
          url: row.url,
          company: row.company,
          title: row.title,
          provider: providerId,
        });
        const evaluation = await evaluateWithProvider({
          task,
          evidenceContent,
          provider: providerHandle,
          retentionTarget: paths.target,
        });
        // Commits reserve a report number and take the writer lock, so they are
        // serialized even though the provider calls above run concurrently.
        const receipt = await withCommitLock(async () => {
          const committed = await commitEvaluation({
            target: paths.target,
            ...evaluation,
            trueAgeDays: ageDays,
          });
          committedUrls.add(row.url);
          // Update triage as we go: an interrupted run used to leave committed
          // rows in the handoff file, and the rerun duplicated their reports.
          triageUpdates = removeEvaluatedUrls(selectedFiles, new Set([
            ...expired.map(item => item.row.url),
            ...skipped.map(item => item.row.url),
            ...staleUrls,
            ...committedUrls,
          ]));
          return committed;
        });
        const reportNumber = receipt.report_identity?.report_number ?? null;
        const companySlug = receipt.report_identity?.company_slug || '';
        const roleSlug = receipt.report_identity?.role_slug || '';
        const reportDate = receipt.report_identity?.date || '';
        const reportRel = reportNumber && companySlug && roleSlug
          ? `reports/${companySlug}/${reportNumber}-${roleSlug}-${reportDate}.md`
          : null;
        slots[index] = {
          url: row.url,
          status: 'COMMITTED',
          company: row.company,
          title: row.title,
          location: row.location || '',
          source: row.source || '',
          decision: evaluation.decision.decision,
          // The authorized score only. Falling back to the normalized score
          // resurrected values the policy engine had deliberately nulled.
          score: evaluation.decision.score ?? null,
          report_number: reportNumber,
          report_path: reportRel,
          receipt_id: receipt.receipt_id || null,
          liveness: verdict.result,
          age_days: ageDays,
          evidence_method: evidence.method,
          scorable: gateResolution.scorable,
          policy_reasons: (evaluation.decision.reasons || [])
            .map(item => item.code || item)
            .filter(Boolean)
            .slice(0, 6),
        };
      } catch (error) {
        slots[index] = {
          url: row.url,
          status: 'FAILED',
          company: row.company,
          title: row.title,
          error: error.message,
          code: error.code || error.name,
        };
      } finally {
        completed++;
        onProgress?.({
          stage: 'evaluate',
          phase: 'done',
          done: completed,
          total: toEvaluate.length,
          url: row.url,
          company: row.company,
          title: row.title,
          result: slots[index]?.decision || slots[index]?.status,
        });
      }
    });
  } finally {
    if (!injectedProvider) providerHandle.close?.();
  }

  const results = slots.filter(Boolean);
  // Final sweep in case nothing committed but rows still need dropping.
  triageUpdates = removeEvaluatedUrls(selectedFiles, new Set([
    ...expired.map(item => item.row.url),
    ...skipped.map(item => item.row.url),
    ...staleUrls,
    ...committedUrls,
  ])).concat(triageUpdates.filter(update => update.deleted));

  const failedRows = results.filter(item => item.status === 'FAILED' || item.status === 'FETCH_FAILED');
  const failureLedger = writeFailureLedger(paths, failedRows);

  return record('EvaluateScanResultV1', {
    ...planFields,
    status: 'COMPLETED',
    provider_id: providerId,
    provider_override: overrideApplied
      ? { forced: true, gaps: qualificationGaps }
      : { forced: false, gaps: [] },
    liveness: {
      active: active.length,
      expired: expired.length,
      uncertain: uncertain.length,
    },
    gates: gateSummary,
    expired: expired.map(item => ({ url: item.row.url, reason: item.verdict.reason })),
    skipped: skipped.map(item => ({
      url: item.row.url,
      company: item.row.company,
      title: item.row.title,
      code: item.code,
      reason: item.reason,
    })),
    triage_updates: dedupeTriageUpdates(triageUpdates),
    ...(failureLedger ? { failure_ledger: failureLedger } : {}),
    results,
    committed: results.filter(item => item.status === 'COMMITTED').length,
    failed: results.filter(item => item.status !== 'COMMITTED').length,
  });
}

function dedupeTriageUpdates(updates) {
  const byPath = new Map();
  for (const update of updates) byPath.set(update.path, update);
  return [...byPath.values()];
}

/**
 * Persist failures so a rerun can target them with --file instead of
 * re-walking the whole triage list.
 */
function writeFailureLedger(paths, failedRows) {
  if (!failedRows.length) return null;
  const path = join(paths.dataDir, `evaluate-failures-${isoNow().slice(0, 10)}.tsv`);
  try {
    writeScanResultsTsv(path, failedRows.map(item => ({
      url: item.url,
      company: item.company,
      title: item.title,
      location: '',
      raw_source: item.code || item.status,
    })));
    return { path, count: failedRows.length };
  } catch {
    return null;
  }
}
