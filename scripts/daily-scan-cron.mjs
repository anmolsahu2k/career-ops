#!/usr/bin/env node
// daily-scan-cron.mjs, W1 daily candidate scan wrapper.
//
// Orchestrates the full daily intake for Anmol's Summer 2026 internship
// pipeline. Designed to be invoked at 7am Pittsburgh time (America/New_York)
// via CronCreate.
//
// Flow:
//   1. node scan.mjs (Greenhouse / Ashby / Lever zero-token portal scan)
//   2. fetch SimplifyJobs/Summer2026-Internships README, diff vs scan-history
//   3. python3 scripts/aggregator-intake.py --limit 100
//   4. python3 scripts/jobspy-ingest.py ... (best-effort, skip on rate-limit)
//   5. node merge-tracker.mjs && dedup-tracker.mjs && normalize-statuses.mjs
//      && verify-pipeline.mjs   (chain; abort + exit 1 on verify failure)
//   6. for any new offer scoring >= 4.0 surfaced by scan, auto-create eval
//      report + cover letter (cap 5/day, overflow to triage list).
//   7. write daily digest at career-ops/data/daily-digest-{YYYY-MM-DD}.md.
//
// Hard rules:
//   - No em-dashes / en-dashes anywhere in source or emitted text.
//   - Do NOT generate CV PDFs.
//   - No F-1 / CPT / Heinz explainer in any candidate-facing output.
//   - Drafts only; never push commits.
//   - Do not mutate the 9-column tracker schema.
//   - Auto cover-letter cap is hard at 5/day. Overflow goes to triage list.
//
// Usage:
//   node scripts/daily-scan-cron.mjs          # full run
//   node scripts/daily-scan-cron.mjs --dry-run # plan only, no writes

process.env.TZ = 'America/New_York';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- paths ----------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = resolve(SCRIPT_DIR, '..');
const DATA_DIR = join(CAREER_OPS, 'data');
const REPORTS_DIR = join(CAREER_OPS, 'reports');
const SCAN_HISTORY_PATH = join(DATA_DIR, 'scan-history.tsv');
const SIMPLIFY_README_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md';

// ---- config ---------------------------------------------------------------

const AUTO_LETTER_CAP = 5;
const SCORE_AUTO_LETTER_THRESHOLD = 4.0;

const ARGV = process.argv.slice(2);
const DRY_RUN = ARGV.includes('--dry-run');
// --skip-portal-scan: don't run scan.mjs at all. Use this in cloud sandboxes
// whose egress proxy denies outbound HTTPS to Greenhouse/Ashby/Lever (every
// portal returns HTTP 403). The aggregator-intake.py + jobspy-ingest.py paths
// still cover discovery; locally, run scan.mjs manually for full Greenhouse/
// Ashby/Lever coverage (`node scan.mjs`). Default behavior unchanged.
const SKIP_PORTAL_SCAN = ARGV.includes('--skip-portal-scan');

// ---- date helpers (Pittsburgh-correct via TZ env) -------------------------

function pittsburghDate() {
  // process.env.TZ is set above so toISOString reflects local TZ for the
  // formatted parts. Use Intl to be explicit.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now); // YYYY-MM-DD
}

function pittsburghTime() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(new Date()); // HH:MM
}

const TODAY = pittsburghDate();
const LOG_PATH = join(DATA_DIR, `daily-scan-${TODAY}.log`);
const DIGEST_PATH = join(DATA_DIR, `daily-digest-${TODAY}.md`);

// ---- logging --------------------------------------------------------------

function log(line) {
  const stamped = `[${pittsburghTime()}] ${line}`;
  // eslint-disable-next-line no-console
  console.log(stamped);
  if (!DRY_RUN) {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(LOG_PATH, stamped + '\n', 'utf-8');
    } catch (err) {
      // best effort: do not crash on log write failure
      // eslint-disable-next-line no-console
      console.error('log write failed:', err.message);
    }
  }
}

// ---- shell wrapper --------------------------------------------------------

