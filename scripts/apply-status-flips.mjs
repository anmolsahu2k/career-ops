#!/usr/bin/env node
/**
 * apply-status-flips.mjs
 *
 * Apply proposed status flips from batch/status-flips/*.tsv to data/applications.md.
 *
 * TSV columns (header row starts with #):
 *   tracker_row, current_company, current_role, current_status, new_status,
 *   rejection_date, rejection_reason, msg_id, confidence,
 *   parsed_company, parsed_role
 *
 * Dedup: if multiple flips target the same tracker_row, the latest
 * rejection_date wins. Each flip updates the row's Status column and
 * appends a "Rejected: <date> - <reason>" snippet to the Notes column.
 *
 * Default mode is DRY-RUN. Pass --apply to write changes to applications.md.
 */

import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';
import { resolvePaths } from '../lib/paths.mjs';
const P = resolvePaths(import.meta.url);
const APPS_FILE = P.appsFile;
const FLIPS_DIR = P.batchDir('status-flips');
const BACKUP = APPS_FILE + '.backup-' + new Date().toISOString().slice(0, 10);

const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;

if (!existsSync(FLIPS_DIR)) {
  console.error(`No flips dir at ${FLIPS_DIR}`);
  process.exit(1);
}

const tsvFiles = readdirSync(FLIPS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.error('No flip TSVs to process.');
  process.exit(0);
}

// Collect flips
const flipsByRow = new Map(); // row_num -> { new_status, rejection_date, rejection_reason, msg_id }
for (const f of tsvFiles) {
  const content = readFileSync(join(FLIPS_DIR, f), 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) {
      console.warn(`⚠️  Skipping malformed line: ${line.slice(0, 100)}`);
      continue;
    }
    const row = parseInt(parts[0]);
    if (isNaN(row)) continue;
    const proposed = {
      new_status: parts[4],
      rejection_date: parts[5],
      rejection_reason: parts[6] || '',
      msg_id: parts[7] || '',
      confidence: parts[8] || '',
      parsed_company: parts[9] || '',
      parsed_role: parts[10] || '',
    };
    const existing = flipsByRow.get(row);
    if (!existing || (proposed.rejection_date > existing.rejection_date)) {
      flipsByRow.set(row, proposed);
    }
  }
}

console.error(`📥 Loaded ${flipsByRow.size} unique flips from ${tsvFiles.length} TSV(s)`);

// Read applications.md
const appContent = readFileSync(APPS_FILE, 'utf-8');
const lines = appContent.split('\n');

let updated = 0;
let notFound = 0;
const examples = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('|')) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 10) continue;
  const num = parseInt(parts[1]);
  if (isNaN(num)) continue;

  const flip = flipsByRow.get(num);
  if (!flip) continue;

  const currentStatus = parts[6];
  if (currentStatus === flip.new_status) {
    // already at target state
    continue;
  }

  // Build new line: same parts but status (parts[6]) becomes new_status,
  // and notes (parts[9]) gets a Rejected: snippet appended.
  const snippet = `Rejected ${flip.rejection_date}` +
    (flip.rejection_reason ? `: ${flip.rejection_reason.replace(/\|/g, '/').slice(0, 140)}` : '') +
    ` (gmail ${flip.msg_id})`;
  const newNotes = parts[9] ? `${parts[9]} | ${snippet}` : snippet;

  const newParts = [
    parts[0], // empty before first |
    parts[1], // num
    parts[2], // date
    parts[3], // company
    parts[4], // role
    parts[5], // score
    flip.new_status,
    parts[7], // pdf
    parts[8], // report
    newNotes,
    parts[10] || '', // trailing empty
  ];
  // Reconstruct with " | " separators, preserving leading/trailing pipes
  const newLine = '| ' + newParts.slice(1, 10).join(' | ') + ' |';
  if (DRY) {
    if (examples.length < 5) {
      examples.push({ num, currentStatus, newStatus: flip.new_status, snippet });
    }
  } else {
    lines[i] = newLine;
  }
  updated++;
  flipsByRow.delete(num);
}

notFound = flipsByRow.size;
const unmatched = Array.from(flipsByRow.entries()).map(([k, v]) => ({ row: k, ...v }));

console.error('');
console.error('═══════════════════════════════════════════');
console.error(`Mode:     ${DRY ? 'DRY RUN' : 'APPLY'}`);
console.error(`Updated:  ${updated} rows`);
console.error(`Not found: ${notFound} flips with no matching tracker row`);
if (examples.length) {
  console.error(``);
  console.error(`Sample changes:`);
  for (const e of examples) {
    console.error(`  #${e.num}: ${e.currentStatus} → ${e.newStatus}`);
    console.error(`    Note appended: ${e.snippet.slice(0, 120)}`);
  }
}
if (unmatched.length) {
  console.error(``);
  console.error(`Unmatched (first 5):`);
  for (const u of unmatched.slice(0, 5)) {
    console.error(`  row ${u.row}: ${u.parsed_company} / ${u.parsed_role} (rej ${u.rejection_date})`);
  }
}
console.error('═══════════════════════════════════════════');

if (APPLY && updated > 0) {
  copyFileSync(APPS_FILE, BACKUP);
  console.error(`💾 Backup → ${BACKUP}`);
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.error(`✏️  Wrote ${APPS_FILE}`);
}
