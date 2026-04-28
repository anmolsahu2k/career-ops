#!/usr/bin/env node
/**
 * weekly-news-cron.mjs
 *
 * W8 of career-ops Phase 3. Runs every Sunday evening Pittsburgh time
 * (recommended cron: `0 18 * * 0` with timezone "America/New_York").
 *
 * Two-step design (cron has no LLM):
 *
 *   STEP A (this script, deterministic):
 *     1. Read career-ops/data/applications.md (9-col tracker, FROZEN schema).
 *     2. Filter to rows whose Status column equals "Applied".
 *     3. Build a per-company manifest of search queries plus an empty
 *        outreach-hook placeholder.
 *     4. Write two artifacts under career-ops/data/:
 *          - news-tasks-{YYYY-Www}.md   (work queue for the next agent run)
 *          - news-digest-{YYYY-Www}.md  (final digest, template only at
 *                                        cron-fire time; agent fills it in)
 *     5. Idempotent: if a file for the current ISO week already exists, the
 *        script appends a "Re-run" stanza instead of overwriting.
 *
 *   STEP B (manual / future agent run, NOT this script):
 *     A human or an agent (with WebSearch + WebFetch) reads the manifest,
 *     runs the queries, and fills in the outreach hook + source URLs in
 *     news-digest-{YYYY-Www}.md. The hooks are then used for follow-up
 *     touches on applications silent more than 7 days.
 *
 * Flags:
 *   --dry-run   Print the manifest preview to stdout. Do not write files.
 *
 * Constraints (project hard rules):
 *   - No em-dashes or en-dashes anywhere.
 *   - No CV PDF generation.
 *   - No F-1 / CPT / Heinz / OIE / visa explainer text.
 *   - Stdlib only.
 *   - process.env.TZ set to America/New_York for any date math.
 */

process.env.TZ = 'America/New_York';

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// career-ops root is parent of scripts/
const CAREER_OPS_ROOT = resolve(__dirname, '..');
const TRACKER_PATH = join(CAREER_OPS_ROOT, 'data', 'applications.md');
const DATA_DIR = join(CAREER_OPS_ROOT, 'data');

// ---------- ISO week helpers ----------

/**
 * Returns [isoYear, isoWeek] for the given Date, per ISO 8601.
 * Vendored from the standard algorithm (no external deps).
 */
function isoWeek(date) {
  // Copy date so we do not mutate the caller's value.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // ISO weekday: Monday=1, Sunday=7
  const dayNum = d.getUTCDay() || 7;
  // Shift to nearest Thursday (current date plus 4 minus dayNum)
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return [isoYear, weekNo];
}

function isoWeekTag(date) {
  const [y, w] = isoWeek(date);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

function todayIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------- Tracker parser ----------

/**
 * Parses the 9-col applications.md tracker. Returns array of row objects.
 *
 * Schema (FROZEN):
 *   | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
 *
 * Rows are markdown table lines starting with "|". Header and separator
 * lines are skipped. Cells are trimmed.
 */
function parseTracker(markdown) {
  const lines = markdown.split('\n');
  const rows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // Skip separator lines like |---|---|...
    if (/^\|\s*-+/.test(trimmed)) continue;

    // Split on pipe, drop the empty leading/trailing cells.
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 9) continue;

    const [num, date, company, role, score, status, pdf, report, notes] = cells;
    // Skip the header row (starts with literal "#").
    if (num === '#' || /^#\s*$/.test(num)) continue;
    if (!/^\d+$/.test(num)) continue;

    rows.push({
      num: Number(num),
      date,
      company,
      role,
      score,
      status,
      pdf,
      report,
      notes,
    });
  }

  return rows;
}

// ---------- Query builder ----------

function buildQueries(company) {
  // Three angles: funding/business, product launch, engineering blog.
  // Use literal newlines, no em-dash or en-dash.
  return [
    `site:techcrunch.com OR site:bloomberg.com "${company}" funding 2026`,
    `"${company}" "product launch" OR "we are launching" 2026`,
    `"${company}" engineering blog OR "we built" OR "behind the scenes" 2026`,
  ];
}

// ---------- Manifest renderer ----------