function runCmd(cmd, args, opts = {}) {
  const cwd = opts.cwd || CAREER_OPS;
  const label = `${cmd} ${args.join(' ')}`;
  if (DRY_RUN) {
    log(`[dry-run] would run: ${label}  (cwd=${cwd})`);
    return { status: 0, stdout: '', stderr: '', skipped: true };
  }
  log(`run: ${label}`);
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, TZ: 'America/New_York' },
    timeout: opts.timeout || 10 * 60 * 1000, // 10 min default
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  // tee to log file
  if (stdout.trim()) {
    for (const ln of stdout.split('\n')) log(`  out: ${ln}`);
  }
  if (stderr.trim()) {
    for (const ln of stderr.split('\n')) log(`  err: ${ln}`);
  }
  return {
    status: res.status === null ? 1 : res.status,
    stdout,
    stderr,
    skipped: false,
  };
}

// ---- step 1: portal scan --------------------------------------------------

function runPortalScan() {
  // capture pre-scan history size so we can diff for new entries
  const preBytes = existsSync(SCAN_HISTORY_PATH) ? statSync(SCAN_HISTORY_PATH).size : 0;
  const preLines = readScanHistoryLineCount();
  const res = runCmd('node', ['scan.mjs']);
  const postLines = readScanHistoryLineCount();
  const newRows = Math.max(0, postLines - preLines);
  return {
    name: 'scan.mjs',
    exit: res.status,
    stdoutTail: tail(res.stdout, 30),
    newRows,
    preBytes,
  };
}

