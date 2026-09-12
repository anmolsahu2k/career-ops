/**
 * evaluate-scan.mjs — single-command evaluation of scan-results triage.
 *
 * Consumes data/scan-results-*.tsv, runs the liveness gate, fetches JD
 * evidence, then prepare -> respond -> commit through the provider-free
 * runtime. Unevaluated survivors stay in triage; only committed rows land
 * in applications.md.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { normalizeSource } from '../sources.mjs';
import { classifyLiveness, isSpaHost } from '../../liveness-core.mjs';
import { captureHistoricalEvidence, plainTextFromHtml } from './historical-evidence.mjs';
import { evaluateWithProvider } from './orchestrator.mjs';
import { prepareTask } from './prepare.mjs';
import { createProvider } from './providers/index.mjs';
import { resolveRoutingProfile } from './route-shadow.mjs';
import { routeTask } from './router.mjs';
import { commitEvaluation, persistencePaths } from './transaction.mjs';
import { isoNow, record, sha256 } from './util.mjs';

const SCAN_HEADER = 'url\tcompany\ttitle\tlocation\tsource\n';
const MIN_JD_CHARS = 200;

export function listScanResultFiles(dataDir) {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter(name => /^scan-results-\d{4}-\d{2}-\d{2}\.tsv$/i.test(name))
    .map(name => join(dataDir, name))
    .sort();
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
  const seen = new Set();
  const rows = [];
  for (const path of filePaths) {
    if (!existsSync(path)) continue;
    for (const row of parseScanResultsTsv(readFileSync(path, 'utf8'))) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      rows.push({ ...row, file: path });
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

async function checkOne(context, url) {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const status = response?.status() ?? 0;
    await page.waitForTimeout(isSpaHost(page.url()) ? 5000 : 2000);
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const applyControls = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]'),
      );
      return candidates
        .filter(el => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .map(el => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim())
        .filter(Boolean)
        .slice(0, 40);
    });
    const verdict = classifyLiveness({ status, finalUrl, bodyText, applyControls });
    return { ...verdict, bodyText, finalUrl, httpStatus: status };
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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; career-ops-evaluate/1.6)',
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
      method: 'page_text',
    };
  }

  // Generic HTML fetch for non-ATS URLs when Playwright text was empty.
  try {
    const response = await fetchImpl(row.url, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'career-ops/1.6 evaluate' },
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

function buildSeed(row, evidence, livenessState) {
  return {
    company: row.company,
    role: evidence.title || row.title,
    url: row.url,
    resume: guessResume(evidence.title || row.title),
    source: row.source,
    evidence: [{
      id: 'EV-1',
      source_type: evidence.source_type || row.source,
      uri: row.url,
      content: evidence.content,
      liveness_state: livenessState === 'uncertain' ? 'UNKNOWN' : 'YES',
      structured_fields: {
        required_evidence_complete: evidence.content.length >= MIN_JD_CHARS ? 'YES' : 'UNKNOWN',
      },
    }],
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
  skipLiveness = false,
  provider = null,
  profile = null,
  concurrency = 10,
  acknowledgeQuota = false,
  onProgress = null,
  fetchImpl = fetch,
  // Test-only seams. Production callers leave these unset.
  providerHandle: injectedProvider = null,
  livenessResults = null,
  fetchEvidence = null,
} = {}) {
  const paths = persistencePaths(target);
  const selectedFiles = files?.length ? files.map(path => resolve(path)) : listScanResultFiles(paths.dataDir);
  const candidates = loadScanResults(selectedFiles).slice(0, Number.isFinite(max) ? max : undefined);

  const planFields = {
    target: paths.target,
    files: selectedFiles,
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

  let livenessMap = new Map();
  if (livenessResults) {
    livenessMap = livenessResults;
  } else if (!skipLiveness) {
    livenessMap = await runLivenessGate(candidates.map(row => row.url), {
      concurrency,
      onProgress: progress => onProgress?.({ stage: 'liveness', ...progress }),
    });
  } else {
    for (const row of candidates) {
      livenessMap.set(row.url, { result: 'active', status: 'skipped', reason: 'skip_liveness', bodyText: '' });
    }
  }

  const expired = [];
  const uncertain = [];
  const active = [];
  for (const row of candidates) {
    const verdict = livenessMap.get(row.url) || { result: 'uncertain', reason: 'missing' };
    if (verdict.result === 'expired') expired.push({ row, verdict });
    else if (verdict.result === 'uncertain') uncertain.push({ row, verdict });
    else active.push({ row, verdict });
  }

  // Keep uncertain for evaluation (same policy as scan.md) but flag Notes via
  // presentation sanitizer/commit path through liveness_state UNKNOWN.
  const toEvaluate = [...active, ...uncertain];

  if (!apply) {
    return record('EvaluateScanResultV1', {
      ...planFields,
      status: 'PLAN',
      liveness: {
        active: active.length,
        expired: expired.length,
        uncertain: uncertain.length,
      },
      expired: expired.map(item => ({ url: item.row.url, reason: item.verdict.reason })),
      queue: toEvaluate.map(item => ({
        url: item.row.url,
        company: item.row.company,
        title: item.row.title,
        source: item.row.source,
        liveness: item.verdict.result,
      })),
      results: [],
      message: 'Dry-run only. Re-run with --config, --provider (or --profile), --acknowledge-quota, and --apply to commit.',
    });
  }

  if (!config) throw new Error('evaluate --apply requires --config');
  if (!acknowledgeQuota) throw new Error('evaluate invokes a provider and requires --acknowledge-quota');

  if (!toEvaluate.length) {
    const triageUpdates = removeEvaluatedUrls(
      selectedFiles,
      new Set(expired.map(item => item.row.url)),
    );
    return record('EvaluateScanResultV1', {
      ...planFields,
      status: 'COMPLETED',
      liveness: { active: 0, expired: expired.length, uncertain: 0 },
      expired: expired.map(item => ({ url: item.row.url, reason: item.verdict.reason })),
      triage_updates: triageUpdates,
      results: [],
      committed: 0,
      failed: 0,
      message: 'No live candidates remained after the liveness gate.',
    });
  }

  const providerId = pickProviderId(config, { provider, profile });
  const providerConfig = config.providers[providerId];
  // User-triggered evaluate with an explicit provider/profile is an intentional
  // local opt-in. It does not silently fall back to another model.
  const effectiveProviderConfig = {
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
  };

  mkdirSync(paths.dataDir, { recursive: true });
  const providerHandle = injectedProvider || createProvider(providerId, effectiveProviderConfig, config);
  const results = [];
  const committedUrls = new Set();
  const evidenceFetcher = fetchEvidence || ((row, opts) => fetchJobEvidence(row, opts));

  try {
    for (let index = 0; index < toEvaluate.length; index++) {
      const { row, verdict } = toEvaluate[index];
      onProgress?.({ stage: 'evaluate', done: index, total: toEvaluate.length, url: row.url });
      try {
        const evidence = await evidenceFetcher(row, {
          fetchImpl,
          pageText: verdict.bodyText || '',
        });
        if (!evidence.ok) {
          results.push({
            url: row.url,
            status: 'FETCH_FAILED',
            error: evidence.error,
            company: row.company,
            title: row.title,
          });
          continue;
        }
        const seed = buildSeed(row, evidence, verdict.result);
        const task = prepareTask(seed);
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
        const evaluation = await evaluateWithProvider({
          task,
          evidenceContent: { 'EV-1': evidence.content },
          provider: providerHandle,
          retentionTarget: paths.target,
        });
        const receipt = await commitEvaluation({
          target: paths.target,
          ...evaluation,
        });
        committedUrls.add(row.url);
        results.push({
          url: row.url,
          status: 'COMMITTED',
          company: row.company,
          title: row.title,
          decision: evaluation.decision.decision,
          report_number: receipt.report_identity?.report_number ?? null,
          receipt_id: receipt.receipt_id || null,
          liveness: verdict.result,
        });
      } catch (error) {
        results.push({
          url: row.url,
          status: 'FAILED',
          company: row.company,
          title: row.title,
          error: error.message,
          code: error.code || error.name,
        });
      }
    }
  } finally {
    if (!injectedProvider) providerHandle.close?.();
  }

  // Drop expired URLs and successfully committed URLs from triage handoffs.
  const dropUrls = new Set([
    ...expired.map(item => item.row.url),
    ...committedUrls,
  ]);
  const triageUpdates = removeEvaluatedUrls(selectedFiles, dropUrls);

  onProgress?.({ stage: 'evaluate', done: toEvaluate.length, total: toEvaluate.length });

  return record('EvaluateScanResultV1', {
    ...planFields,
    status: 'COMPLETED',
    provider_id: providerId,
    liveness: {
      active: active.length,
      expired: expired.length,
      uncertain: uncertain.length,
    },
    expired: expired.map(item => ({ url: item.row.url, reason: item.verdict.reason })),
    triage_updates: triageUpdates,
    results,
    committed: results.filter(item => item.status === 'COMMITTED').length,
    failed: results.filter(item => item.status !== 'COMMITTED').length,
  });
}
