#!/usr/bin/env node
/**
 * merge-tracker.mjs — Merge batch tracker additions into applications.md
 *
 * Handles multiple TSV formats:
 * - 9-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes
 * - 8-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport (no notes)
 *
 * Cover letter info is embedded in the Notes field with a prefix:
 *   "CL: [link](path)" or "CL+Q: [link](path)" or "Form Qs: [link](path)"
 *   "CL: pending" / "CL: n/a" / "CL: pending verify"
 * - Pipe-delimited (markdown table row): | col | col | ... |
 *
 * Dedup: company normalized + role fuzzy match + report number match
 * If duplicate with higher score → update in-place, update report link
 * Validates status against states.yml (rejects non-canonical, logs warning)
 *
 * Run: node career-ops/merge-tracker.mjs [--dry-run] [--verify]
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { execFileSync } from 'child_process';
import { resolvePaths } from './lib/paths.mjs';

const P = resolvePaths(import.meta.url);
const CAREER_OPS = P.root;          // portals.yml read via join(CAREER_OPS,'portals.yml') stays root — correct
const APPS_FILE = P.appsFile;
const ADDITIONS_DIR = P.batchDir('tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

// Ensure required directories exist (fresh setup)
mkdirSync(P.dataDir, { recursive: true });
mkdirSync(ADDITIONS_DIR, { recursive: true });

// Canonical states. SKIP is intentionally NOT included here — it was the legacy
// term and got migrated to Discarded in 2026-05-10 cleanup. Anything that scores
// `SKIP` from a TSV will fall through to the warning-and-default-to-Evaluated path.
const CANONICAL_STATES = ['Triaged', 'Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded'];

// Brand-alias map: subsidiary slug -> canonical parent slug.
// Loaded lazily from portals.yml so a single source of truth drives both
// scan.mjs (URL-dedup) and merge-tracker.mjs (company-string dedup +
// folder routing). Kills the cross-folder duplicate class observed in the
// 2026-05-09 audit (Issue 11).
let _companyAliases = null;
function loadCompanyAliases() {
  if (_companyAliases) return _companyAliases;
  _companyAliases = {};
  const portalsPath = join(CAREER_OPS, 'portals.yml');
  if (!existsSync(portalsPath)) return _companyAliases;
  const lines = readFileSync(portalsPath, 'utf-8').split('\n');
  let inAliases = false;
  for (const line of lines) {
    if (/^company_aliases:\s*$/.test(line)) { inAliases = true; continue; }
    if (inAliases) {
      // Stop at next top-level key
      if (/^\S/.test(line) && !/^#/.test(line)) break;
      const m = line.match(/^\s+([a-z0-9-]+):\s*([a-z0-9-]+)\s*(#.*)?$/);
      if (m) _companyAliases[m[1]] = m[2];
    }
  }
  return _companyAliases;
}

function resolveAlias(slug) {
  const aliases = loadCompanyAliases();
  return aliases[slug] || slug;
}

function validateStatus(status) {
  const clean = status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  for (const valid of CANONICAL_STATES) {
    if (valid.toLowerCase() === lower) return valid;
  }

  // Aliases
  const aliases = {
    // Spanish → English
    'evaluada': 'Evaluated', 'condicional': 'Evaluated', 'hold': 'Evaluated', 'evaluar': 'Evaluated', 'verificar': 'Evaluated',
    'aplicado': 'Applied', 'enviada': 'Applied', 'aplicada': 'Applied', 'applied': 'Applied', 'sent': 'Applied',
    'respondido': 'Responded',
    'entrevista': 'Interview',
    'oferta': 'Offer',
    'rechazado': 'Rejected', 'rechazada': 'Rejected',
    'descartado': 'Discarded', 'descartada': 'Discarded', 'cerrada': 'Discarded', 'cancelada': 'Discarded',
    'no aplicar': 'SKIP', 'no_aplicar': 'SKIP', 'skip': 'SKIP', 'monitor': 'SKIP',
    'geo blocker': 'SKIP',
  };

  if (aliases[lower]) return aliases[lower];

  // DUPLICADO/Repost → Discarded
  if (/^(duplicado|dup|repost)/i.test(lower)) return 'Discarded';

  console.warn(`⚠️  Non-canonical status "${status}" → defaulting to "Evaluated"`);
  return 'Evaluated';
}

function normalizeCompany(name) {
  // Lowercase + strip non-alphanumeric, then resolve through the brand-alias map.
  // E.g. "NetSuite" -> "netsuite" -> "oracle"; "Microsoft Research" -> "microsoftresearch"
  // -> alias lookup tries both raw and slug-with-dashes form.
  const stripped = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Also try the dashed form because aliases use dashed slugs ("microsoft-research")
  const dashed = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const aliases = loadCompanyAliases();
  if (aliases[dashed]) return aliases[dashed].replace(/-/g, '');
  if (aliases[stripped]) return aliases[stripped].replace(/-/g, '');
  return stripped;
}

// Returns the canonical folder slug for a given company name. Used when
// routing a new report into reports/<slug>/ — feeds the same alias map so
// "NetSuite" lands in reports/oracle/ rather than reports/netsuite/.
function canonicalFolderSlug(name) {
  const dashed = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return resolveAlias(dashed);
}

// Tokens that almost every role shares — must NOT count as signal.
// Includes seniority, work-mode, contract, and common locations.
const ROLE_STOPWORDS = new Set([
  // seniority / level
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry', 'level',
  // contract / mode
  'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'freelance',
  'fulltime', 'parttime', 'permanent', 'temporary', 'intern', 'internship',
  // generic job words
  'role', 'position', 'opportunity', 'team', 'based',
  // very common locations (extend in portals.yml later if needed)
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'london', 'berlin', 'paris', 'madrid', 'barcelona', 'amsterdam', 'dublin',
  'york', 'francisco', 'seattle', 'boston', 'austin', 'chicago', 'toronto',
  'tokyo', 'singapore', 'sydney', 'melbourne', 'lisbon', 'warsaw',
  // regions / countries
  'europe', 'emea', 'apac', 'latam', 'americas', 'india', 'spain', 'germany',
  'france', 'italy', 'canada', 'brazil', 'mexico', 'japan',
  // prepositions leaking through length filter
  'with', 'from', 'into', 'over', 'this', 'that',
]);

// Role-abbreviation expansion. Maps short tokens (often filtered by the
// >3-char rule, or that diverge across aggregators) to their canonical
// expansion. Catches cases like "Engineering Intern - C&I" (#3113) vs
// "Engineer Intern, Commercial and Industrial" (#3266) where the same
// req gets rendered abbreviated in one feed and expanded in another.
// Both forms get tokens [commercial, industrial] after expansion.
const ROLE_ABBREVIATIONS = new Map([
  ['c&i', 'commercial industrial'],
  ['ci', 'commercial industrial'],   // when "&" gets stripped
  ['ev', 'electric vehicle'],
  ['ml', 'machine learning'],
  ['ai', 'artificial intelligence'],
  ['cv', 'computer vision'],
  ['nlp', 'natural language processing'],
  ['llm', 'large language model'],
  ['sde', 'software development engineer'],
  ['swe', 'software engineer'],
  ['mle', 'machine learning engineer'],
  ['mlops', 'machine learning operations'],
  ['ds', 'data science'],
  ['de', 'data engineer'],
  ['da', 'data analyst'],
  ['ba', 'business analyst'],
  ['fde', 'forward deployed engineer'],
  ['ux', 'user experience'],
  ['ui', 'user interface'],
  ['rd', 'research development'],
  ['hpc', 'high performance computing'],
  ['qa', 'quality assurance'],
]);

// Stem helper: collapse common English inflections so "engineer" matches
// "engineering" / "engineered" / "engineers". Naive but adequate for role
// titles which are short and stylized.
function roleStem(token) {
  if (token.length <= 4) return token;
  // Order matters: longer suffixes first.
  for (const suffix of ['ering', 'ation', 'ings', 'ies', 'ing', 'ers', 'ed', 'es', 'er', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function roleTokens(s) {
  // First pass: lowercase, replace non-alphanumeric with spaces, but PRESERVE
  // the &-glued abbreviations (c&i → ci) by stripping & before splitting.
  const normalized = s
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  // Second pass: expand known abbreviations IN PLACE so a single-token
  // abbreviation (which the >3-char filter would otherwise drop) contributes
  // its full multi-token expansion to the comparison.
  const expanded = normalized
    .split(/\s+/)
    .filter(Boolean)
    .flatMap(w => ROLE_ABBREVIATIONS.has(w) ? ROLE_ABBREVIATIONS.get(w).split(/\s+/) : [w]);
  // Third pass: stop-word filter, length filter, then stem.
  return expanded
    .filter(w => w.length > 3 && !ROLE_STOPWORDS.has(w))
    .map(roleStem);
}

// Mirror of `discovery_filters.normalize_url` (Python). Strips scheme, www.,
// query, fragment, trailing slash, and the trailing /apply or /application
// path suffix. For Workday URLs (`{tenant}.wd{N}.myworkdayjobs.com/...`),
// collapses to `{tenant}/_{jobid}` so locale prefix (`/en-US/`), site segment,
// location-encoded path, and aggregator-injected query params don't create
// false-negative dedup. The 2026-05-10 #3534 (Philips, aggregator-redirected
// with `utm_source=Simplify`) duplicate of #3524 (direct Workday URL with
// `/en-US/` locale) was the trigger — both refer to Workday req `582261` but
// only matched on company+role fuzzy after slipping past URL-fingerprint dedup.
// Two URLs that normalize to the same string refer to the same job posting.
function normalizeUrl(url) {
  if (!url) return '';
  let u = url.trim().toLowerCase();
  u = u.split('?')[0].split('#')[0];
  u = u.replace(/\/+$/, '');
  u = u.replace(/^https?:\/\/(www\.)?/, '');
  u = u.replace(/\/(apply|application)\/?$/, '');
  const wdMatch = u.match(/^([^\/]+\.wd\d+\.myworkdayjobs\.com)\/.*_([a-z0-9][a-z0-9-]{3,})$/);
  if (wdMatch) return `${wdMatch[1]}/_${wdMatch[2]}`;
  return u;
}

// Pull the first http(s) URL out of a Notes / row blob.
function extractUrl(blob) {
  if (!blob) return '';
  const m = blob.match(/https?:\/\/[^\s|)\]]+/);
  return m ? m[0].replace(/[.,;)]+$/, '') : '';
}

function roleFuzzyMatch(a, b) {
  const wordsA = roleTokens(a);
  const wordsB = roleTokens(b);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setB = new Set(wordsB);
  const overlap = wordsA.filter(w => setB.has(w)).length;
  if (overlap === 0) return false;

  // Jaccard-style ratio on content tokens. Two roles are "the same" only
  // when the overlap dominates the smaller side — not when they just share
  // a location + "engineer".
  const minLen = Math.min(wordsA.length, wordsB.length);
  const ratio = overlap / minLen;

  return overlap >= 2 && ratio >= 0.6;
}

function extractReportNum(reportStr) {
  const m = reportStr.match(/\[(\d+)\]/);
  return m ? parseInt(m[1]) : null;
}

function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// Sanitize a value before it goes into a markdown table cell. A literal "|"
// injects an extra column and breaks the 9-field count the Go dashboard parses
// (fields[5]=Status, etc.); tabs/newlines do the same to downstream TSV/diff
// tooling. This is the single chokepoint every source (scan agents, aggregator,
// gmail-sweep) funnels through, so sanitizing here covers all of them.
function sanitizeCell(v) {
  return String(v ?? '')
    .replace(/\|/g, '/')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Backstop for sanitizeCell. A well-formed 9-column row "| f1 | ... | f9 |"
// splits on "|" into 11 parts (leading empty + 9 fields + trailing empty).
// Anything else means a cell still smuggled a pipe through — the caller warns
// and skips rather than write a row that desyncs the dashboard's column parser.
function rowIsValid(line) {
  return line.split('|').length === 11 && !/[\t\n\r]/.test(line);
}

function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num) || num === 0) return null;
  return {
    num, date: parts[2], company: parts[3], role: parts[4],
    score: parts[5], status: parts[6], pdf: parts[7], report: parts[8],
    notes: parts[9] || '', raw: line,
  };
}

/**
 * Parse a TSV file content into a structured addition object.
 * Handles: 9-col TSV, 8-col TSV, pipe-delimited markdown.
 */
