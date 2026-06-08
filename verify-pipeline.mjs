#!/usr/bin/env node
/**
 * verify-pipeline.mjs — Health check for career-ops pipeline integrity
 *
 * Checks:
 * 1. All statuses are canonical (per states.yml)
 * 2. No duplicate company+role entries
 * 3. All report links point to existing files
 * 4. Scores match format X.XX/5 or N/A or DUP
 * 5. All rows have proper pipe-delimited format
 * 6. No pending TSVs in tracker-additions/ (only in merged/ or archived/)
 * 7. states.yml canonical IDs for cross-system consistency
 *
 * Run: node career-ops/verify-pipeline.mjs
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolvePaths } from './lib/paths.mjs';
const P = resolvePaths(import.meta.url);
const REPO_ROOT = P.root;       // shared config (portals.yml, templates/states.yml)
const TARGET_ROOT = P.target;   // report-link resolution base
const APPS_FILE = P.appsFile;
const ADDITIONS_DIR = P.batchDir('tracker-additions');
const REPORTS_DIR = P.reportsDir;
const STATES_FILE = P.statesFile;   // shared, always root/templates/states.yml

// Ensure required directories exist (fresh setup)
mkdirSync(P.dataDir, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

// SKIP removed 2026-05-10 — legacy term migrated to Discarded across the tracker.
// Anything still emitting SKIP is a bug; flag it as an error.
const CANONICAL_STATUSES = [
  'triaged', 'evaluated', 'applied', 'responded', 'interview',
  'offer', 'rejected', 'discarded',
];

const ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated', 'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied', 'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'descartado': 'discarded', 'descartada': 'discarded', 'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
};

let errors = 0;
let warnings = 0;

function error(msg) { console.log(`❌ ${msg}`); errors++; }
function warn(msg) { console.log(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }

// --- Read applications.md ---
if (!existsSync(APPS_FILE)) {
  console.log('\n📊 No applications.md found. This is normal for a fresh setup.');
  console.log('   The file will be created when you evaluate your first offer.\n');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

const entries = [];
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) continue;
  const num = parseInt(parts[1]);
  if (isNaN(num)) continue;
  entries.push({
    num, date: parts[2], company: parts[3], role: parts[4],
    score: parts[5], status: parts[6], pdf: parts[7], report: parts[8],
    notes: parts[9] || '',
  });
}

console.log(`\n📊 Checking ${entries.length} entries in applications.md\n`);

// --- Check 1: Canonical statuses ---
let badStatuses = 0;
for (const e of entries) {
  const clean = e.status.replace(/\*\*/g, '').trim().toLowerCase();
  // Strip trailing dates
  const statusOnly = clean.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();

  if (!CANONICAL_STATUSES.includes(statusOnly) && !ALIASES[statusOnly]) {
    error(`#${e.num}: Non-canonical status "${e.status}"`);
    badStatuses++;
  }

  // Check for markdown bold in status
  if (e.status.includes('**')) {
    error(`#${e.num}: Status contains markdown bold: "${e.status}"`);
    badStatuses++;
  }

  // Check for dates in status
  if (/\d{4}-\d{2}-\d{2}/.test(e.status)) {
    error(`#${e.num}: Status contains date: "${e.status}" — dates go in date column`);
    badStatuses++;
  }
}
if (badStatuses === 0) ok('All statuses are canonical');