function renderDigest({ weekTag, sundayDate, applied }) {
  const lines = [];
  lines.push(`# News Digest, Week ${weekTag} (Sunday ${sundayDate})`);
  lines.push('');
  lines.push(`Generated by weekly-news-cron.mjs at cron-fire time. Search`);
  lines.push(`results and outreach hooks are filled in by a downstream agent`);
  lines.push(`run (with WebSearch + WebFetch) using the queries below.`);
  lines.push('');
  lines.push('## Per-company tasks');
  lines.push('');

  for (const row of applied) {
    const queries = buildQueries(row.company);
    lines.push(`### ${row.company}, ${row.role}, applied ${row.date}`);
    lines.push('');
    lines.push(`- Tracker row: #${row.num}`);
    lines.push(`- Status: needs research`);
    lines.push(`- Search queries:`);
    queries.forEach((q, idx) => {
      lines.push(`  ${idx + 1}. ${q}`);
    });
    lines.push(`- Outreach hook: TBD (agent to fill, 2 to 3 sentences, alumni-outreach.md tone)`);
    lines.push(`- Source URL(s): TBD`);
    lines.push('');
  }

  lines.push('## Aggregate');
  lines.push('');
  lines.push(`- Companies queued: ${applied.length}`);
  lines.push(`- Companies with news (after research): TBD`);
  lines.push(`- Use these hooks for follow-up touches on applications silent more than 7 days.`);
  lines.push('');

  return lines.join('\n');
}

function renderTasks({ weekTag, sundayDate, applied }) {
  // The tasks file is a slimmer work-queue view. Same data, different shape.
  const lines = [];
  lines.push(`# News Tasks, Week ${weekTag} (Sunday ${sundayDate})`);
  lines.push('');
  lines.push(`Work queue for the downstream agent run. One section per`);
  lines.push(`company in Applied status. Run the search queries, then fill`);
  lines.push(`the corresponding entry in news-digest-${weekTag}.md.`);
  lines.push('');

  for (const row of applied) {
    const queries = buildQueries(row.company);
    lines.push(`## ${row.company}`);
    lines.push(`- Role: ${row.role}`);
    lines.push(`- Applied: ${row.date}`);
    lines.push(`- Tracker row: #${row.num}`);
    lines.push(`- Report: ${row.report}`);
    lines.push(`- Queries:`);
    queries.forEach((q, idx) => {
      lines.push(`  ${idx + 1}. ${q}`);
    });
    lines.push('');
  }

  lines.push(`Total companies queued: ${applied.length}`);
  lines.push('');
  return lines.join('\n');
}

function renderRerunStanza({ runIso }) {
  return [
    '',
    `## Re-run on ${runIso}`,
    '',
    `Cron fired again for the same ISO week. Original digest preserved`,
    `above. If new Applied-status rows have appeared in the tracker since`,
    `the first run, an agent should diff against the per-company task list`,
    `and add any missing companies.`,
    '',
  ].join('\n');
}

// ---------- Main ----------

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');

  // Read tracker.
  if (!existsSync(TRACKER_PATH)) {
    console.error(`Tracker not found: ${TRACKER_PATH}`);
    process.exit(2);
  }
  const trackerSrc = readFileSync(TRACKER_PATH, 'utf8');
  const rows = parseTracker(trackerSrc);
  const applied = rows.filter((r) => r.status === 'Applied');

  const now = new Date();
  const weekTag = isoWeekTag(now);
  const sundayDate = todayIso(now);

  const digest = renderDigest({ weekTag, sundayDate, applied });
  const tasks = renderTasks({ weekTag, sundayDate, applied });

  const digestPath = join(DATA_DIR, `news-digest-${weekTag}.md`);
  const tasksPath = join(DATA_DIR, `news-tasks-${weekTag}.md`);

  if (dryRun) {
    console.log(`# DRY RUN, week ${weekTag}, Sunday ${sundayDate}`);
    console.log(`# Tracker: ${TRACKER_PATH}`);
    console.log(`# Total rows parsed: ${rows.length}`);
    console.log(`# Applied rows: ${applied.length}`);
    console.log(`# Would write: ${digestPath}`);
    console.log(`# Would write: ${tasksPath}`);
    console.log('# ---- digest preview ----');
    console.log(digest);
    return;
  }

  // Idempotent write: if exists, append a Re-run stanza.
  for (const [path, content] of [
    [digestPath, digest],
    [tasksPath, tasks],
  ]) {
    if (existsSync(path)) {
      appendFileSync(path, renderRerunStanza({ runIso: sundayDate }));
      console.log(`appended Re-run stanza to ${path}`);
    } else {
      writeFileSync(path, content, 'utf8');
      console.log(`wrote ${path}`);
    }
  }

  console.log(`done. companies queued: ${applied.length}`);
}

main();
