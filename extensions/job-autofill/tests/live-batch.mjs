#!/usr/bin/env node

/**
 * live-batch.mjs — run the live harness across many real postings and report
 * one line each.
 *
 * Single-URL runs proved each board once. Sweeping the tracker's postings is
 * what catches the per-company variation: the same board renders differently
 * depending on which optional questions a company switched on.
 *
 * Usage:
 *   node extensions/job-autofill/tests/live-batch.mjs <urls-file> [--jobs 3] [--out dir]
 *
 * The urls file is one URL per line, or "board<TAB>url". Blank lines and #
 * comments are skipped.
 *
 * SAFETY: this only shells out to live.mjs, which never clicks a submit or
 * apply control. Nothing is ever sent to an employer.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = join(HERE, 'live.mjs');

const args = process.argv.slice(2);
const listFile = args.find(a => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const JOBS = Number(flag('jobs', 3));
const OUT = resolve(flag('out', join(tmpdir(), 'job-autofill-batch')));
const TIMEOUT = Number(flag('timeout', 180)) * 1000;

if (!listFile) {
  console.error('\n  usage: node extensions/job-autofill/tests/live-batch.mjs <urls-file> [--jobs 3]\n');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const targets = readFileSync(listFile, 'utf-8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))
  .map(line => {
    const url = line.includes('\t') ? line.split('\t').pop() : line;
    return { url: applicationUrl(url) };
  });

/**
 * Point at the application form, not the job description.
 *
 * Lever and Ashby serve the posting and the form at different paths, and the
 * posting page has no fields at all, so a sweep run against posting URLs would
 * report a fleet of empty forms and prove nothing.
 */
function applicationUrl(raw) {
  const url = new URL(raw);
  if (url.hostname.endsWith('lever.co') && !/\/apply\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/$/, '') + '/apply';
  }
  if (url.hostname.endsWith('ashbyhq.com') && !/\/application\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/$/, '') + '/application';
  }
  return url.toString();
}

const NUM = /-?\d+/;
function parse(log) {
  const grab = re => log.match(re)?.[1]?.trim();
  const fill = log.match(/FILL: (\d+) filled \/ (\d+) needs-you \/ (\d+) failed/);
  const blur = log.match(/blur check: (?:all (\d+) non-empty values survived|(\d+) value\(s\) REVERTED)/);
  return {
    board: grab(/\n  board: .*\((\w+)\)/) || (/detect failed/.test(log) ? 'DETECT-FAIL' : '?'),
    fields: Number(grab(/fields detected: (\d+)/) ?? -1),
    filled: fill ? Number(fill[1]) : -1,
    unknown: fill ? Number(fill[2]) : -1,
    failed: fill ? Number(fill[3]) : -1,
    survived: blur?.[1] ? Number(blur[1]) : blur?.[2] ? -Number(blur[2]) : null,
    threw: grab(/live run threw: (.*)/),
    controlsInForm: Number(log.match(/\n\s+(\d+) controls\s+http/)?.[1] ?? NUM.exec('-1')[0]),
    unknowns: [...log.matchAll(/\n    - (.+)/g)].map(m => m[1]),
  };
}

function run(target, index) {
  return new Promise(done => {
    const started = Date.now();
    const child = spawn('node', [LIVE, target.url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT);
    child.on('close', () => {
      clearTimeout(killer);
      const file = join(OUT, `${String(index).padStart(3, '0')}.log`);
      writeFileSync(file, log);
      const parsed = parse(log);
      const secs = Math.round((Date.now() - started) / 1000);
      done({ ...target, ...parsed, secs, log: file, timedOut: Date.now() - started >= TIMEOUT - 500 });
    });
  });
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (next < targets.length) {
    const i = next++;
    const r = await run(targets[i], i);
    results[i] = r;
    const done = results.filter(Boolean).length;
    console.log(
      `  [${String(done).padStart(3)}/${targets.length}] ${verdict(r).padEnd(12)} ` +
      `${String(r.filled).padStart(3)}f ${String(r.unknown).padStart(2)}u ${String(r.failed).padStart(2)}x  ` +
      `${r.url.replace(/^https?:\/\//, '').slice(0, 74)}`
    );
  }
}));

/**
 * A sweep over old tracker rows hits a lot of taken-down postings. Those are
 * not extension failures and must not be counted as such, so an empty page is
 * called out as its own verdict rather than folded into the pass/fail tally.
 */
function verdict(r) {
  if (r.timedOut) return 'TIMEOUT';
  if (r.threw) return 'THREW';
  if (r.board === 'DETECT-FAIL') return 'no-content-js';
  if (r.fields <= 0) return 'no-form';
  if (r.failed > 0) return 'FAILED';
  if (r.survived !== null && r.survived < 0) return 'REVERTED';
  if (r.filled === 0) return 'filled-none';
  return 'ok';
}

const rows = results.filter(Boolean);
const tally = {};
for (const r of rows) tally[verdict(r)] = (tally[verdict(r)] || 0) + 1;

console.log('\n  ' + '='.repeat(72));
console.log('  VERDICTS: ' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  '));
const real = rows.filter(r => verdict(r) !== 'no-form' && verdict(r) !== 'TIMEOUT');
console.log(`  forms actually exercised: ${real.length}`);
console.log(`  fields filled: ${real.reduce((a, r) => a + Math.max(0, r.filled), 0)}`);
console.log(`  needs-you:     ${real.reduce((a, r) => a + Math.max(0, r.unknown), 0)}`);
console.log(`  failed:        ${real.reduce((a, r) => a + Math.max(0, r.failed), 0)}`);

const problems = rows.filter(r => ['FAILED', 'REVERTED', 'THREW', 'no-content-js', 'filled-none'].includes(verdict(r)));
if (problems.length) {
  console.log('\n  needs investigation:');
  for (const p of problems) console.log(`    ${verdict(p).padEnd(14)} ${p.log}  ${p.url.slice(0, 80)}`);
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(rows.map(r => ({ ...r, verdict: verdict(r) })), null, 2));
console.log(`\n  logs + summary.json in ${OUT}\n`);