// --- Check 2: Duplicates ---
const companyRoleMap = new Map();
let dupes = 0;
for (const e of entries) {
  const key = e.company.toLowerCase().replace(/[^a-z0-9]/g, '') + '::' +
    e.role.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (!companyRoleMap.has(key)) companyRoleMap.set(key, []);
  companyRoleMap.get(key).push(e);
}
for (const [key, group] of companyRoleMap) {
  if (group.length > 1) {
    warn(`Possible duplicates: ${group.map(e => `#${e.num}`).join(', ')} (${group[0].company} — ${group[0].role})`);
    dupes++;
  }
}
if (dupes === 0) ok('No exact duplicates found');

// --- Check 3: Report links ---
let brokenReports = 0;
for (const e of entries) {
  const match = e.report.match(/\]\(([^)]+)\)/);
  if (!match) continue;
  const reportPath = join(TARGET_ROOT, match[1]);
  if (!existsSync(reportPath)) {
    error(`#${e.num}: Report not found: ${match[1]}`);
    brokenReports++;
  }
}
if (brokenReports === 0) ok('All report links valid');

// --- Check 4: Score format ---
let badScores = 0;
for (const e of entries) {
  const s = e.score.replace(/\*\*/g, '').trim();
  if (!/^\d+\.?\d*\/5$/.test(s) && s !== 'N/A' && s !== 'DUP') {
    error(`#${e.num}: Invalid score format: "${e.score}"`);
    badScores++;
  }
}
if (badScores === 0) ok('All scores valid');

// --- Check 5: Row format ---
let badRows = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (line.includes('---') || line.includes('Empresa')) continue;
  const parts = line.split('|');
  if (parts.length < 9) {
    error(`Row with <9 columns: ${line.substring(0, 80)}...`);
    badRows++;
  }
}
if (badRows === 0) ok('All rows properly formatted');

// --- Check 6: Pending TSVs ---
let pendingTsvs = 0;
if (existsSync(ADDITIONS_DIR)) {
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  pendingTsvs = files.length;
  if (pendingTsvs > 0) {
    warn(`${pendingTsvs} pending TSVs in tracker-additions/ (not merged)`);
  }
}
if (pendingTsvs === 0) ok('No pending TSVs');

// --- Check 7: Bold in scores ---
let boldScores = 0;
for (const e of entries) {
  if (e.score.includes('**')) {
    warn(`#${e.num}: Score has markdown bold: "${e.score}"`);
    boldScores++;
  }
}
if (boldScores === 0) ok('No bold in scores');

// --- Check 8: Required headers in eval reports (Issue 13 prevention) ---
// Per modes/_shared.md rule 11, every eval report must have **URL:** and **Resume:**
let missingUrlHeader = 0;
let missingResumeHeader = 0;
function walkReports(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '_misc') continue;
      out.push(...walkReports(p));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Eval reports only — skip CL / Q files / pending stub
      if (entry.name.includes('-cover-letter') ||
          entry.name.includes('-application-questions') ||
          entry.name.includes('-application-answers') ||
          entry.name.includes('-form-answers') ||
          entry.name === 'pending.md') continue;
      if (!/^\d+-/.test(entry.name)) continue;
      out.push(p);
    }
  }
  return out;
}
const evalReports = walkReports(REPORTS_DIR);
for (const path of evalReports) {
  const body = readFileSync(path, 'utf-8');
  if (!/^\*\*URL:\*\*/m.test(body)) {
    warn(`${path.replace(TARGET_ROOT + '/', '')}: missing **URL:** header (dashboard O-key won't work)`);
    missingUrlHeader++;
  }
  if (!/^\*\*Resume:\*\*/m.test(body)) {
    warn(`${path.replace(TARGET_ROOT + '/', '')}: missing **Resume:** header (per modes/_shared.md rule 11)`);
    missingResumeHeader++;
  }
}
if (missingUrlHeader === 0) ok(`All ${evalReports.length} eval reports have **URL:** header`);
if (missingResumeHeader === 0) ok(`All ${evalReports.length} eval reports have **Resume:** header`);

