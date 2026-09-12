#!/usr/bin/env node
// backfill-status-buckets.mjs — split the legacy `Discarded` bucket into the
// three statuses defined in templates/states.yml (decided 2026-08-12).
//
//   Discarded        the candidate's own call, made by hand (dashboard `d` key)
//   Purged           removed mechanically: dead posting or past the shelf life
//   Rejected-at-eval an eval agent judged the role not a fit on the merits
//
// Before this migration every one of those wrote `Discarded`, so the Discarded
// tab was ~500 rows of mostly machine output and the user's own decisions were
// invisible in it.
//
// Classification is by the *exact machine-written audit string* each sweep
// leaves in Notes, and nothing else:
//
//   "Liveness sweep {date}: expired (...)"                  hygiene-sweep apply
//   "Age purge {date}: evaluated ..."                       hygiene-sweep age
//   "AUTO-DISCARDED {date} (liveness check: URL expired)"   prune-by-liveness
//   "auto-discarded {date} (>Nd stale)"                     dashboard --expire-days
//
// Prose is deliberately NOT pattern-matched. An earlier draft also treated
// STALE-REQ and phrases like "posting dead" as mechanical, and it misfiled
// five merit verdicts (row 3173's QGIS experience gap, 3175's Zurich-only
// geography) as Purged because those words appear in an agent's reasoning.
// A token a machine wrote is evidence; a word an agent used is not.
//
// Everything else that is currently `Discarded` becomes `Rejected-at-eval`,
// including the ~190 title-filter "off-target:" rows that never got a report:
// deciding a GIS analyst req is not an SWE role is still a verdict about the
// role. That leaves `Discarded` empty, which is the point — from here it only
// fills with rows the user flips by hand.
//
// Report files linked from a migrated row get their `**Status:**` header
// rewritten to match, so the tracker and the report never disagree.
//
// Idempotent: rows already carrying a new status are left alone, so re-running
// is a no-op. DRY-RUN by default.
//
// Usage: node backfill-status-buckets.mjs [--apply]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from './lib/paths.mjs';

const P = resolvePaths(import.meta.url);
const TODAY = new Date().toISOString().slice(0, 10);
const doApply = process.argv.includes('--apply');

/** Exact audit strings written by each automated sweep. Order is irrelevant; they never co-occur. */
const SWEEP_TOKENS = [
  [/Liveness sweep \d{4}-\d{2}-\d{2}: expired/, 'hygiene-sweep liveness'],
  [/Age purge \d{4}-\d{2}-\d{2}:/, 'hygiene-sweep age'],
  [/AUTO-DISCARDED \d{4}-\d{2}-\d{2} \(liveness check: URL expired\)/, 'prune-by-liveness'],
  [/auto-discarded \d{4}-\d{2}-\d{2} \(>\d+d stale\)/, 'dashboard --expire-days'],
];

const lines = readFileSync(P.appsFile, 'utf-8').split('\n');
const changes = [];
const byWriter = {};

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('|') || /^\|\s*(#|-)/.test(line)) continue;
  const cells = line.split('|');
  if (cells.length !== 11) continue;
  if (cells[6].trim() !== 'Discarded') continue;

  const notes = cells[9];
  let writer = null;
  for (const [re, name] of SWEEP_TOKENS) {
    if (re.test(notes)) { writer = name; break; }
  }
  const next = writer ? 'Purged' : 'Rejected-at-eval';
  byWriter[writer || 'agent verdict'] = (byWriter[writer || 'agent verdict'] || 0) + 1;

  cells[6] = ` ${next} `;
  lines[i] = cells.join('|');
  const reportPath = (cells[8].match(/\(([^)]+\.md)\)/) || [])[1] || '';
  changes.push({ num: cells[1].trim(), company: cells[3].trim(), next, reportPath });
}

console.log(`Discarded rows migrated: ${changes.length}`);
for (const [k, v] of Object.entries(byWriter)) console.log(`  ${k.padEnd(24)} ${v}`);
console.log(`  -> Purged: ${changes.filter((c) => c.next === 'Purged').length}`);
console.log(`  -> Rejected-at-eval: ${changes.filter((c) => c.next === 'Rejected-at-eval').length}`);

// Report headers. Only rewrite a header that currently reads Discarded: a
// report saying something else is out of sync for a reason this script did not
// create and must not paper over.
let headersFixed = 0;
let headersSkipped = 0;
for (const c of changes) {
  if (!c.reportPath) continue;
  const abs = join(P.target, c.reportPath);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, 'utf-8');
  if (!/\*\*Status:\*\*\s*Discarded/.test(text)) { headersSkipped++; continue; }
  headersFixed++;
  if (doApply) {
    writeFileSync(abs, text.replace(/(\*\*Status:\*\*\s*)Discarded/, `$1${c.next}`));
  }
}
console.log(`report headers: ${headersFixed} rewritten, ${headersSkipped} left alone (header was not "Discarded")`);

if (!doApply) {
  console.log('\nDRY-RUN — pass --apply to write.');
  process.exit(0);
}
copyFileSync(P.appsFile, `${P.appsFile}.pre-status-buckets-${TODAY}.bak`);
writeFileSync(P.appsFile, lines.join('\n'));
console.log(`\nWrote ${changes.length} status flips to ${P.appsFile} (backup kept).`);
