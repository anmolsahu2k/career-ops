#!/usr/bin/env node
/**
 * hygiene-sweep.mjs — post-eval liveness hygiene for Evaluated tracker rows.
 *
 * FT port of the intern-era hygiene pass (2026-05-03, commit 3c8808f):
 * rows that were evaluated but never applied to go stale as postings close.
 * This sweep liveness-checks their URLs and flips dead ones to Purged.
 * Applied/Responded/Interview rows are never touched; live-but-old evergreen
 * reqs stay Evaluated (the criterion is dead posting, not calendar age).
 *
 * Both phases write `Purged`, never `Discarded`. Neither is a judgement about
 * the role, only about a dead link or the calendar, and `Discarded` is reserved
 * for the candidate's own d-key call in the dashboard. See templates/states.yml.
 *
 * Two phases, with the existing bulk liveness checker in between:
 *
 *   node hygiene-sweep.mjs extract <urls.txt> <map.tsv>
 *   CONCURRENCY=20 npm run liveness:bulk -- <urls.txt> <liveness.tsv>
 *   node hygiene-sweep.mjs apply <map.tsv> <liveness.tsv> [--apply]
 *
 * extract: collects each Evaluated row's URL (report **URL:** header first,
 *   Notes "URL:" fallback), writes a dedup'd URL list + a row->url map.
 * apply: DRY-RUN by default. For rows whose URL classified `expired`, flips
 *   Status to Purged, appends "Liveness sweep {date}: expired ({reason})."
 *   to Notes, and updates the report's `**Status:**` header. `active` and
 *   `uncertain` verdicts leave the row untouched.
 *
 * Plus a zero-network age purge (policy decided 2026-08-07):
 *
 *   node hygiene-sweep.mjs age [--apply]
 *
 * age: flips Evaluated rows whose tracker Date (evaluation date) is more than
 *   21 days old to Purged — a shelf-life on the apply queue, NOT posting
 *   age (the wave-6 >120d STALE-REQ posting-age policy is untouched).
 *   Apply-tier rows (score >= 4.0) are exempt; unparseable scores are kept
 *   and warned. DRY-RUN by default.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';
import { resolvePaths } from './lib/paths.mjs';

const P = resolvePaths(import.meta.url);
const TODAY = new Date().toISOString().slice(0, 10);
const URL_RE = /^\*\*URL:\*\*\s*(https?:\/\/\S+)/m;

function parseRows() {
  const lines = readFileSync(P.appsFile, 'utf-8').split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|') || /^\|\s*(#|-)/.test(line)) continue;
    const cells = line.split('|');
    if (cells.length !== 11) {
      console.warn(`WARN line ${i + 1}: expected 9 cells, got ${cells.length - 2} — skipped`);
      continue;
    }
    rows.push({ lineIdx: i, cells, num: cells[1].trim(), company: cells[3].trim(), role: cells[4].trim(), status: cells[6].trim(), report: cells[8].trim(), notes: cells[9] });
  }
  return { lines, rows };
}

function rowUrl(row) {
  const rp = (row.report.match(/\(([^)]+\.md)\)/) || [])[1];
  if (rp) {
    try {
      const m = readFileSync(join(P.target, rp), 'utf-8').match(URL_RE);
      if (m) return { url: m[1].replace(/[.,]+$/, ''), reportPath: rp };
    } catch { /* report missing, fall through to Notes */ }
  }
  const m = row.notes.match(/URL:\s*(https?:\/\/\S+)/);
  if (m) return { url: m[1].replace(/[.,]+$/, ''), reportPath: rp || '' };
  return null;
}

function extract(urlsOut, mapOut) {
  const { rows } = parseRows();
  const evaluated = rows.filter(r => r.status === 'Evaluated');
  const urls = new Set();
  const mapLines = ['#row\tcompany\trole\treport\turl'];
  let noUrl = 0;
  for (const r of evaluated) {
    const found = rowUrl(r);
    if (!found) { noUrl++; console.warn(`no URL: row ${r.num} ${r.company} — ${r.role}`); continue; }
    urls.add(found.url);
    mapLines.push([r.num, r.company, r.role, found.reportPath, found.url].join('\t'));
  }
  writeFileSync(urlsOut, Array.from(urls).join('\n') + '\n');
  writeFileSync(mapOut, mapLines.join('\n') + '\n');
  console.log(`${evaluated.length} Evaluated rows -> ${urls.size} unique URLs (${noUrl} rows without a URL, left untouched)`);
}