function parseTsvContent(content, filename) {
  content = content.trim();
  if (!content) return null;

  let parts;
  let addition;

  // Detect pipe-delimited (markdown table row)
  if (content.startsWith('|')) {
    parts = content.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed pipe-delimited ${filename}: ${parts.length} fields`);
      return null;
    }
    // Format: num | date | company | role | score | status | pdf | report | notes
    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      score: parts[4],
      status: validateStatus(parts[5]),
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
  } else {
    // Tab-separated
    parts = content.split('\t');
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed TSV ${filename}: ${parts.length} fields`);
      return null;
    }

    // Detect column order: some TSVs have (status, score), others have (score, status)
    // Heuristic: if col4 looks like a score and col5 looks like a status, they're swapped
    const col4 = parts[4].trim();
    const col5 = parts[5].trim();
    const col4LooksLikeScore = /^\d+\.?\d*\/5$/.test(col4) || col4 === 'N/A' || col4 === 'DUP';
    const col5LooksLikeScore = /^\d+\.?\d*\/5$/.test(col5) || col5 === 'N/A' || col5 === 'DUP';
    const col4LooksLikeStatus = /^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|evaluada|aplicado|respondido|entrevista|oferta|rechazado|descartado|no aplicar|cerrada|duplicado|repost|condicional|hold|monitor)/i.test(col4);
    const col5LooksLikeStatus = /^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|evaluada|aplicado|respondido|entrevista|oferta|rechazado|descartado|no aplicar|cerrada|duplicado|repost|condicional|hold|monitor)/i.test(col5);

    let statusCol, scoreCol;
    if (col4LooksLikeStatus && !col4LooksLikeScore) {
      // Standard format: col4=status, col5=score
      statusCol = col4; scoreCol = col5;
    } else if (col4LooksLikeScore && col5LooksLikeStatus) {
      // Swapped format: col4=score, col5=status
      statusCol = col5; scoreCol = col4;
    } else if (col5LooksLikeScore && !col4LooksLikeScore) {
      // col5 is definitely score → col4 must be status
      statusCol = col4; scoreCol = col5;
    } else {
      // Default: standard format (status before score)
      statusCol = col4; scoreCol = col5;
    }

    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      status: validateStatus(statusCol),
      score: scoreCol,
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
  }

  if (isNaN(addition.num) || addition.num === 0) {
    console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  return addition;
}

