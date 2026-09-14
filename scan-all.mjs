#!/usr/bin/env node

/**
 * scan-all.mjs — Run every active discovery source in scan order.
 *
 * Zero LLM tokens. Orchestrates the same entrypoints modes/scan.md lists for a
 * full `/career-ops scan` discovery pass. Does not evaluate, merge, or apply.
 *
 * Usage:
 *   node scan-all.mjs
 *   node scan-all.mjs --dry-run
 *   node scan-all.mjs --skip adzuna,hiringcafe
 *   node scan-all.mjs --only scan,spa,freehire
 *   npm run scan:all
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './lib/paths.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = resolvePaths(import.meta.url);
const IS_TTY = Boolean(process.stdout.isTTY);
const BAR_WIDTH = 24;
const HEARTBEAT_MS = 5000;

/** Map scan-results `source` tokens onto scan-all step ids for rollups. */
function familyForSourceToken(token) {
  const source = String(token || '').split('|')[0].trim().toLowerCase();
  if (!source) return 'unknown';
  if (/^(greenhouse|ashby|lever|workday)-api$/.test(source) || source.startsWith('external-')) return 'scan';
  if (source.startsWith('playwright-') || source === 'spa') return 'spa';
  if (source === 'freehire' || source.startsWith('freehire-')) return 'freehire';
  if (/^(speedyapply|simplifyjobs|vanshb03|jobright)/.test(source) || source.includes('aggregator')) return 'aggregator';
  if (source.startsWith('jobspy-') || source === 'jobspy'
    || ['linkedin', 'indeed', 'ziprecruiter', 'glassdoor', 'google', 'google_jobs'].includes(source)) {
    return 'jobspy';
  }
  if (source === 'adzuna' || source.startsWith('adzuna-')) return 'adzuna';
  if (source === 'hiringcafe' || source.startsWith('hiringcafe-')) return 'hiringcafe';
  if (source === 'hn-hiring' || source === 'hnhiring' || source.startsWith('hn-')) return 'hn';
  if (source === 'linkedin-guest') return 'linkedin';
  return source;
}

function emptyStats() {
  return {
    files: [],
    total: 0,
    valid: 0,
    malformed: 0,
    bySource: new Map(),
    byFamily: new Map(),
  };
}

function readScanStats(dataDir) {
  const stats = emptyStats();
  if (!existsSync(dataDir)) return stats;

  const files = readdirSync(dataDir)
    .filter(name => /^scan-results-\d{4}-\d{2}-\d{2}\.tsv$/.test(name))
    .sort()
    .map(name => join(dataDir, name));

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).filter(line => line.length > 0);
    if (!lines.length) continue;
    const headerCols = lines[0].split('\t').length;
    let fileValid = 0;
    let fileMalformed = 0;
    for (const line of lines.slice(1)) {
      stats.total += 1;
      const parts = line.split('\t');
      const url = parts[0] || '';
      const sourceToken = (parts[4] || '').trim();
      const okShape = parts.length >= Math.min(5, headerCols) && /^https?:\/\//i.test(url);
      if (!okShape) {
        fileMalformed += 1;
        stats.malformed += 1;
        continue;
      }
      fileValid += 1;
      stats.valid += 1;
      const rawSource = sourceToken.split('|')[0] || 'unknown';
      stats.bySource.set(rawSource, (stats.bySource.get(rawSource) || 0) + 1);
      const family = familyForSourceToken(rawSource);
      stats.byFamily.set(family, (stats.byFamily.get(family) || 0) + 1);
    }
    let bytes = 0;
    try { bytes = statSync(file).size; } catch { /* ignore */ }
    stats.files.push({
      path: file,
      name: basename(file),
      valid: fileValid,
      malformed: fileMalformed,
      bytes,
    });
  }
  return stats;
}