function apply(mapFile, livenessFile, doApply) {
  const verdicts = new Map(); // url -> {result, reason}
  for (const line of readFileSync(livenessFile, 'utf-8').split('\n')) {
    const [url, result, , reason] = line.split('\t');
    if (url && result) verdicts.set(url, { result, reason: reason || '' });
  }
  const rowToUrl = new Map();
  for (const line of readFileSync(mapFile, 'utf-8').split('\n').slice(1)) {
    const [num, , , reportPath, url] = line.split('\t');
    if (num && url) rowToUrl.set(num, { url, reportPath });
  }

  const { lines, rows } = parseRows();
  const counts = { expired: 0, active: 0, uncertain: 0, unchecked: 0 };
  const flips = [];
  for (const r of rows) {
    if (r.status !== 'Evaluated') continue;
    const entry = rowToUrl.get(r.num);
    if (!entry) continue;
    const v = verdicts.get(entry.url);
    if (!v) { counts.unchecked++; continue; }
    counts[v.result] = (counts[v.result] || 0) + 1;
    if (v.result !== 'expired') continue;
    flips.push(`${r.num}\t${r.company}\t${r.role}\t${v.reason}`);
    r.cells[6] = ' Purged ';
    const note = ` Liveness sweep ${TODAY}: expired (${v.reason || 'posting gone'}).`;
    r.cells[9] = r.cells[9].replace(/\s*$/, '') + note + ' ';
    lines[r.lineIdx] = r.cells.join('|');
    if (doApply && entry.reportPath) {
      const abs = join(P.target, entry.reportPath);
      if (existsSync(abs)) {
        const text = readFileSync(abs, 'utf-8');
        if (text.includes('**Status:** Evaluated')) {
          writeFileSync(abs, text.replace('**Status:** Evaluated', '**Status:** Purged'));
        }
      }
    }
  }

  console.log(`verdicts over Evaluated rows: ${counts.expired || 0} expired / ${counts.active || 0} active / ${counts.uncertain || 0} uncertain / ${counts.unchecked} unchecked`);
  console.log(flips.length ? `\n#row\tcompany\trole\treason\n${flips.join('\n')}` : 'no flips');
  if (!doApply) { console.log('\nDRY-RUN — pass --apply to write.'); return; }
  copyFileSync(P.appsFile, P.appsFile + '.backup-' + TODAY);
  writeFileSync(P.appsFile, lines.join('\n'));
  console.log(`\nWrote ${flips.length} flips to ${P.appsFile} (backup kept).`);
}

const AGE_DAYS = 21;
const APPLY_TIER = 4.0;

function agePurge(doApply) {
  const cutoff = new Date(Date.now() - AGE_DAYS * 86400000).toISOString().slice(0, 10);
  const { lines, rows } = parseRows();
  const flips = [];
  for (const r of rows) {
    if (r.status !== 'Evaluated') continue;
    const date = r.cells[2].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.warn(`WARN row ${r.num}: unparseable date "${date}" — kept`); continue; }
    if (date > cutoff) continue;
    const score = parseFloat(r.cells[5]);
    if (isNaN(score)) { console.warn(`WARN row ${r.num}: unparseable score "${r.cells[5].trim()}" — kept`); continue; }
    if (score >= APPLY_TIER) continue;
    flips.push(`${r.num}\t${date}\t${r.cells[5].trim()}\t${r.company}\t${r.role}`);
    r.cells[6] = ' Purged ';
    const note = ` Age purge ${TODAY}: evaluated ${date}, not applied within ${AGE_DAYS}d.`;
    r.cells[9] = r.cells[9].replace(/\s*$/, '') + note + ' ';
    lines[r.lineIdx] = r.cells.join('|');
    if (doApply) {
      const rp = (r.report.match(/\(([^)]+\.md)\)/) || [])[1];
      if (rp && existsSync(join(P.target, rp))) {
        const text = readFileSync(join(P.target, rp), 'utf-8');
        if (text.includes('**Status:** Evaluated')) {
          writeFileSync(join(P.target, rp), text.replace('**Status:** Evaluated', '**Status:** Purged'));
        }
      }
    }
  }
  console.log(`cutoff ${cutoff} (evaluated ${AGE_DAYS}+ days ago, score < ${APPLY_TIER}):`);
  console.log(flips.length ? `#row\teval-date\tscore\tcompany\trole\n${flips.join('\n')}` : 'no rows to purge');
  if (!doApply) { console.log('\nDRY-RUN — pass --apply to write.'); return; }
  copyFileSync(P.appsFile, P.appsFile + '.backup-' + TODAY);
  writeFileSync(P.appsFile, lines.join('\n'));
  console.log(`\nWrote ${flips.length} flips to ${P.appsFile} (backup kept).`);
}

const [cmd, a, b] = process.argv.slice(2).filter(x => x !== '--apply');
if (cmd === 'extract' && a && b) extract(a, b);
else if (cmd === 'apply' && a && b) apply(a, b, process.argv.includes('--apply'));
else if (cmd === 'age') agePurge(process.argv.includes('--apply'));
else {
  console.error('Usage:\n  node hygiene-sweep.mjs extract <urls.txt> <map.tsv>\n  node hygiene-sweep.mjs apply <map.tsv> <liveness.tsv> [--apply]\n  node hygiene-sweep.mjs age [--apply]');
  process.exit(1);
}
