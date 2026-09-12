#!/usr/bin/env node

/**
 * scan-all.mjs — Run every active discovery source in scan order.
 *
 * Zero LLM tokens. Orchestrates the same entrypoints modes/scan.md lists for a
 * full `/career-ops scan` discovery pass. Does not evaluate, merge, or apply.
 *
 * Included (in order):
 *   1. scan.mjs              ATS APIs
 *   2. scan-spa.mjs          Playwright SPAs
 *   3. scan-freehire.mjs     freehire.me
 *   4. aggregator-intake.py  GitHub job-list repos
 *   5. jobspy-ingest.py      JobSpy (Indeed / LinkedIn / …)
 *   6. adzuna-ingest.py      Adzuna (optional; needs credentials)
 *   7. hiringcafe-ingest.py  Hiring Cafe (optional; needs FlareSolverr)
 *   8. hn-hiring-ingest.py   HN Who Is Hiring
 *
 * Excluded by design:
 *   - scan-linkedin.mjs (opt-in ToS gate; never auto-run)
 *   - yc / levels / startupjobs ingest (deferred FT surfaces)
 *   - h1bgrader_lookup.py (optional enrichment, not a scanner)
 *
 * Usage:
 *   node scan-all.mjs
 *   node scan-all.mjs --dry-run
 *   node scan-all.mjs --skip adzuna,hiringcafe
 *   node scan-all.mjs --only scan,spa,freehire
 *   npm run scan:all
 *   npm run scan:all -- --dry-run
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const SOURCES = [
  {
    id: 'scan',
    label: 'ATS APIs (Greenhouse / Ashby / Lever / Workday)',
    kind: 'node',
    script: 'scan.mjs',
    required: true,
  },
  {
    id: 'spa',
    label: 'SPA / Playwright boards',
    kind: 'node',
    script: 'scan-spa.mjs',
    required: true,
  },
  {
    id: 'freehire',
    label: 'freehire.me',
    kind: 'node',
    script: 'scan-freehire.mjs',
    required: true,
  },
  {
    id: 'aggregator',
    label: 'GitHub aggregators',
    kind: 'python',
    script: join('scripts', 'aggregator-intake.py'),
    required: true,
  },
  {
    id: 'jobspy',
    label: 'JobSpy (Indeed / LinkedIn / ZipRecruiter / Google)',
    kind: 'python',
    script: join('scripts', 'jobspy-ingest.py'),
    required: true,
  },
  {
    id: 'adzuna',
    label: 'Adzuna',
    kind: 'python',
    script: join('scripts', 'adzuna-ingest.py'),
    required: false,
    skipExitCodes: [2],
    skipHint: 'needs ADZUNA_APP_ID and ADZUNA_APP_KEY',
  },
  {
    id: 'hiringcafe',
    label: 'Hiring Cafe',
    kind: 'python',
    script: join('scripts', 'hiringcafe-ingest.py'),
    required: false,
    skipExitCodes: [2],
    skipHint: 'needs FlareSolverr on localhost:8191 (or headed fallback)',
  },
  {
    id: 'hn',
    label: 'HN Who Is Hiring',
    kind: 'python',
    script: join('scripts', 'hn-hiring-ingest.py'),
    required: true,
  },
];

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

function runSource(source, { dryRun, pythonCmd }) {
  const scriptPath = join(ROOT, source.script);
  if (!existsSync(scriptPath)) {
    return { status: 'failed', code: 127, detail: `missing ${source.script}` };
  }

  let command;
  let args;
  if (source.kind === 'node') {
    command = process.execPath;
    args = [scriptPath];
  } else {
    if (!pythonCmd) {
      return { status: 'failed', code: 127, detail: 'python not found on PATH' };
    }
    command = pythonCmd[0];
    args = [...pythonCmd.slice(1), scriptPath];
  }
  if (dryRun) args.push('--dry-run');

  console.log(`\n═══ [${source.id}] ${source.label} ═══`);
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  const ms = Date.now() - started;
  const code = result.status ?? 1;

  if (result.error) {
    return { status: 'failed', code: 1, detail: result.error.message, ms };
  }
  if (code === 0) return { status: 'ok', code: 0, ms };
  if (!source.required && (source.skipExitCodes || []).includes(code)) {
    return {
      status: 'skipped',
      code,
      detail: source.skipHint || `exit ${code}`,
      ms,
    };
  }
  return { status: 'failed', code, detail: `exit ${code}`, ms };
}

function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    printHelp();
    return;
  }

  const dryRun = flags.has('dry-run');
  const selected = selectSources({ flags, values });
  const needsPython = selected.some(s => s.kind === 'python');
  const pythonCmd = needsPython ? resolvePython() : null;

  console.log('career-ops scan-all');
  console.log(`Sources: ${selected.map(s => s.id).join(', ')}`);
  if (dryRun) console.log('Mode: dry-run (no writes)');
  if (needsPython && !pythonCmd) {
    console.error('error: python is required for ingest scripts but was not found on PATH');
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const source of selected) {
    const outcome = runSource(source, { dryRun, pythonCmd });
    results.push({ source, ...outcome });
    const tag = outcome.status.toUpperCase();
    const extra = outcome.detail ? ` (${outcome.detail})` : '';
    const timing = outcome.ms !== undefined ? ` ${Math.round(outcome.ms / 1000)}s` : '';
    console.log(`→ ${tag}${extra}${timing}`);
  }

  console.log('\n═══ scan-all summary ═══');
  for (const row of results) {
    console.log(`  ${row.status.padEnd(8)} ${row.source.id}`);
  }

  const failed = results.filter(r => r.status === 'failed');
  const skipped = results.filter(r => r.status === 'skipped');
  const ok = results.filter(r => r.status === 'ok');
  console.log(`\n${ok.length} ok, ${skipped.length} skipped, ${failed.length} failed`);
  if (!dryRun) {
    console.log('Handoff: ft/data/scan-results-*.tsv and/or ft/batch/tracker-additions/');
    console.log('Next: liveness gate, then evaluate (or /career-ops scan resume).');
  }

  if (failed.length) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