function mapDelta(after, before) {
  const delta = new Map();
  for (const [key, value] of after.entries()) {
    const change = value - (before.get(key) || 0);
    if (change) delta.set(key, change);
  }
  for (const [key, value] of before.entries()) {
    if (!after.has(key) && value) delta.set(key, -value);
  }
  return delta;
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function printCountTable(title, entries, { signed = false } = {}) {
  console.log('');
  console.log(title);
  if (!entries.length) {
    console.log('  (none)');
    return;
  }
  const width = Math.max(12, ...entries.map(([key]) => String(key).length));
  let sum = 0;
  for (const [key, value] of entries) {
    sum += value;
    const prefix = signed && value > 0 ? '+' : '';
    console.log(`  ${String(key).padEnd(width)}  ${prefix}${value}`);
  }
  console.log(`  ${'total'.padEnd(width)}  ${sum}`);
}

function printHandoffStats({ before, after, stepDeltas, dryRun }) {
  const added = after.valid - before.valid;
  const malformedDelta = after.malformed - before.malformed;

  console.log('');
  console.log('Candidate handoff stats');
  console.log(`  Triage rows now:     ${after.valid}`);
  console.log(`  Added this run:      ${added >= 0 ? '+' : ''}${added}`);
  console.log(`  Malformed rows:      ${after.malformed}${malformedDelta ? ` (${malformedDelta >= 0 ? '+' : ''}${malformedDelta} this run)` : ''}`);
  if (after.files.length) {
    for (const file of after.files) {
      console.log(`  File:                ${file.name}  (${file.valid} rows${file.malformed ? `, ${file.malformed} bad` : ''})`);
      console.log(`                       ${file.path}`);
    }
  } else if (!dryRun) {
    console.log('  File:                (no scan-results-*.tsv present)');
  }

  printCountTable(
    'Added by scan-all step',
    sortedEntries(stepDeltas).filter(([, n]) => n),
    { signed: true },
  );
  printCountTable(
    'Added by source token',
    sortedEntries(mapDelta(after.bySource, before.bySource)).filter(([, n]) => n),
    { signed: true },
  );
  printCountTable('Current backlog by source family', sortedEntries(after.byFamily));
  printCountTable('Current backlog by source token', sortedEntries(after.bySource));
}

const SOURCES = [
  {
    id: 'scan',
    label: 'ATS APIs (Greenhouse / Ashby / Lever / Workday)',
    kind: 'node',
    script: 'scan.mjs',
    required: true,
    expect: 'API boards → new rows in scan-results TSV',
  },
  {
    id: 'spa',
    label: 'SPA / Playwright boards',
    kind: 'node',
    script: 'scan-spa.mjs',
    required: true,
    expect: 'Browser boards → append scan-results TSV',
  },
  {
    id: 'freehire',
    label: 'freehire.me',
    kind: 'node',
    script: 'scan-freehire.mjs',
    required: true,
    expect: 'Public ATS aggregate → append scan-results TSV',
  },
  {
    id: 'aggregator',
    label: 'GitHub aggregators',
    kind: 'python',
    script: join('scripts', 'aggregator-intake.py'),
    required: true,
    expect: 'New-grad repos → append scan-results TSV (can take a few minutes)',
  },
  {
    id: 'jobspy',
    label: 'JobSpy (Indeed / LinkedIn / ZipRecruiter / Google)',
    kind: 'python',
    script: join('scripts', 'jobspy-ingest.py'),
    required: true,
    expect: 'JobSpy scrape → append scan-results TSV',
  },
  {
    id: 'adzuna',
    label: 'Adzuna',
    kind: 'python',
    script: join('scripts', 'adzuna-ingest.py'),
    required: false,
    skipExitCodes: [2],
    skipHint: 'needs ADZUNA_APP_ID and ADZUNA_APP_KEY',
    expect: 'Adzuna API → append scan-results TSV (optional)',
  },
  {
    id: 'hiringcafe',
    label: 'Hiring Cafe',
    kind: 'python',
    script: join('scripts', 'hiringcafe-ingest.py'),
    required: false,
    skipExitCodes: [2],
    skipHint: 'needs FlareSolverr on localhost:8191 (or headed fallback)',
    expect: 'Hiring Cafe → append scan-results TSV (optional)',
  },
  {
    id: 'hn',
    label: 'HN Who Is Hiring',
    kind: 'python',
    script: join('scripts', 'hn-hiring-ingest.py'),
    required: true,
    expect: 'Monthly HN thread → append scan-results TSV',
  },
];

const STATUS = {
  pending: 'pending',
  running: 'running',
  ok: 'ok',
  skipped: 'skipped',
  failed: 'failed',
};

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') flags.add('dry-run');
    else if (arg === '--help' || arg === '-h') flags.add('help');
    else if (arg === '--only' || arg === '--skip') {
      values[arg.slice(2)] = String(argv[++i] || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { flags, values };
}

function resolvePython() {
  for (const cmd of process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python']) {
    const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return cmd === 'py' ? ['py', '-3'] : [cmd];
  }
  return null;
}

function printHelp() {
  const ids = SOURCES.map(s => s.id).join(', ');
  console.log(`Usage: node scan-all.mjs [--dry-run] [--only id,id] [--skip id,id]

Runs every active discovery source with zero LLM tokens.
Does not evaluate roles or merge the tracker.

Source ids: ${ids}

Examples:
  npm run scan:all
  npm run scan:all -- --dry-run
  npm run scan:all -- --skip adzuna,hiringcafe
  npm run scan:all -- --only scan,spa,freehire`);
}

function selectSources({ flags, values }) {
  let selected = SOURCES;
  if (values.only?.length) {
    const wanted = new Set(values.only);
    const unknown = [...wanted].filter(id => !SOURCES.some(s => s.id === id));
    if (unknown.length) throw new Error(`Unknown --only id(s): ${unknown.join(', ')}`);
    selected = SOURCES.filter(s => wanted.has(s.id));
  }
  if (values.skip?.length) {
    const skip = new Set(values.skip);
    const unknown = [...skip].filter(id => !SOURCES.some(s => s.id === id));
    if (unknown.length) throw new Error(`Unknown --skip id(s): ${unknown.join(', ')}`);
    selected = selected.filter(s => !skip.has(s.id));
  }
  if (!selected.length) throw new Error('No sources selected');
  return selected;
}

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${String(sec).padStart(2, '0')}s`;
}

function progressBar(done, total, width = BAR_WIDTH) {
  const safeTotal = Math.max(total, 1);
  const filled = Math.min(width, Math.round((done / safeTotal) * width));
  const empty = width - filled;
  const pct = Math.min(100, Math.round((done / safeTotal) * 100));
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%`;
}

function statusGlyph(status) {
  switch (status) {
    case STATUS.ok: return '✓';
    case STATUS.failed: return '✗';
    case STATUS.skipped: return '○';
    case STATUS.running: return '…';
    default: return '·';
  }
}

function renderBoard(rows, { currentIndex = -1, elapsedMs = 0, title = 'Discovery progress' } = {}) {
  const total = rows.length;
  const finished = rows.filter(r => r.status !== STATUS.pending && r.status !== STATUS.running).length;
  const lines = [
    '',
    title,
    `${progressBar(finished, total)}  ${finished}/${total} sources`,
  ];
  if (currentIndex >= 0 && rows[currentIndex]?.status === STATUS.running) {
    lines.push(`Currently: ${rows[currentIndex].source.id} · elapsed ${fmtDuration(elapsedMs)}`);
  }
  lines.push('');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const mark = statusGlyph(row.status);
    const step = String(i + 1).padStart(2, ' ');
    const id = row.source.id.padEnd(11);
    const state = row.status.padEnd(8);
    const timing = row.ms != null ? fmtDuration(row.ms).padStart(7) : ''.padStart(7);
    const added = row.added != null && row.status !== STATUS.pending && row.status !== STATUS.running
      ? `  +${row.added}`.padStart(8)
      : ''.padStart(8);
    const detail = row.detail ? `  ${row.detail}` : '';
    const arrow = i === currentIndex && row.status === STATUS.running ? ' ←' : '';
    lines.push(`  ${mark} ${step}/${total}  ${id}  ${state}  ${timing}${added}${detail}${arrow}`);
  }
  return lines.join('\n');
}

