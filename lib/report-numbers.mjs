// lib/report-numbers.mjs — the single row/report number space.
//
// Since the 2026-07-27 reconciliation, tracker row numbers, report file
// prefixes, and batch-TSV numbers all live in ONE space and must never
// collide. Every allocator (reserve-report-num.mjs, gmail-sweep-merge.mjs,
// scripts/aggregator-intake.py via discovery_filters.next_available_nn)
// derives its next number from the union of these three scans.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

/** Row numbers from column 1 of applications.md. */
export function trackerNumbers(appsFile) {
  const taken = new Set();
  if (!existsSync(appsFile)) return taken;
  for (const line of readFileSync(appsFile, 'utf-8').split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (m) taken.add(parseInt(m[1], 10));
  }
  return taken;
}

/** Leading NNN of every report file or RESERVED sentinel in the reports tree
 *  (flat entries plus one level of company folders). */
export function reportTreeNumbers(reportsDir) {
  const taken = new Set();
  if (!existsSync(reportsDir)) return taken;
  for (const ent of readdirSync(reportsDir, { withFileTypes: true })) {
    const m = ent.name.match(/^(\d+)-/);
    if (m) taken.add(parseInt(m[1], 10));
    if (ent.isDirectory()) {
      for (const inner of readdirSync(join(reportsDir, ent.name))) {
        const im = inner.match(/^(\d+)-/);
        if (im) taken.add(parseInt(im[1], 10));
      }
    }
  }
  return taken;
}

/** Leading NNN of every un-merged batch TSV under batch/ (recursive:
 *  tracker-additions/, backlog dirs), skipping merged/ folders whose
 *  numbers were already absorbed into the tracker. */
export function batchTsvNumbers(batchRoot) {
  const taken = new Set();
  if (!existsSync(batchRoot)) return taken;
  const scanDir = dir => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (ent.name === 'merged') continue;
        scanDir(join(dir, ent.name));
      } else if (ent.name.endsWith('.tsv')) {
        const m = ent.name.match(/^(\d+)-/);
        if (m) taken.add(parseInt(m[1], 10));
      }
    }
  };
  scanDir(batchRoot);
  return taken;
}

/** Union of all three scans — the full occupied set of the one number space. */
export function allTakenNumbers({ appsFile, reportsDir, batchRoot }) {
  const taken = trackerNumbers(appsFile);
  for (const n of reportTreeNumbers(reportsDir)) taken.add(n);
  for (const n of batchTsvNumbers(batchRoot)) taken.add(n);
  return taken;
}
