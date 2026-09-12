#!/usr/bin/env node

/**
 * live-loop-batch.mjs — run the end-to-end loop across many postings.
 *
 * Usage:
 *   node extensions/job-autofill/tests/live-loop-batch.mjs <urls-file> [--jobs 2] [--out dir]
 *
 * SAFETY: shells out to live-loop.mjs, which never clicks a submit control.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOOP = join(HERE, 'live-loop.mjs');

const args = process.argv.slice(2);
const listFile = args.find(a => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
// Ashby serves an empty shell under heavy concurrency, so keep this low.
const JOBS = Number(flag('jobs', 2));
const OUT = resolve(flag('out', join(tmpdir(), 'job-autofill-loop-batch')));
const TIMEOUT = Number(flag('timeout', 600)) * 1000;

if (!listFile) {
  console.error('\n  usage: node extensions/job-autofill/tests/live-loop-batch.mjs <urls-file>\n');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const urls = readFileSync(listFile, 'utf-8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

function run(url, index) {
  return new Promise(done => {
    const child = spawn('node', [LOOP, url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT);
    child.on('close', code => {
      clearTimeout(killer);
      const file = join(OUT, `${String(index).padStart(2, '0')}.log`);
      writeFileSync(file, log);
      const grab = re => log.match(re);
      const p1 = grab(/PASS 1: (\d+) filled \/ (\d+) needs-you \/ (\d+) failed/);
      const p2 = grab(/PASS 2: (\d+) filled \/ (\d+) needs-you \/ (\d+) failed/);
      done({
        url,
        log: file,
        code,
        taught: Number(grab(/answered by hand: (\d+)/)?.[1] ?? -1),
        pass1: p1 ? { filled: +p1[1], unknown: +p1[2], failed: +p1[3] } : null,
        pass2: p2 ? { filled: +p2[1], unknown: +p2[2], failed: +p2[3] } : null,
        failures: [...log.matchAll(/^  FAIL {2}(.+)$/gm)].map(m => m[1]),
        noForm: /PASS 1: 0 filled \/ 0 needs-you/.test(log) || /loop run threw/.test(log),
      });
    });
  });
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (next < urls.length) {
    const i = next++;
    const r = await run(urls[i], i);
    results[i] = r;
    const p1 = r.pass1 ? `${r.pass1.filled}f/${r.pass1.unknown}u/${r.pass1.failed}x` : '  -  ';
    const p2 = r.pass2 ? `${r.pass2.filled}f/${r.pass2.unknown}u/${r.pass2.failed}x` : '  -  ';
    console.log(
      `  [${String(results.filter(Boolean).length).padStart(2)}/${urls.length}] ` +
      `${(r.failures.length ? 'FAIL' : 'ok').padEnd(5)} taught ${String(r.taught).padStart(2)}  ` +
      `${p1.padEnd(12)} -> ${p2.padEnd(12)} ${r.url.replace(/^https?:\/\//, '').slice(0, 58)}`
    );
    for (const f of r.failures) console.log(`         ${f.slice(0, 150)}`);
  }
}));

const rows = results.filter(Boolean);
const live = rows.filter(r => r.pass1 && !r.noForm);
const failed = rows.filter(r => r.failures.length);
const taught = live.filter(r => r.taught > 0);
const closed = taught.filter(r => r.pass2 && r.pass2.filled > r.pass1.filled);

console.log('\n  ' + '='.repeat(70));
console.log(`  postings with a live form: ${live.length}/${rows.length}`);
console.log(`  clean (no failures):       ${live.length - failed.length}/${live.length}`);
console.log(`  taught something:          ${taught.length}`);
console.log(`  learning loop closed:      ${closed.length}/${taught.length}`);
console.log(`  fields filled, pass 1:     ${live.reduce((a, r) => a + r.pass1.filled, 0)}`);
console.log(`  fields filled, pass 2:     ${live.reduce((a, r) => a + (r.pass2?.filled ?? 0), 0)}`);
console.log(`  fill failures:             ${live.reduce((a, r) => a + r.pass1.failed + (r.pass2?.failed ?? 0), 0)}`);
if (failed.length) {
  console.log('\n  needs investigation:');
  for (const f of failed) console.log(`    ${f.log}  ${f.url.slice(0, 70)}`);
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(rows, null, 2));
console.log(`\n  logs in ${OUT}\n`);