function printBanner({ selected, dryRun }) {
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────┐');
  console.log('│  career-ops discovery                                    │');
  console.log('│  scan:all — find new jobs (no evaluation, no submit)     │');
  console.log('└──────────────────────────────────────────────────────────┘');
  console.log(`Sources (${selected.length}): ${selected.map(s => s.id).join(' → ')}`);
  if (dryRun) console.log('Mode: dry-run (preview only, no writes)');
  console.log('Tip: long quiet stretches usually mean a source is still working.');
}

function printStepIntro(index, total, source) {
  console.log('');
  console.log('─'.repeat(60));
  console.log(`Step ${index + 1}/${total}  ${progressBar(index, total)}`);
  console.log(`[${source.id}] ${source.label}`);
  console.log(`Expect: ${source.expect}`);
  console.log('Status: RUNNING — child output follows');
  console.log('─'.repeat(60));
}

function printStepDone(index, total, outcome) {
  const label = outcome.status.toUpperCase();
  const timing = outcome.ms != null ? ` in ${fmtDuration(outcome.ms)}` : '';
  const detail = outcome.detail ? ` (${outcome.detail})` : '';
  console.log('');
  console.log(`Step ${index + 1}/${total} finished: ${label}${timing}${detail}`);
  console.log(`${progressBar(index + 1, total)}  ${index + 1}/${total} sources complete`);
}