// ---- Main ----

// Read applications.md
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to merge into.');
  process.exit(0);
}
const appContent = readFileSync(APPS_FILE, 'utf-8');
const appLines = appContent.split('\n');
const existingApps = [];
let maxNum = 0;

for (const line of appLines) {
  if (line.startsWith('|') && !line.includes('---') && !line.includes('Empresa')) {
    const app = parseAppLine(line);
    if (app) {
      existingApps.push(app);
      if (app.num > maxNum) maxNum = app.num;
    }
  }
}

console.log(`📊 Existing: ${existingApps.length} entries, max #${maxNum}`);

// Read tracker additions
if (!existsSync(ADDITIONS_DIR)) {
  console.log('No tracker-additions directory found.');
  process.exit(0);
}

const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.log('✅ No pending additions to merge.');
  process.exit(0);
}

// Sort files numerically for deterministic processing
tsvFiles.sort((a, b) => {
  const numA = parseInt(a.replace(/\D/g, '')) || 0;
  const numB = parseInt(b.replace(/\D/g, '')) || 0;
  return numA - numB;
});

console.log(`📥 Found ${tsvFiles.length} pending additions`);

let added = 0;
let updated = 0;
let skipped = 0;
const newLines = [];

for (const file of tsvFiles) {
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
  const addition = parseTsvContent(content, file);
  if (!addition) { skipped++; continue; }

  // Check for duplicate by (in order):
  // 1. Exact report number match
  // 2. Exact entry number match
  // 3. Normalized URL match (catches the case where company+role tokens
  //    diverge but the underlying ATS req URL is identical - e.g. when one
  //    source returns the bare apply URL and another appends /application
  //    or query strings)
  // 4. Company + role fuzzy match
  const reportNum = extractReportNum(addition.report);
  let duplicate = null;

  if (reportNum) {
    // Check if this report number already exists
    duplicate = existingApps.find(app => {
      const existingReportNum = extractReportNum(app.report);
      return existingReportNum === reportNum;
    });
  }

  if (!duplicate) {
    // Exact entry number match
    duplicate = existingApps.find(app => app.num === addition.num);
  }

  if (!duplicate) {
    // Normalized URL match against any URL in the existing row's blob
    // (Notes column or Report cell). This is a cross-source safety net.
    const additionUrl = normalizeUrl(extractUrl(addition.notes) || extractUrl(addition.report));
    if (additionUrl) {
      duplicate = existingApps.find(app => {
        const appBlob = `${app.notes || ''} ${app.raw || ''}`;
        // existing rows can carry multiple URLs (CL link, eval URL, etc.);
        // grab all and compare each.
        const urls = [...appBlob.matchAll(/https?:\/\/[^\s|)\]]+/g)].map(m => normalizeUrl(m[0].replace(/[.,;)]+$/, '')));
        return urls.some(u => u && u === additionUrl);
      });
    }
  }

  if (!duplicate) {
    // Company + role fuzzy match
    const normCompany = normalizeCompany(addition.company);
    duplicate = existingApps.find(app => {
      if (normalizeCompany(app.company) !== normCompany) return false;
      return roleFuzzyMatch(addition.role, app.role);
    });
  }

  if (duplicate) {
    const newScore = parseScore(addition.score);
    const oldScore = parseScore(duplicate.score);

    if (newScore > oldScore) {
      console.log(`🔄 Update: #${duplicate.num} ${addition.company} — ${addition.role} (${oldScore}→${newScore})`);
      const lineIdx = appLines.indexOf(duplicate.raw);
      if (lineIdx >= 0) {
        const notesField = sanitizeCell(`Re-eval ${addition.date} (${oldScore}→${newScore}). ${addition.notes}`);
        const updatedLine = `| ${duplicate.num} | ${sanitizeCell(addition.date)} | ${sanitizeCell(addition.company)} | ${sanitizeCell(addition.role)} | ${sanitizeCell(addition.score)} | ${sanitizeCell(duplicate.status)} | ${sanitizeCell(duplicate.pdf)} | ${sanitizeCell(addition.report)} | ${notesField} |`;
        if (rowIsValid(updatedLine)) {
          appLines[lineIdx] = updatedLine;
          updated++;
        } else {
          console.warn(`⚠️  Skipping update for #${duplicate.num} ${addition.company}: row failed schema guard → ${updatedLine}`);
          skipped++;
        }
      }
    } else {
      console.log(`⏭️  Skip: ${addition.company} — ${addition.role} (existing #${duplicate.num} ${oldScore} >= new ${newScore})`);
      skipped++;
    }
  } else {
    // New entry — use the number from the TSV
    const entryNum = addition.num > maxNum ? addition.num : ++maxNum;
    if (addition.num > maxNum) maxNum = addition.num;

    const newLine = `| ${entryNum} | ${sanitizeCell(addition.date)} | ${sanitizeCell(addition.company)} | ${sanitizeCell(addition.role)} | ${sanitizeCell(addition.score)} | ${sanitizeCell(addition.status)} | ${sanitizeCell(addition.pdf)} | ${sanitizeCell(addition.report)} | ${sanitizeCell(addition.notes)} |`;
    if (rowIsValid(newLine)) {
      newLines.push(newLine);
      added++;
      console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (${addition.score})`);
    } else {
      console.warn(`⚠️  Skipping add for ${addition.company} — ${addition.role}: row failed schema guard → ${newLine}`);
      skipped++;
    }
  }
}

// Insert new lines after the header (line index of first data row)
if (newLines.length > 0) {
  // Find header separator (|---|...) and insert after it
  let insertIdx = -1;
  for (let i = 0; i < appLines.length; i++) {
    if (appLines[i].includes('---') && appLines[i].startsWith('|')) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx >= 0) {
    appLines.splice(insertIdx, 0, ...newLines);
  }
}

// Write back
if (!DRY_RUN) {
  writeFileSync(APPS_FILE, appLines.join('\n'));

  // Move processed files to merged/
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of tsvFiles) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  console.log(`\n✅ Moved ${tsvFiles.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped`);
if (DRY_RUN) console.log('(dry-run — no changes written)');

// Optional verify
if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  try {
    execFileSync('node', [join(CAREER_OPS, 'verify-pipeline.mjs')], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
