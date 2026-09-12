#!/usr/bin/env node
// backfill-src.mjs — stamp a `SRC: {source}` token into the Notes column of
// every tracker row, so per-source funnel analytics can be computed from the
// tracker alone (see source-analytics.mjs).
//
// Resolution chain, most authoritative first:
//   1. an existing SRC: token on the row (idempotent re-runs)
//   2. exact URL match in ft/batch/aggregator-backlog-2026-07-14/ ("discovery via X")
//   3. exact URL match in data/scan-history.tsv (portal column)
//   4. batch-TSV filename token keyed by row number (hnhiring, jobright, ...)
//   5. the posting URL's host (greenhouse.io -> greenhouse-api, ...)
//   6. unknown
//
// The row's URL comes from the Notes `URL:` field, else the linked eval
// report's `**URL:**` header line.
//
// Usage: node backfill-src.mjs [--dry-run] [--limit N] [--list-unresolved]
//                              [--fix-mismatches]
//
// --fix-mismatches rewrites a row whose existing token disagrees with the
// evidence (e.g. an eval agent invented `chime-greenhouse-scan` where
// scan-history records `greenhouse-api`). Off by default: a token that merely
// looks odd may still be the truth, so replacing one is an explicit choice.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from './lib/paths.mjs';
import { normalizeSource, sourceFromUrl, normalizeUrlKey, readSrcToken, withSrcToken } from './lib/sources.mjs';

const P = resolvePaths(import.meta.url);
const DRY = process.argv.includes('--dry-run');
const LIST_UNRESOLVED = process.argv.includes('--list-unresolved');
const FIX_MISMATCHES = process.argv.includes('--fix-mismatches');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

// ---------- build lookup tables ----------

// (2) aggregator backlog: URL -> exact repo, from the "discovery via X" prose.
const backlogMap = new Map();
const backlogDir = P.batchDir('aggregator-backlog-2026-07-14');
if (existsSync(backlogDir)) {
  for (const f of readdirSync(backlogDir).filter(x => x.endsWith('.tsv'))) {
    const text = readFileSync(join(backlogDir, f), 'utf8');
    const src = normalizeSource((text.match(/discovery via ([a-z0-9][a-z0-9-]*)/i) || [])[1]);
    const url = (text.match(/URL:\s*(https?:\/\/\S+)/i) || [])[1];
    if (src && url) backlogMap.set(normalizeUrlKey(url.replace(/[.,;]+$/, '')), src);
  }
}

// (3) scan-history: URL -> portal. Later rows win (a re-scan is more current).
const historyMap = new Map();
const historyFile = join(P.dataDir, 'scan-history.tsv');
if (existsSync(historyFile)) {
  for (const line of readFileSync(historyFile, 'utf8').split('\n')) {
    const c = line.split('\t');
    if (c.length < 3 || c[0] === 'url' || !c[0].startsWith('http')) continue;
    const src = normalizeSource(c[2]);
    if (src) historyMap.set(normalizeUrlKey(c[0]), src);
  }
}

// (4) batch filename tokens: row number -> source token.
const fileTokenMap = new Map();
for (const sub of ['tracker-additions/merged', 'aggregator-backlog-2026-07-14']) {
  const dir = P.batchDir(sub);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter(x => x.endsWith('.tsv'))) {
    const m = f.match(/^(\d+)-.*-([a-z0-9]+)\.tsv$/i);
    if (!m) continue;
    const src = normalizeSource(m[2]);
    if (src && !fileTokenMap.has(m[1])) fileTokenMap.set(m[1], src);
  }
}

// Report `**URL:**` header, keyed by report path.
function urlFromReport(reportRelPath) {
  const abs = join(P.target, reportRelPath);
  if (!existsSync(abs)) return null;
  const m = readFileSync(abs, 'utf8').match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/m);
  return m ? m[1] : null;
}

// ---------- walk the tracker ----------

// How much each resolution tier can be trusted. `backlog-prose` and
// `scan-history` are recorded provenance; `url-host` only identifies the ATS,
// not who surfaced the posting.
const CONFIDENCE = {
  'existing-token': 'recorded',
  'backlog-prose': 'recorded',
  'scan-history': 'recorded',
  'batch-filename': 'recorded',
  'url-host': 'inferred',
  unresolved: 'none',
  'no-url': 'none',
};