function runSource(source, { dryRun, pythonCmd }) {
  const scriptPath = join(ROOT, source.script);
  if (!existsSync(scriptPath)) {
    return Promise.resolve({ status: STATUS.failed, code: 127, detail: `missing ${source.script}` });
  }

  let command;
  let args;
  if (source.kind === 'node') {
    command = process.execPath;
    args = [scriptPath];
  } else {
    if (!pythonCmd) {
      return Promise.resolve({ status: STATUS.failed, code: 127, detail: 'python not found on PATH' });
    }
    command = pythonCmd[0];
    args = [...pythonCmd.slice(1), scriptPath];
  }
  if (dryRun) args.push('--dry-run');

  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });

    let heartbeat;
    if (IS_TTY) {
      heartbeat = setInterval(() => {
        const elapsed = fmtDuration(Date.now() - started);
        process.stderr.write(`\n⏱  still running [${source.id}] · ${elapsed} · not stuck, waiting on this source\n`);
      }, HEARTBEAT_MS);
    }

    const finish = (status, code, detail) => {
      if (heartbeat) clearInterval(heartbeat);
      resolve({ status, code, detail, ms: Date.now() - started });
    };

    child.on('error', error => finish(STATUS.failed, 1, error.message));
    child.on('close', code => {
      const exitCode = code ?? 1;
      if (exitCode === 0) {
        finish(STATUS.ok, 0);
        return;
      }
      if (!source.required && (source.skipExitCodes || []).includes(exitCode)) {
        finish(STATUS.skipped, exitCode, source.skipHint || `exit ${exitCode}`);
        return;
      }
      finish(STATUS.failed, exitCode, `exit ${exitCode}`);
    });
  });
}