// --- Check 9: Tracker date == report file date (Issue 12 prevention) ---
// Only enforced for pre-apply rows. Post-apply rows (Applied/Responded/
// Interview/Offer/Rejected) carry the apply-day stamp in their Date column
// — the dashboard rewrites it on status transition so the Progress chart
// attributes activity to the actual apply day. For those rows, Date != file
// date is expected and correct.
const PRE_APPLY = new Set(['triaged', 'evaluated', 'discarded']);
let dateMismatches = 0;
for (const e of entries) {
  const m = e.report.match(/reports\/[^/]+\/\d+-.+?-(\d{4}-\d{2}-\d{2})\.md/);
  if (!m) continue;
  const norm = e.status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim().toLowerCase();
  if (!PRE_APPLY.has(norm)) continue;  // post-apply: skip the check
  if (m[1] !== e.date) {
    warn(`#${e.num}: tracker Date=${e.date} but report file=${m[1]} (pre-apply row, dates should match)`);
    dateMismatches++;
  }
}
if (dateMismatches === 0) ok('Tracker Date matches report file date on all pre-apply rows');

// --- Check 10: Orphan cover letters / Q-files (Issues 6+8 prevention) ---
let orphanCls = 0;
let orphanQs = 0;
const referencedCls = new Set();
const referencedQs = new Set();
for (const e of entries) {
  for (const m of e.notes.matchAll(/\(reports\/[^)]+-cover-letter\.md\)/g)) {
    referencedCls.add(m[0].slice(1, -1));
  }
  for (const m of e.notes.matchAll(/\(reports\/[^)]+(?:-application-questions|-application-answers|-form-answers)\.md\)/g)) {
    referencedQs.add(m[0].slice(1, -1));
  }
}
function walkSpecial(dir, suffixRe) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSpecial(p, suffixRe));
    else if (suffixRe.test(entry.name)) out.push(p.replace(TARGET_ROOT + '/', ''));
  }
  return out;
}
const allCls = walkSpecial(REPORTS_DIR, /-cover-letter\.md$/);
const allQs = walkSpecial(REPORTS_DIR, /-(application-questions|application-answers|form-answers)\.md$/);
for (const cl of allCls) if (!referencedCls.has(cl)) { warn(`Orphan cover letter: ${cl}`); orphanCls++; }
for (const q of allQs) if (!referencedQs.has(q)) { warn(`Orphan form-answer file: ${q}`); orphanQs++; }
if (orphanCls === 0) ok(`All ${allCls.length} cover letters referenced in tracker`);
if (orphanQs === 0) ok(`All ${allQs.length} form-answer files referenced in tracker`);

// --- Check 11: Brand-alias in tracker (Issue 11 prevention) ---
// If portals.yml has company_aliases, check that no row uses a subsidiary slug.
let aliasViolations = 0;
const portalsPath = join(REPO_ROOT, 'portals.yml');
if (existsSync(portalsPath)) {
  const aliases = {};
  const portalLines = readFileSync(portalsPath, 'utf-8').split('\n');
  let inAliases = false;
  for (const line of portalLines) {
    if (/^company_aliases:\s*$/.test(line)) { inAliases = true; continue; }
    if (inAliases) {
      if (/^\S/.test(line) && !/^#/.test(line)) break;
      const m = line.match(/^\s+([a-z0-9-]+):\s*([a-z0-9-]+)\s*(#.*)?$/);
      if (m) aliases[m[1]] = m[2];
    }
  }
  for (const e of entries) {
    const m = e.report.match(/reports\/([^/]+)\//);
    if (!m) continue;
    const folderSlug = m[1];
    if (aliases[folderSlug]) {
      warn(`#${e.num}: report under subsidiary slug "${folderSlug}" — should be under canonical "${aliases[folderSlug]}"`);
      aliasViolations++;
    }
  }
}
if (aliasViolations === 0) ok('No brand-alias slug violations');

// --- Summary ---
console.log('\n' + '='.repeat(50));
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean!');
} else if (errors === 0) {
  console.log('🟡 Pipeline OK with warnings');
} else {
  console.log('🔴 Pipeline has errors — fix before proceeding');
}

process.exit(errors > 0 ? 1 : 0);
