#!/usr/bin/env node
/**
 * split-tsv-for-merge.mjs
 *
 * Split multi-row TSVs in batch/tracker-additions/merged/ into single-row
 * TSV files (one row per file), so merge-tracker.mjs can consume them.
 * Skips rows whose tracker-number is already present in data/applications.md.
 *
 * Output: single-row TSVs back in batch/tracker-additions/, named
 * gmail-<source>-row-<num>.tsv
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolvePaths } from '../lib/paths.mjs';
const P = resolvePaths(import.meta.url);
const APPS_FILE = P.appsFile;
const MERGED_DIR = join(P.batchDir('tracker-additions'), 'merged');
const ADDITIONS_DIR = P.batchDir('tracker-additions');

if (!existsSync(MERGED_DIR)) {
  console.error('No merged dir.');
  process.exit(1);
}

// Find existing tracker nums
const appContent = readFileSync(APPS_FILE, 'utf-8');
const usedNums = new Set();
for (const line of appContent.split('\n')) {
  if (!line.startsWith('|')) continue;
  const parts = line.split('|').map(s => s.trim());
  const n = parseInt(parts[1]);
  if (!isNaN(n)) usedNums.add(n);
}
console.error(`📊 Existing tracker has ${usedNums.size} rows`);

let totalRows = 0;
let skipped = 0;
let written = 0;

for (const file of readdirSync(MERGED_DIR).filter(f => f.endsWith('.tsv'))) {
  // Extract source name from gmail-<source>-<date>.tsv
  const m = file.match(/^gmail-([\w-]+)-\d{4}-\d{2}-\d{2}\.tsv$/);
  if (!m) {
    console.warn(`⚠️  Skipping ${file} (unexpected name)`);
    continue;
  }
  const source = m[1];
  const lines = readFileSync(join(MERGED_DIR, file), 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    totalRows++;
    const parts = line.split('\t');
    if (parts.length < 9) {
      console.warn(`⚠️  Malformed row in ${file}: ${line.slice(0, 80)}`);
      continue;
    }
    const num = parseInt(parts[0]);
    if (isNaN(num)) continue;
    if (usedNums.has(num)) {
      skipped++;
      continue;
    }
    const outPath = join(ADDITIONS_DIR, `gmail-${source}-row-${num}.tsv`);
    writeFileSync(outPath, line + '\n');
    written++;
  }
}

console.error(`✏️  Split ${totalRows} rows: ${written} written, ${skipped} skipped (already in tracker)`);
