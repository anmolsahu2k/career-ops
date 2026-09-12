#!/usr/bin/env node
/**
 * backfill-unevaluated-to-triage.mjs
 *
 * Demote tracker rows that never received a real A-G evaluation out of
 * applications.md and into the scan-results triage handoff.
 *
 * A row is unevaluated when its Report cell points at reports/pending.md
 * (the discovery placeholder stub). Those rows may stay in triage; they
 * must not remain in the curated tracker.
 *
 * Usage:
 *   node backfill-unevaluated-to-triage.mjs --dry-run
 *   node backfill-unevaluated-to-triage.mjs --apply
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolvePaths } from './lib/paths.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');
if (!DRY_RUN && !APPLY) {
  console.error('Usage: node backfill-unevaluated-to-triage.mjs --dry-run | --apply');
  process.exit(2);
}

const P = resolvePaths(import.meta.url);
const APPS = P.appsFile;
const DATA = P.dataDir;
const today = new Date().toISOString().slice(0, 10);
const triagePath = join(DATA, `scan-results-${today}.tsv`);
const rollbackPath = join(DATA, `applications.md.rollback-unevaluated-${today}`);

function extractUrl(notes) {
  const m = String(notes || '').match(/URL:\s*(\S+)/i);
  if (!m) return '';
  return m[1].replace(/[.,;)]+$/, '');
}

function extractSource(notes) {
  const text = String(notes || '');
  const agg = text.match(/Aggregator discovery via\s+([^\s.]+)/i);
  if (agg) return agg[1];
  const disc = text.match(/Discovery via\s+([^\s.]+)/i);
  if (disc) return disc[1];
  return 'backfill-unevaluated';
}

const raw = readFileSync(APPS, 'utf8');
const lines = raw.split(/\r?\n/);
const kept = [];
const demoted = [];
let headerZone = true;

for (const line of lines) {
  if (!/^\|\s*\d+\s*\|/.test(line)) {
    kept.push(line);
    continue;
  }
  headerZone = false;
  const cols = line.split('|').map(s => s.trim());
  // | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
  const report = cols[8] || '';
  if (!report.includes('pending.md')) {
    kept.push(line);
    continue;
  }
  const notes = cols[9] || '';
  const url = extractUrl(notes);
  if (!url) {
    console.warn(`skip #${cols[1]}: pending.md but no URL in Notes`);
    kept.push(line);
    continue;
  }
  demoted.push({
    num: cols[1],
    date: cols[2],
    company: cols[3],
    role: cols[4],
    url,
    source: extractSource(notes),
  });
}

console.log(`Tracker rows demoted: ${demoted.length}`);
console.log(`Tracker rows kept: ${kept.filter(l => /^\|\s*\d+\s*\|/.test(l)).length}`);
console.log(`Triage file: ${triagePath}`);

if (DRY_RUN) {
  for (const row of demoted.slice(0, 10)) {
    console.log(`  would triage #${row.num}: ${row.company} | ${row.role}`);
  }
  if (demoted.length > 10) console.log(`  ... and ${demoted.length - 10} more`);
  process.exit(0);
}

mkdirSync(DATA, { recursive: true });
copyFileSync(APPS, rollbackPath);

const existingUrls = new Set();
let triageBody = '';
if (existsSync(triagePath)) {
  const existing = readFileSync(triagePath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of existing.slice(1)) {
    const url = line.split('\t')[0];
    if (url) existingUrls.add(url);
  }
  triageBody = existing.slice(1).filter(Boolean).join('\n');
  if (triageBody) triageBody += '\n';
}

const additions = [];
for (const row of demoted) {
  if (existingUrls.has(row.url)) continue;
  existingUrls.add(row.url);
  additions.push([row.url, row.company, row.role, '', row.source].join('\t'));
}

const triageText = `url\tcompany\ttitle\tlocation\tsource\n${triageBody}${additions.join('\n')}${additions.length ? '\n' : ''}`;
writeFileSync(triagePath, triageText, 'utf8');

// Preserve trailing newline style of original tracker when possible.
const nextApps = kept.join('\n').replace(/\n+$/, '\n');
writeFileSync(APPS, nextApps, 'utf8');

console.log(`Wrote ${additions.length} triage rows (deduped against existing handoff)`);
console.log(`Rollback copy: ${rollbackPath}`);
console.log('Done. Unevaluated rows are in scan-results triage; re-run eval to promote survivors.');