const lines = readFileSync(P.appsFile, 'utf8').split('\n');
const stats = { rows: 0, already: 0, resolved: {}, via: {}, mismatched: [] };
const provenance = [];
let changed = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('|')) continue;
  // Tolerate a missing terminal pipe and re-emit it, but never touch a row
  // that is not exactly 9 cells.
  const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  if (cells.length !== 9) continue;
  if (!/^\d+$/.test(cells[0])) continue;           // header / separator
  stats.rows++;
  if (stats.rows > LIMIT) break;

  const num = cells[0];
  const notes = cells[8] || '';

  // Resolution runs for EVERY row, tagged or not, so the provenance sidecar
  // always records the true tier. An earlier version short-circuited on an
  // existing token and a re-run then rewrote every row as `existing-token`,
  // erasing the inferred/none tiers.
  // A pre-2026-08-07 writer may have stamped the feed's own label rather than a
  // canonical id (jobspy wrote `SRC: linkedin`). Fold it to canonical here, or
  // the row keeps a token that never joins its own scan-history counts.
  const rawExisting = readSrcToken(notes);
  const existing = rawExisting ? (normalizeSource(rawExisting) || rawExisting) : null;
  const nonCanonical = Boolean(rawExisting) && existing !== rawExisting;

  // Find this row's posting URL.
  let url = (notes.match(/URL:\s*(https?:\/\/\S+)/i) || [])[1];
  if (url) url = url.replace(/[.,;]+$/, '');
  if (!url) {
    const rep = (cells[7].match(/\]\(([^)]+)\)/) || [])[1];
    if (rep && !/pending\.md$/.test(rep)) url = urlFromReport(rep);
  }
  const key = url ? normalizeUrlKey(url) : '';

  let source = null, via = null;
  if (key && backlogMap.has(key)) { source = backlogMap.get(key); via = 'backlog-prose'; }
  if (!source && key && historyMap.has(key)) { source = historyMap.get(key); via = 'scan-history'; }
  if (!source && fileTokenMap.has(num)) { source = fileTokenMap.get(num); via = 'batch-filename'; }
  if (!source && url) { source = sourceFromUrl(url); if (source) via = 'url-host'; }
  if (!source) {
    source = 'unknown';
    via = url ? 'unresolved' : 'no-url';
    if (LIST_UNRESOLVED && !existing) {
      console.log(`  unresolved #${num.padStart(4)} | ${cells[2]} | ${cells[3]} | ${cells[5]} | ${url || 'NO URL'}`);
    }
  }

  if (existing) {
    // Row already carries a token: leave it alone, but keep its true tier and
    // surface any disagreement with what the evidence now says. A token that
    // only needed canonicalizing is rewritten unconditionally: it is the same
    // provenance claim, just spelled the way the taxonomy spells it.
    if (nonCanonical) {
      cells[8] = withSrcToken(notes, existing);
      lines[i] = `| ${cells.join(' | ')} |`;
      changed++;
      stats.canonicalized = (stats.canonicalized || 0) + 1;
      stats.resolved[existing] = (stats.resolved[existing] || 0) + 1;
      stats.via[via] = (stats.via[via] || 0) + 1;
      provenance.push([num, existing, via, CONFIDENCE[via]].join('\t'));
      continue;
    }
    const disagrees = source !== 'unknown' && source !== existing;
    if (disagrees) {
      stats.mismatched.push(
        `#${num}: row says ${existing}, evidence says ${source} (${via})${FIX_MISMATCHES ? ' -> fixed' : ''}`
      );
    }
    if (disagrees && FIX_MISMATCHES) {
      cells[8] = withSrcToken(notes, source);
      lines[i] = `| ${cells.join(' | ')} |`;
      changed++;
      stats.resolved[source] = (stats.resolved[source] || 0) + 1;
      stats.via[via] = (stats.via[via] || 0) + 1;
      provenance.push([num, source, via, CONFIDENCE[via]].join('\t'));
      continue;
    }
    stats.already++;
    stats.resolved[existing] = (stats.resolved[existing] || 0) + 1;
    stats.via[via] = (stats.via[via] || 0) + 1;
    provenance.push([num, existing, via, CONFIDENCE[via]].join('\t'));
    continue;
  }

  cells[8] = withSrcToken(notes, source);
  lines[i] = `| ${cells.join(' | ')} |`;
  changed++;
  stats.resolved[source] = (stats.resolved[source] || 0) + 1;
  stats.via[via] = (stats.via[via] || 0) + 1;
  provenance.push([num, source, via, CONFIDENCE[via]].join('\t'));
}

// ---------- report ----------

console.log(`tracker: ${P.appsFile}`);
console.log(`rows: ${stats.rows}   already tagged: ${stats.already}   newly tagged: ${changed}\n`);
console.log('resolved by:');
for (const [v, n] of Object.entries(stats.via).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.padEnd(16)} ${n}   (${CONFIDENCE[v]})`);
}
console.log('\nsource distribution:');
for (const [s, n] of Object.entries(stats.resolved).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(34)} ${n}`);
}

if (stats.mismatched.length) {
  console.log(`\n${stats.mismatched.length} row(s) disagree with the evidence:`);
  for (const m of stats.mismatched.slice(0, 20)) console.log(`  ${m}`);
  if (stats.mismatched.length > 20) console.log(`  ... and ${stats.mismatched.length - 20} more`);
}

if (DRY) { console.log('\n(dry run, tracker not written)'); process.exit(0); }
writeFileSync(P.appsFile, lines.join('\n'));
console.log(`\nwrote ${changed} rows to ${P.appsFile}`);

const sidecar = join(P.dataDir, 'src-provenance.tsv');
writeFileSync(sidecar, 'row\tsource\tresolved_via\tconfidence\n' + provenance.join('\n') + '\n');
console.log(`wrote provenance for ${provenance.length} rows to ${sidecar}`);
