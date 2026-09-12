#!/usr/bin/env node
// source-analytics.mjs — per-discovery-source funnel.
//
// Two ledgers, deliberately kept separate because they answer different questions:
//   scanned  — every URL a source ever surfaced, from data/scan-history.tsv
//              (includes rows dropped by filters and never tracked)
//   tracked  — rows that reached the tracker, from the `SRC:` Notes token
//
// A source's yield is tracked/scanned; its apply rate is applied/tracked.
//
// Usage: node source-analytics.mjs [--json] [--min-scanned N]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from './lib/paths.mjs';
import { normalizeSource, readSrcToken, groupOf } from './lib/sources.mjs';

const P = resolvePaths(import.meta.url);
const AS_JSON = process.argv.includes('--json');
const minArg = process.argv.indexOf('--min-scanned');
const MIN_SCANNED = minArg > -1 ? Number(process.argv[minArg + 1]) : 0;

const APPLY_TIER = 4.0;
const blank = () => ({
  scanned: 0, dropped: 0, tracked: 0,
  evaluated: 0, applied: 0, discarded: 0, other: 0,
  applyTier: 0, scoreSum: 0, scoreN: 0,
});
const rows = new Map();
const at = (s) => { if (!rows.has(s)) rows.set(s, blank()); return rows.get(s); };

// ---------- ledger 1: scan-history (what each source surfaced) ----------
const historyFile = join(P.dataDir, 'scan-history.tsv');
const malformed = { count: 0, unattributed: 0 };
if (existsSync(historyFile)) {
  for (const line of readFileSync(historyFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    if (c[0] === 'url') continue;
    // Rows with fewer than 6 columns are pre-2026-07 damage; count but skip.
    if (c.length < 6 || !c[0].startsWith('http')) { malformed.count++; continue; }
    const source = normalizeSource(c[2]);
    if (!source) { malformed.unattributed++; continue; }
    const r = at(source);
    r.scanned++;
    if (c[5] && c[5] !== 'added') r.dropped++;
  }
}

// ---------- ledger 2: the tracker (what each source produced) ----------
let trackerRows = 0;
for (const line of readFileSync(P.appsFile, 'utf8').split('\n')) {
  if (!line.startsWith('|')) continue;
  const c = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(x => x.trim());
  if (c.length !== 9 || !/^\d+$/.test(c[0])) continue;
  trackerRows++;
  // Normalize the raw token: writers predating 2026-08-07 stamped the feed's own
  // label (jobspy wrote `SRC: linkedin`), which split one source into a phantom
  // tracked-only bucket beside its scanned-only canonical twin.
  const rawToken = readSrcToken(c[8]);
  const source = (rawToken && normalizeSource(rawToken)) || rawToken || 'unknown';
  const r = at(source);
  r.tracked++;

  const status = c[5];
  if (status === 'Applied') r.applied++;
  else if (status === 'Evaluated') r.evaluated++;
  else if (status === 'Discarded' || status === 'Purged' || status === 'Rejected-at-eval') r.discarded++;
  else r.other++;

  const score = parseFloat((c[4].match(/([\d.]+)\s*\/\s*5/) || [])[1]);
  if (!Number.isNaN(score)) {
    r.scoreSum += score; r.scoreN++;
    if (score >= APPLY_TIER) r.applyTier++;
  }
}

// ---------- confidence, from the backfill sidecar ----------
const conf = { recorded: 0, inferred: 0, none: 0 };
const sidecar = join(P.dataDir, 'src-provenance.tsv');
if (existsSync(sidecar)) {
  for (const line of readFileSync(sidecar, 'utf8').split('\n')) {
    const c = line.split('\t');
    if (c.length < 4 || c[0] === 'row') continue;
    if (conf[c[3]] !== undefined) conf[c[3]]++;
  }
}

// ---------- render ----------
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');
const entries = [...rows.entries()]
  .filter(([, r]) => r.scanned >= MIN_SCANNED || r.tracked > 0)
  .sort((a, b) => (b[1].scanned || b[1].tracked) - (a[1].scanned || a[1].tracked));

if (AS_JSON) {
  console.log(JSON.stringify({
    generated_from: { tracker: P.appsFile, history: historyFile },
    tracker_rows: trackerRows, confidence: conf, malformed,
    sources: Object.fromEntries(entries.map(([s, r]) => [s, {
      group: groupOf(s), ...r,
      avg_score: r.scoreN ? +(r.scoreSum / r.scoreN).toFixed(2) : null,
      yield: r.scanned ? +(r.tracked / r.scanned).toFixed(4) : null,
    }])),
  }, null, 2));
  process.exit(0);
}

const H = ['source', 'group', 'scanned', 'tracked', 'yield', 'eval', 'appl', 'disc', '>=4.0', 'avg'];
const W = [34, 11, 8, 8, 7, 6, 6, 6, 6, 5];
const line = (cs) => cs.map((c, i) => String(c).padEnd(W[i])).join(' ');

console.log('\nDiscovery-source funnel');
console.log(`tracker: ${P.appsFile}`);
console.log(`history: ${historyFile}\n`);
console.log(line(H));
console.log(W.map(w => '-'.repeat(w)).join(' '));

// tracked > scanned is impossible: it means the source surfaced rows before it
// started writing to scan-history, so its `scanned` count is a floor, not a
// total. Flag it rather than printing a yield above 100%.
const tot = blank();
const incomplete = [];
for (const [source, r] of entries) {
  const ledgerShort = r.scanned > 0 && r.tracked > r.scanned;
  if (ledgerShort) incomplete.push(source);
  console.log(line([
    source + (ledgerShort ? ' *' : ''), groupOf(source), r.scanned || '-', r.tracked || '-',
    ledgerShort ? 'n/a' : (r.scanned ? pct(r.tracked, r.scanned) : '-'),
    r.evaluated || '-', r.applied || '-', r.discarded || '-', r.applyTier || '-',
    r.scoreN ? (r.scoreSum / r.scoreN).toFixed(2) : '-',
  ]));
  for (const k of Object.keys(tot)) tot[k] += r[k];
}
console.log(W.map(w => '-'.repeat(w)).join(' '));
console.log(line([
  `TOTAL (${entries.length} sources)`, '', tot.scanned, tot.tracked,
  pct(tot.tracked, tot.scanned), tot.evaluated, tot.applied, tot.discarded, tot.applyTier,
  tot.scoreN ? (tot.scoreSum / tot.scoreN).toFixed(2) : '-',
]));

console.log(`\nAttribution confidence (${Object.values(conf).reduce((a, b) => a + b, 0)} rows in src-provenance.tsv):`);
console.log(`  recorded (real provenance): ${conf.recorded}`);
console.log(`  inferred (ATS host only):   ${conf.inferred}`);
console.log(`  none (unresolved):          ${conf.none}`);
if (malformed.count || malformed.unattributed) {
  console.log(`\nscan-history rows excluded: ${malformed.count} malformed (<6 cols), ${malformed.unattributed} with an unrecognised portal value.`);
}
if (incomplete.length) {
  console.log(`\n* scan ledger incomplete (tracked > scanned): ${incomplete.join(', ')}.`);
  console.log('  These surfaced rows before their ingest path wrote to scan-history,');
  console.log('  so `scanned` is a floor and no yield is computed. Future runs are correct.');
}
console.log('\nyield = tracked/scanned. A low yield is not automatically bad: a broad');
console.log('source can still be the only one surfacing a given company.\n');