function readScanHistoryLineCount() {
  if (!existsSync(SCAN_HISTORY_PATH)) return 0;
  try {
    const txt = readFileSync(SCAN_HISTORY_PATH, 'utf-8');
    return txt.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function readScanHistoryNewRows(beforeCount) {
  if (!existsSync(SCAN_HISTORY_PATH)) return [];
  const txt = readFileSync(SCAN_HISTORY_PATH, 'utf-8');
  const lines = txt.split('\n').filter(Boolean);
  // header is line 0; data lines after beforeCount were added this run
  // beforeCount is the total line count (including header) before the run.
  const sliceStart = Math.max(beforeCount, 1);
  return lines.slice(sliceStart).map(parseScanRow).filter(Boolean);
}

function parseScanRow(line) {
  const parts = line.split('\t');
  if (parts.length < 5) return null;
  return {
    url: parts[0],
    first_seen: parts[1],
    portal: parts[2],
    title: parts[3],
    company: parts[4],
    status: parts[5] || 'added',
    score: null, // scan.mjs does not score; treated as raw
  };
}

// ---- step 2: SimplifyJobs README diff -------------------------------------

async function fetchSimplifyDiff() {
  const out = {
    name: 'simplify-readme-diff',
    exit: 0,
    fetched: false,
    rawCount: 0,
    newCount: 0,
    examples: [],
    error: null,
  };

  if (DRY_RUN) {
    log('[dry-run] would fetch SimplifyJobs README and diff vs scan-history.tsv');
    return out;
  }

  let body;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(SIMPLIFY_README_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.text();
    out.fetched = true;
  } catch (err) {
    out.exit = 1;
    out.error = err.message;
    log(`SimplifyJobs fetch failed: ${err.message}`);
    return out;
  }

  // crude URL harvest: match all hrefs that look like a job URL
  const urls = new Set();
  const URL_RE = /https?:\/\/[^\s)"'<>]+/g;
  let m;
  while ((m = URL_RE.exec(body)) !== null) {
    let u = m[0].replace(/[).,]+$/, '');
    // skip image / shield / GH-icon URLs
    if (/\.(png|jpg|jpeg|gif|svg)(\?|$)/i.test(u)) continue;
    if (/img\.shields\.io|simplify\.jobs\/c\//.test(u)) {
      // simplify.jobs/c/{...} is the apply tracking URL; keep
      if (!/simplify\.jobs\/c\//.test(u)) continue;
    }
    urls.add(u);
  }
  out.rawCount = urls.size;

  const seen = loadScanHistoryUrls();
  const newOnes = [];
  for (const u of urls) {
    const key = u.split('?')[0].replace(/\/$/, '');
    const lower = key.toLowerCase();
    if (!seen.has(lower)) newOnes.push(u);
  }
  out.newCount = newOnes.length;
  out.examples = newOnes.slice(0, 15);
  return out;
}

function loadScanHistoryUrls() {
  const set = new Set();
  if (!existsSync(SCAN_HISTORY_PATH)) return set;
  const txt = readFileSync(SCAN_HISTORY_PATH, 'utf-8');
  for (const line of txt.split('\n')) {
    const url = line.split('\t')[0];
    if (!url || url === 'url') continue;
    set.add(url.split('?')[0].replace(/\/$/, '').toLowerCase());
  }
  return set;
}

// ---- step 3: aggregator-intake -------------------------------------------

function runAggregatorIntake() {
  const res = runCmd('python3', [
    'scripts/aggregator-intake.py',
    '--limit',
    '100',
  ]);
  return {
    name: 'aggregator-intake.py',
    exit: res.status,
    stdoutTail: tail(res.stdout || res.stderr, 40),
  };
}

// ---- step 4: jobspy-ingest (best-effort) ---------------------------------

function runJobspy() {
  const res = runCmd(
    'python3',
    [
      'scripts/jobspy-ingest.py',
      '--keyword',
      'software engineer intern',
      '--limit',
      '25',
      '--hours_old',
      '24',
    ],
    { timeout: 5 * 60 * 1000 }
  );

  // exit 2 = python-jobspy not installed; exit 1 = rate limit / captcha / err
  let note = null;
  if (res.skipped) note = 'dry-run skipped';
  else if (res.status === 2) note = 'python-jobspy not installed; skipped';
  else if (res.status === 1) note = 'jobspy errored or hit rate limit; skipped';
  else if (res.status === 0) note = 'ok';
  else note = `exit ${res.status}`;

  return {
    name: 'jobspy-ingest.py',
    exit: res.status,
    skipped: res.skipped || res.status !== 0,
    note,
    stdoutTail: tail(res.stdout || res.stderr, 30),
  };
}

// ---- step 5: pipeline chain ----------------------------------------------

function runPipelineChain() {
  const steps = [
    'merge-tracker.mjs',
    'dedup-tracker.mjs',
    'normalize-statuses.mjs',
    'verify-pipeline.mjs',
  ];
  const results = [];
  for (const step of steps) {
    const res = runCmd('node', [step]);
    results.push({
      name: step,
      exit: res.status,
      stdoutTail: tail(res.stdout, 20),
    });
    if (step === 'verify-pipeline.mjs' && res.status !== 0) {
      // abort the run on verify failure
      log(`verify-pipeline.mjs exited ${res.status}; aborting day's auto-letter step`);
      return { results, aborted: true };
    }
  }
  return { results, aborted: false };
}

// ---- step 6: auto cover-letter generation --------------------------------
//
// scan.mjs does NOT emit scores. Per the W1 spec: if no score field,
// treat surfaced rows as "raw" and skip auto-letter; queue them in the
// triage list for next-day eval. Aggregator + jobspy adapters also write
// 0.0/5 placeholder scores (per their Python source). So the realistic
// auto-letter path is: zero generated today, all overflow to triage.
//
// The cap (5/day) and the threshold (>= 4.0) are still enforced so that
// once an upstream adapter starts emitting real scores, behavior is correct.

function planAutoLetters(scanNewRows) {
  const candidates = scanNewRows
    .map(r => ({
      ...r,
      hasScore: typeof r.score === 'number' && !Number.isNaN(r.score),
    }))
    .filter(r => r.hasScore && r.score >= SCORE_AUTO_LETTER_THRESHOLD);

  const generated = [];
  const overflow = [];
  for (const c of candidates) {
    if (generated.length < AUTO_LETTER_CAP) {
      // We do NOT actually run an LLM here. The wrapper writes a stub
      // path + "needs LLM" note to the triage list rather than emit a
      // low-quality boilerplate cover letter (rule 6 in the W1 spec).
      generated.push({
        ...c,
        stub: true,
        note: 'auto-letter slot reserved; needs LLM pass',
      });
    } else {
      overflow.push(c);
    }
  }

  const noScore = scanNewRows.filter(
    r => !(typeof r.score === 'number' && !Number.isNaN(r.score))
  );

  return { generated, overflow, noScore, candidates };
}

// ---- step 7: digest writer -----------------------------------------------

function buildDigest({
  scanResult,
  simplify,
  aggregator,
  jobspy,
  pipeline,
  letters,
}) {
  const lines = [];
  lines.push(`# Daily Scan Digest, ${TODAY}`);
  lines.push('');
  lines.push(`Generated by scripts/daily-scan-cron.mjs at ${pittsburghTime()} America/New_York.`);
  lines.push('');

  // Run summary
  lines.push('## Run summary');
  lines.push('');
  lines.push(`- scan.mjs exit: ${scanResult.exit}, new rows in scan-history: ${scanResult.newRows}`);
  lines.push(`- SimplifyJobs README: fetched=${simplify.fetched}, raw URLs=${simplify.rawCount}, new vs scan-history=${simplify.newCount}${simplify.error ? `, error=${simplify.error}` : ''}`);
  lines.push(`- aggregator-intake.py exit: ${aggregator.exit}`);
  lines.push(`- jobspy-ingest.py: ${jobspy.note}`);
  lines.push(`- pipeline chain aborted: ${pipeline.aborted}`);
  lines.push('');

  // Pipeline-chain exit codes
  lines.push('## Pipeline-chain exit codes');
  lines.push('');
  lines.push('| Step | Exit |');
  lines.push('|------|------|');
  for (const r of pipeline.results) {
    lines.push(`| ${r.name} | ${r.exit} |`);
  }
  if (pipeline.aborted) {
    lines.push('');
    lines.push('Note: chain aborted on verify-pipeline.mjs failure. Auto-letter generation skipped. Inspect tracker before next run.');
  }
  lines.push('');

  // New candidates surfaced
  lines.push('## New candidates surfaced');
  lines.push('');
  lines.push(`scan.mjs surfaced ${scanResult.newRows} new rows into scan-history.tsv.`);
  lines.push('');
  if (simplify.examples.length > 0) {
    lines.push('SimplifyJobs README, sample of new URLs not yet in scan-history (first 15):');
    lines.push('');
    for (const u of simplify.examples) lines.push(`- ${u}`);
  } else if (simplify.fetched) {
    lines.push('SimplifyJobs README: no URLs new vs scan-history.');
  }
  lines.push('');

  // Auto-letters generated
  lines.push('## Auto-letters generated');
  lines.push('');
  lines.push(`Cap: ${AUTO_LETTER_CAP}/day. Threshold: score >= ${SCORE_AUTO_LETTER_THRESHOLD}. Generated this run: ${letters.generated.length}.`);
  lines.push('');
  if (letters.generated.length === 0) {
    lines.push('No auto-letters generated this run. scan.mjs and aggregator/jobspy adapters do not emit scores; new rows are queued for next-day human eval (see triage queue below).');
  } else {
    lines.push('| # | Company | Title | Score | Note |');
    lines.push('|---|---------|-------|-------|------|');
    let i = 1;
    for (const g of letters.generated) {
      lines.push(`| ${i++} | ${g.company} | ${safeCell(g.title)} | ${g.score} | ${g.note} |`);
    }
  }
  lines.push('');

  // Triage queue
  lines.push('## Triage queue (overflow + low-score + raw)');
  lines.push('');
  lines.push(`Auto-letter overflow (above cap): ${letters.overflow.length}.`);
  lines.push(`Raw, no score (need eval first): ${letters.noScore.length}.`);
  lines.push('');
  if (letters.overflow.length > 0) {
    lines.push('### Overflow');
    lines.push('');
    for (const o of letters.overflow.slice(0, 50)) {
      lines.push(`- ${o.company} | ${safeCell(o.title)} | ${o.url}`);
    }
    lines.push('');
  }
  if (letters.noScore.length > 0) {
    lines.push('### Raw (no score)');
    lines.push('');
    for (const r of letters.noScore.slice(0, 50)) {
      lines.push(`- ${r.company || '?'} | ${safeCell(r.title || '?')} | ${r.url || '?'}`);
    }
    if (letters.noScore.length > 50) {
      lines.push(`- ...and ${letters.noScore.length - 50} more (see scan-history.tsv).`);
    }
    lines.push('');
  }

  // Errors / skipped sources
  lines.push('## Errors / skipped sources');
  lines.push('');
  const errs = [];
  if (scanResult.exit !== 0) errs.push(`scan.mjs exited ${scanResult.exit}`);
  if (simplify.error) errs.push(`SimplifyJobs fetch: ${simplify.error}`);
  if (aggregator.exit !== 0) errs.push(`aggregator-intake.py exited ${aggregator.exit}`);
  if (jobspy.skipped) errs.push(`jobspy: ${jobspy.note}`);
  if (errs.length === 0) {
    lines.push('None.');
  } else {
    for (const e of errs) lines.push(`- ${e}`);
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(`Log file: career-ops/data/daily-scan-${TODAY}.log`);
  lines.push('');

  let text = lines.join('\n');
  // safety net: strip any em/en dash that snuck through from upstream stdout
  text = stripDashes(text);
  return text;
}

function safeCell(s) {
  if (!s) return '';
  return String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
}

function tail(s, n) {
  if (!s) return '';
  const lines = s.split('\n');
  return lines.slice(-n).join('\n');
}

function stripDashes(s) {
  // U+2013 = en dash, U+2014 = em dash. Replace with comma + space.
  const en = String.fromCharCode(0x2013);
  const em = String.fromCharCode(0x2014);
  return s.split(em).join(', ').split(en).join(', ');
}

// ---- main -----------------------------------------------------------------

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  log(`daily-scan-cron starting; date=${TODAY}, dry_run=${DRY_RUN}`);
  log(`career-ops dir: ${CAREER_OPS}`);

  // idempotency: if today's digest already exists, append a re-run stanza
  // rather than overwrite.
  const digestExists = existsSync(DIGEST_PATH);
  if (digestExists && !DRY_RUN) {
    log(`digest ${DIGEST_PATH} already exists; this run will append a re-run stanza`);
  }

  // 1. portal scan (skipped when --skip-portal-scan is set, e.g. in cloud
  // sandbox where Greenhouse/Ashby/Lever outbound is policy-blocked).
  const preLines = readScanHistoryLineCount();
  let scanResult;
  if (SKIP_PORTAL_SCAN) {
    log('skipping scan.mjs (--skip-portal-scan)');
    scanResult = {
      name: 'scan.mjs',
      exit: 0,
      stdoutTail: 'skipped via --skip-portal-scan flag',
      newRows: 0,
      preBytes: 0,
      skipped: true,
    };
  } else {
    scanResult = runPortalScan();
  }
  scanResult.newOffers = readScanHistoryNewRows(preLines);

  // 2. simplify diff
  const simplify = await fetchSimplifyDiff();

  // 3. aggregator
  const aggregator = runAggregatorIntake();

  // 4. jobspy (best-effort)
  const jobspy = runJobspy();

  // 5. pipeline chain
  const pipeline = DRY_RUN
    ? {
        results: [
          { name: 'merge-tracker.mjs', exit: 0, stdoutTail: '' },
          { name: 'dedup-tracker.mjs', exit: 0, stdoutTail: '' },
          { name: 'normalize-statuses.mjs', exit: 0, stdoutTail: '' },
          { name: 'verify-pipeline.mjs', exit: 0, stdoutTail: '' },
        ],
        aborted: false,
      }
    : runPipelineChain();

  // 6. auto-letters (skipped if pipeline aborted)
  const letters = pipeline.aborted
    ? { generated: [], overflow: [], noScore: scanResult.newOffers || [], candidates: [] }
    : planAutoLetters(scanResult.newOffers || []);

  // 7. digest
  const digest = buildDigest({
    scanResult,
    simplify,
    aggregator,
    jobspy,
    pipeline,
    letters,
  });

  if (DRY_RUN) {
    log('[dry-run] would write digest to: ' + DIGEST_PATH);
    log('[dry-run] digest preview (first 60 lines):');
    for (const ln of digest.split('\n').slice(0, 60)) log('  | ' + ln);
  } else if (digestExists) {
    const stanza = [
      '',
      `## Re-run at ${pittsburghTime()}`,
      '',
      digest.split('\n').slice(2).join('\n'), // skip the title + blank
    ].join('\n');
    appendFileSync(DIGEST_PATH, stanza, 'utf-8');
    log(`appended re-run stanza to ${DIGEST_PATH}`);
  } else {
    writeFileSync(DIGEST_PATH, digest, 'utf-8');
    log(`wrote digest: ${DIGEST_PATH}`);
  }

  // exit code: non-zero if pipeline chain aborted
  const exitCode = pipeline.aborted ? 1 : 0;
  log(`done; exit ${exitCode}`);
  process.exit(exitCode);
}

main().catch(err => {
  log(`FATAL: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