function printFinalSummary(rows, { dryRun, beforeStats, afterStats, stepDeltas }) {
  const ok = rows.filter(r => r.status === STATUS.ok);
  const skipped = rows.filter(r => r.status === STATUS.skipped);
  const failed = rows.filter(r => r.status === STATUS.failed);
  const totalMs = rows.reduce((sum, r) => sum + (r.ms || 0), 0);

  console.log('');
  console.log('═'.repeat(60));
  console.log('Discovery complete');
  console.log('═'.repeat(60));
  console.log(renderBoard(rows, { title: 'Final status' }));
  console.log('');
  console.log(`Result: ${ok.length} ok · ${skipped.length} skipped · ${failed.length} failed · total ${fmtDuration(totalMs)}`);

  if (failed.length) {
    console.log('');
    console.log('Failed sources:');
    for (const row of failed) {
      console.log(`  ✗ ${row.source.id}: ${row.detail || `exit ${row.code}`}`);
    }
  }

  printHandoffStats({
    before: beforeStats,
    after: afterStats,
    stepDeltas,
    dryRun,
  });

  if (!dryRun) {
    console.log('');
    console.log('What this did');
    console.log('  • Wrote / appended candidate rows under ft/data/scan-results-*.tsv');
    console.log('  • Updated ft/data/scan-history.tsv for seen URLs');
    console.log('  • Did NOT score roles, merge the tracker, or submit applications');
    console.log('');
    console.log('What to do next');
    console.log('  1. Liveness gate over survivor URLs (drop expired)');
    console.log('     npm run liveness:bulk -- <urls.txt> <liveness.tsv>');
    console.log('  2. Evaluate survivors (provider call; writes reports + tracker additions)');
    console.log('     npm run evaluate -- --config config/runtime.local.yml --provider <id> --acknowledge-quota --apply');
    console.log('  3. Or resume the skill workflow: /career-ops scan  (picks up leftover TSV)');
  } else {
    console.log('');
    console.log('Dry-run only. Re-run without --dry-run to write scan handoff files.');
  }
  console.log('');
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    printHelp();
    return;
  }

  const dryRun = flags.has('dry-run');
  const selected = selectSources({ flags, values });
  const needsPython = selected.some(s => s.kind === 'python');
  const pythonCmd = needsPython ? resolvePython() : null;

  if (needsPython && !pythonCmd) {
    console.error('error: python is required for ingest scripts but was not found on PATH');
    process.exitCode = 1;
    return;
  }

  printBanner({ selected, dryRun });

  const beforeStats = readScanStats(PATHS.dataDir);
  if (beforeStats.valid || beforeStats.malformed) {
    console.log('');
    console.log(`Existing triage before run: ${beforeStats.valid} rows`
      + (beforeStats.malformed ? ` (${beforeStats.malformed} malformed)` : ''));
  }

  const rows = selected.map(source => ({
    source,
    status: STATUS.pending,
    code: null,
    detail: null,
    ms: null,
    added: 0,
  }));

  console.log(renderBoard(rows, { title: 'Plan' }));

  let previousStats = beforeStats;
  const stepDeltas = new Map();

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    row.status = STATUS.running;
    printStepIntro(index, rows.length, row.source);

    const outcome = await runSource(row.source, { dryRun, pythonCmd });

    const afterStep = readScanStats(PATHS.dataDir);
    const added = afterStep.valid - previousStats.valid;
    row.status = outcome.status;
    row.code = outcome.code;
    row.detail = outcome.detail || null;
    row.ms = outcome.ms ?? null;
    row.added = added;
    stepDeltas.set(row.source.id, (stepDeltas.get(row.source.id) || 0) + added);
    previousStats = afterStep;

    printStepDone(index, rows.length, outcome);
    console.log(`Candidates added by this step: ${added >= 0 ? '+' : ''}${added}  (backlog now ${afterStep.valid})`);
    console.log(renderBoard(rows, {
      currentIndex: index + 1 < rows.length ? index + 1 : -1,
      title: 'Progress so far',
    }));
  }

  printFinalSummary(rows, {
    dryRun,
    beforeStats,
    afterStats: previousStats,
    stepDeltas,
  });
  if (rows.some(r => r.status === STATUS.failed)) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
