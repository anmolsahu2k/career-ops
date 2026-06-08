#!/usr/bin/env node
/**
 * gmail-sweep-merge.mjs
 *
 * Consume parsed Gmail-sweep JSONs from data/gmail-sweeps/parsed/, bucket
 * by (normalized_company, fuzzy_role), resolve final state per bucket,
 * match against data/applications.md, and emit:
 *
 *   batch/tracker-additions/gmail-<source>-2026-06-05.tsv  (new rows for merge-tracker.mjs)
 *   batch/status-flips/gmail-rejections-2026-06-05.tsv     (proposed flips for apply-status-flips.mjs)
 *
 * Bucketing handles the Workday case where the SAME subject ("Thank you for
 * Applying") is used for both confirmations AND rejections — a parsed
 * APPLIED_CONFIRMATION + REJECTION pair for the same (company, role)
 * collapses to a single final state of REJECTED.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { resolvePaths } from '../lib/paths.mjs';
const P = resolvePaths(import.meta.url);
const PARSED_DIR = join(P.dataDir, 'gmail-sweeps/parsed');
const APPS_FILE = P.appsFile;
const ADDITIONS_DIR = P.batchDir('tracker-additions');
const FLIPS_DIR = P.batchDir('status-flips');
const TODAY = '2026-06-05';

const ROLE_STOPWORDS = new Set([
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry', 'level',
  'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'freelance',
  'fulltime', 'parttime', 'permanent', 'temporary', 'internship',
  'role', 'position', 'opportunity', 'team', 'based',
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'london', 'berlin', 'paris', 'madrid', 'barcelona', 'amsterdam', 'dublin',
  'york', 'francisco', 'seattle', 'boston', 'austin', 'chicago', 'toronto',
  'tokyo', 'singapore', 'sydney', 'melbourne', 'lisbon', 'warsaw',
  'europe', 'emea', 'apac', 'latam', 'americas', 'india', 'spain', 'germany',
  'france', 'italy', 'canada', 'brazil', 'mexico', 'japan',
  'with', 'from', 'into', 'over', 'this', 'that',
]);
const ROLE_ABBREVIATIONS = new Map([
  ['c&i', 'commercial industrial'], ['ci', 'commercial industrial'],
  ['ev', 'electric vehicle'], ['ml', 'machine learning'],
  ['ai', 'artificial intelligence'], ['cv', 'computer vision'],
  ['nlp', 'natural language processing'], ['llm', 'large language model'],
  ['sde', 'software development engineer'], ['swe', 'software engineer'],
  ['mle', 'machine learning engineer'], ['mlops', 'machine learning operations'],
  ['ds', 'data science'], ['de', 'data engineer'], ['da', 'data analyst'],
  ['ba', 'business analyst'], ['fde', 'forward deployed engineer'],
  ['ux', 'user experience'], ['ui', 'user interface'],
  ['rd', 'research development'], ['hpc', 'high performance computing'],
  ['qa', 'quality assurance'],
]);

function normalizeCompany(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function roleStem(token) {
  if (token.length <= 4) return token;
  for (const suffix of ['ering', 'ation', 'ings', 'ies', 'ing', 'ers', 'ed', 'es', 'er', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function roleTokens(s) {
  if (!s) return [];
  const normalized = s.toLowerCase().replace(/&/g, '').replace(/[^a-z0-9\s]/g, ' ');
  const expanded = normalized.split(/\s+/).filter(Boolean)
    .flatMap(w => ROLE_ABBREVIATIONS.has(w) ? ROLE_ABBREVIATIONS.get(w).split(/\s+/) : [w]);
  return expanded.filter(w => w.length > 3 && !ROLE_STOPWORDS.has(w)).map(roleStem);
}

function roleFuzzyMatch(a, b) {
  const wa = roleTokens(a);
  const wb = roleTokens(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const setB = new Set(wb);
  const overlap = wa.filter(w => setB.has(w)).length;
  if (overlap === 0) return false;
  const ratio = overlap / Math.min(wa.length, wb.length);
  return overlap >= 2 && ratio >= 0.6;
}

function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num)) return null;
  return {
    num, date: parts[2], company: parts[3], role: parts[4],
    score: parts[5], status: parts[6], pdf: parts[7],
    report: parts[8], notes: parts[9] || '', raw: line,
  };
}

function classifyResumeForRole(role) {
  const r = (role || '').toLowerCase();
  if (/(\bml\b|machine learning|\bai\b|artificial intelligence|data scien|applied scien|research|nlp|computer vision|deep learn)/.test(r)) return 'MLE';
  return 'SDE';
}

function sourceLabel(source, fromField) {
  if (source === 'cmu-handshake') return 'Handshake';
  const f = (fromField || '').toLowerCase();
  if (f.includes('myworkday')) return 'Workday';
  if (f.includes('ashbyhq')) return 'Ashby';
  if (f.includes('lever.co')) return 'Lever';
  if (f.includes('greenhouse')) return 'Greenhouse';
  if (f.includes('icims')) return 'iCIMS';
  if (f.includes('smartrecruiters')) return 'SmartRecruiters';
  if (f.includes('linkedin')) return 'LinkedIn';
  return 'Email';
}

// ---- Main ----

if (!existsSync(PARSED_DIR)) {
  console.error(`No parsed dir at ${PARSED_DIR}`);
  process.exit(1);
}
mkdirSync(ADDITIONS_DIR, { recursive: true });
mkdirSync(FLIPS_DIR, { recursive: true });

// Load tracker
const appContent = readFileSync(APPS_FILE, 'utf-8');
const appLines = appContent.split('\n');
const existing = [];
let maxNum = 0;
for (const line of appLines) {
  if (line.startsWith('|') && !line.includes('---') && !line.includes('Empresa')) {
    const app = parseAppLine(line);
    if (app) {
      existing.push(app);
      if (app.num > maxNum) maxNum = app.num;
    }
  }
}
const byCompany = new Map();
for (const a of existing) {
  const k = normalizeCompany(a.company);
  if (!byCompany.has(k)) byCompany.set(k, []);
  byCompany.get(k).push(a);
}
console.error(`📊 Tracker loaded: ${existing.length} rows, max #${maxNum}, ${byCompany.size} distinct companies`);

// Load parsed batches; dedupe by msg_id
const parsedFiles = readdirSync(PARSED_DIR).filter(f => f.endsWith('.json')).sort();
const byMsgId = new Map();
for (const f of parsedFiles) {
  const data = JSON.parse(readFileSync(join(PARSED_DIR, f), 'utf-8'));
  const src = (data.batch_id || '').split('-batch-')[0];
  for (const r of data.results) {
    const existing = byMsgId.get(r.msg_id);
    // Prefer REJECTION over APPLIED_CONFIRMATION over NEITHER (rejection is most-definitive signal)
    const rank = (c) => c === 'REJECTION' ? 3 : c === 'APPLIED_CONFIRMATION' ? 2 : 1;
    if (!existing || rank(r.classification) > rank(existing.classification)) {
      byMsgId.set(r.msg_id, { ...r, source: src });
    }
  }
}
const records = Array.from(byMsgId.values());
console.error(`📥 Parsed records (deduped by msg_id): ${records.length} from ${parsedFiles.length} batches`);

// Bucket records by (normalized_company, fuzzy_role)
// Note: fuzzy match isn't transitive, so we use first-match-wins bucketing.
const buckets = []; // { key, records[], company, role }
for (const rec of records) {
  if (rec.classification === 'NEITHER') continue;
  if (!rec.company || !rec.role) continue;
  const k = normalizeCompany(rec.company);
  let found = null;
  for (const b of buckets) {
    if (normalizeCompany(b.company) === k && roleFuzzyMatch(b.role, rec.role)) {
      found = b;
      break;
    }
  }
  if (!found) {
    found = { key: `${k}::${rec.role.toLowerCase()}`, records: [], company: rec.company, role: rec.role };
    buckets.push(found);
  }
  found.records.push(rec);
}
console.error(`🪣 Bucketed into ${buckets.length} distinct (company, role) cases`);

// Resolve each bucket to final state
const resolved = []; // { company, role, final_status, latest_date, source, msg_id, all_msg_ids, confidence, rejection_reason }
for (const b of buckets) {
  // Sort records by date desc; pick most-definitive
  const sorted = b.records.slice().sort((x, y) => (y.date_iso || '').localeCompare(x.date_iso || ''));
  const rej = sorted.find(r => r.classification === 'REJECTION');
  const app = sorted.find(r => r.classification === 'APPLIED_CONFIRMATION');
  const chosen = rej || app;
  if (!chosen) continue;
  resolved.push({
    company: chosen.company,
    role: chosen.role,
    final_status: rej ? 'Rejected' : 'Applied',
    date_iso: chosen.date_iso,
    apply_date_iso: app?.date_iso || null,
    source: chosen.source,
    from: chosen.from || '',
    subject: chosen.subject || '',
    msg_id: chosen.msg_id,
    all_msg_ids: b.records.map(r => r.msg_id),
    confidence: chosen.confidence,
    rejection_reason: rej?.rejection_reason || '',
  });
}

// Match against tracker, emit additions and flips
const additions = [];   // status=Applied or Rejected (backfill)
const flips = [];
const noopSkipped = []; // tracker already has matching row in same/better state

for (const r of resolved) {
  const k = normalizeCompany(r.company);
  const candidates = byCompany.get(k) || [];
  const hit = candidates.find(c => roleFuzzyMatch(c.role, r.role));

  if (!hit) {
    // No existing row → backfill addition with final_status
    additions.push(r);
    continue;
  }

  if (r.final_status === 'Applied') {
    // Tracker has the row already; if status is Discarded etc. don't flip up,
    // just skip. If status is Applied or better, also skip.
    noopSkipped.push({ resolved: r, existing: hit });
    continue;
  }

  // final_status === 'Rejected'
  if (hit.status === 'Rejected') {
    noopSkipped.push({ resolved: r, existing: hit, reason: 'already-rejected' });
    continue;
  }
  flips.push({
    tracker_row: hit.num,
    company: hit.company,
    role: hit.role,
    current_status: hit.status,
    new_status: 'Rejected',
    rejection_date: r.date_iso,
    rejection_reason: r.rejection_reason || '',
    msg_id: r.msg_id,
    confidence: r.confidence || 'medium',
    parsed_company: r.company,
    parsed_role: r.role,
  });
}

// Group additions by source → separate TSVs (so merge-tracker provenance is clear)
const additionsBySource = {};
for (const a of additions) {
  (additionsBySource[a.source] || (additionsBySource[a.source] = [])).push(a);
}

let nextNum = maxNum + 1;
for (const [source, rows] of Object.entries(additionsBySource)) {
  const lines = [];
  for (const r of rows) {
    const num = nextNum++;
    const dateForRow = r.final_status === 'Rejected' && r.apply_date_iso ? r.apply_date_iso : (r.date_iso || TODAY);
    const company = r.company.replace(/\t/g, ' ');
    const role = r.role.replace(/\t/g, ' ');
    const score = 'N/A';
    const pdf = classifyResumeForRole(r.role);
    const report = 'n/a';
    const srcLbl = sourceLabel(r.source, r.from);
    let notes = `[${srcLbl}] Gmail-sweep backfill ${TODAY}. msg=${r.msg_id}`;
    if (r.final_status === 'Rejected') {
      notes += ` rejected=${r.date_iso}`;
      if (r.rejection_reason) notes += ` reason="${r.rejection_reason.replace(/"/g, "'").slice(0, 120)}"`;
    }
    notes += ` subj="${(r.subject || '').replace(/"/g, "'").replace(/\t/g, ' ').slice(0, 120)}"`;
    lines.push([num, dateForRow, company, role, r.final_status, score, pdf, report, notes].join('\t'));
  }
  const out = join(ADDITIONS_DIR, `gmail-${source}-${TODAY}.tsv`);
  writeFileSync(out, lines.join('\n') + '\n');
  console.error(`✏️  Wrote ${lines.length} additions → ${out}`);
}

// Status flips TSV
if (flips.length > 0) {
  const lines = ['# tracker_row\tcurrent_company\tcurrent_role\tcurrent_status\tnew_status\trejection_date\trejection_reason\tmsg_id\tconfidence\tparsed_company\tparsed_role'];
  for (const f of flips) {
    lines.push([
      f.tracker_row, f.company, f.role, f.current_status, f.new_status,
      f.rejection_date,
      (f.rejection_reason || '').replace(/\t/g, ' ').slice(0, 200),
      f.msg_id, f.confidence,
      f.parsed_company, f.parsed_role,
    ].join('\t'));
  }
  const out = join(FLIPS_DIR, `gmail-rejections-${TODAY}.tsv`);
  writeFileSync(out, lines.join('\n') + '\n');
  console.error(`✏️  Wrote ${flips.length} status flips → ${out}`);
}

// Diagnostic report
const diag = {
  totals: {
    parsed_records: records.length,
    buckets: buckets.length,
    resolved: resolved.length,
    additions: additions.length,
    additions_as_rejected: additions.filter(a => a.final_status === 'Rejected').length,
    additions_as_applied: additions.filter(a => a.final_status === 'Applied').length,
    flips: flips.length,
    noop_skipped: noopSkipped.length,
  },
  by_source: Object.fromEntries(
    Object.entries(additionsBySource).map(([s, rs]) => [s, {
      total: rs.length,
      applied: rs.filter(r => r.final_status === 'Applied').length,
      rejected: rs.filter(r => r.final_status === 'Rejected').length,
    }])
  ),
  flips_by_current_status: flips.reduce((acc, f) => {
    acc[f.current_status] = (acc[f.current_status] || 0) + 1;
    return acc;
  }, {}),
  noop_skipped_sample: noopSkipped.slice(0, 25).map(n => ({
    parsed: { company: n.resolved.company, role: n.resolved.role, final_status: n.resolved.final_status },
    existing: { num: n.existing.num, company: n.existing.company, role: n.existing.role, status: n.existing.status },
    reason: n.reason,
  })),
};
mkdirSync(join(P.dataDir, 'gmail-sweeps'), { recursive: true });
const diagPath = join(P.dataDir, 'gmail-sweeps', `merge-report-${TODAY}.json`);
writeFileSync(diagPath, JSON.stringify(diag, null, 2));
console.error(`📝 Diagnostic report → ${diagPath}`);

console.error('');
console.error('═══════════════════════════════════════════');
console.error(`Summary (${TODAY}):`);
console.error(`  Parsed (deduped):                     ${records.length}`);
console.error(`  Distinct (company, role) buckets:     ${buckets.length}`);
console.error(`  → New additions (backfill):           ${additions.length}`);
console.error(`      as Applied:                       ${diag.totals.additions_as_applied}`);
console.error(`      as Rejected (backfill):           ${diag.totals.additions_as_rejected}`);
console.error(`  → Status flips (existing → Rejected): ${flips.length}`);
console.error(`  → No-op (already in tracker):         ${noopSkipped.length}`);
console.error('═══════════════════════════════════════════');
