#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Remove duplicate entries from applications.md
 *
 * Groups by normalized company + fuzzy role match.
 * Keeps entry with highest score. If discarded entry had more advanced status,
 * preserves that status. Merges notes.
 *
 * Run: node career-ops/dedup-tracker.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolvePaths } from './lib/paths.mjs';

const P = resolvePaths(import.meta.url);
const APPS_FILE = P.appsFile;
const DRY_RUN = process.argv.includes('--dry-run');

// Ensure required directories exist (fresh setup)
mkdirSync(P.dataDir, { recursive: true });

// Status advancement order (higher = more advanced in pipeline)
// Aplicado > Rechazado because active application > terminal state
const STATUS_RANK = {
  // English canonicals (states.yml labels)
  'skip': 0,
  'discarded': 0,
  'rejected': 1,
  'evaluated': 2,
  'applied': 3,
  'responded': 4,
  'interview': 5,
  'offer': 6,
  // Spanish aliases — kept for backwards compat with existing tracker data
  'no_aplicar': 0,
  'no aplicar': 0,
  'descartado': 0,
  'descartada': 0,
  'rechazado': 1,  // Terminal — below active states
  'rechazada': 1,
  'evaluada': 2,
  'aplicado': 3,
  'respondido': 4,
  'entrevista': 5,
  'oferta': 6,
};

// Mirrors discovery_filters.py:_normalize_company. Strip markdown link
// wrapping first, then iteratively strip corporate suffixes from the end
// (Inc / LLC / Corp / Group / Health Plan etc.) so "SCAN Health Plan" and
// "Stride, Inc." collapse to the same fingerprint as "SCAN" / "Stride".
const COMPANY_SUFFIX_RE = /\s*[,.]?\s*\b(inc|incorporated|llc|ltd|limited|corp|corporation|company|group|holdings|enterprises|labs|laboratories|technologies|systems|services|partners|health plan|holding)\b\s*\.?\s*$/i;

function normalizeCompany(name) {
  let s = name.replace(/\[([^\]]+)\][^\s]*/g, '$1');
  for (let i = 0; i < 4; i++) {
    const next = s.replace(COMPANY_SUFFIX_RE, '').trim();
    if (next === s) break;
    s = next;
  }
  return s.toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function normalizeRole(role) {
  return role.toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 /]/g, '')
    .trim();
}

const ROLE_STOPWORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief',
  'manager', 'director', 'associate', 'intern', 'contractor',
  'remote', 'hybrid', 'onsite',
  'engineer', 'engineering',
]);

const LOCATION_STOPWORDS = new Set([
  'tokyo', 'japan', 'london', 'berlin', 'paris', 'singapore',
  'york', 'francisco', 'angeles', 'seattle', 'austin', 'boston',
  'chicago', 'denver', 'toronto', 'amsterdam', 'dublin', 'sydney',
  'remote', 'global', 'emea', 'apac', 'latam',
]);

function roleMatch(a, b) {
  const filterStopwords = (words) =>
    words.filter(w => !ROLE_STOPWORDS.has(w) && !LOCATION_STOPWORDS.has(w));

  const wordsA = filterStopwords(normalizeRole(a).split(/\s+/).filter(w => w.length > 2));
  const wordsB = filterStopwords(normalizeRole(b).split(/\s+/).filter(w => w.length > 2));

  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  // Exact set match — always dedup. Covers cases like "Data Engineering Intern"
  // vs "Data Engineering Intern" (both reduce to {data} after stopword filter,
  // which the >=2 overlap rule below would reject) and "BI Analytics Intern"
  // vs "BI Analytics Intern Remote" (both {analytics} after filter).
  if (setA.size === setB.size && [...setA].every(x => setB.has(x))) return true;

  const overlap = [...setA].filter(w => setB.has(w));
  const smaller = Math.min(setA.size, setB.size);
  const ratio = overlap.length / smaller;

  return overlap.length >= 2 && ratio >= 0.6;
}

function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

const URL_RE = /https?:\/\/\S+/;

function extractUrl(notes) {
  const m = (notes || '').match(URL_RE);
  return m ? m[0] : null;
}

function urlHost(url) {
  if (!url) return null;
  const m = url.match(/^https?:\/\/([^\/\s]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : null;
}

// Returns {host, id} for canonical ATS URLs (Greenhouse / Ashby / Lever /
// Workday). The id lets us distinguish two postings on the same ATS
// (e.g., EnergyHub Greenhouse 8524847002 = EV team vs 8523607002 = C&I team
// — same company, same generic title, but different reqs).
function extractAtsId(url) {
  if (!url) return null;
  let m = url.match(/(?:job-boards\.)?greenhouse\.io\/[^\/\s]+\/jobs\/(\d+)/i);
  if (m) return { host: 'greenhouse', id: m[1] };
  m = url.match(/jobs\.ashbyhq\.com\/[^\/\s]+\/([0-9a-f-]{8,})/i);
  if (m) return { host: 'ashby', id: m[1] };
  m = url.match(/jobs\.lever\.co\/[^\/\s]+\/([0-9a-f-]{8,})/i);
  if (m) return { host: 'lever', id: m[1] };
  m = url.match(/myworkdayjobs\.com\/[^\s]*?\/job\/[^\/\s]+\/([\w-]+)/i);
  if (m) return { host: 'workday', id: m[1] };
  return null;
}

// True when both rows have URLs on the same canonical ATS but with
// different job IDs. Such rows are guaranteed-distinct reqs (a single ATS
// never reuses the same numeric id for two different postings) and must
// NOT be auto-merged even if their visible role text matches exactly.
function isDistinctSameAtsReq(notesA, notesB) {
  const a = extractAtsId(extractUrl(notesA));
  const b = extractAtsId(extractUrl(notesB));
  if (!a || !b) return false;
  return a.host === b.host && a.id !== b.id;
}

// Looser than roleMatch: used only for the warning pass. Catches generic
// titles like "Engineering Intern" vs "Engineering Intern - EV (Brooklyn,
// NY)" where the strict matcher refuses to cluster (correctly — auto-
// merging here would silently collapse distinct reqs across teams).
function looseRoleMatch(a, b) {
  const normA = normalizeRole(a);
  const normB = normalizeRole(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  // Word-prefix containment: pad with space to avoid partial-word matches
  // (so "AI" doesn't prefix-match "AI Research").
  return (normA + ' ').startsWith(normB + ' ')
      || (normB + ' ').startsWith(normA + ' ');
}

function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num)) return null;
  return {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    status: parts[6],
    pdf: parts[7],
    report: parts[8],
    notes: parts[9] || '',
    raw: line,
  };
}

// Read
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to dedup.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

// Parse all entries
const entries = [];
const entryLineMap = new Map(); // num → line index

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  const app = parseAppLine(lines[i]);
  if (app && app.num > 0) {
    entries.push(app);
    entryLineMap.set(app.num, i);
  }
}

console.log(`📊 ${entries.length} entries loaded`);

// Group by company+role
const groups = new Map();
for (const entry of entries) {
  const key = normalizeCompany(entry.company);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

// Find duplicates
let removed = 0;
const linesToRemove = new Set();

for (const [company, companyEntries] of groups) {
  if (companyEntries.length < 2) continue;

  // Within same company, find role matches
  const processed = new Set();
  for (let i = 0; i < companyEntries.length; i++) {
    if (processed.has(i)) continue;
    const cluster = [companyEntries[i]];
    processed.add(i);

    for (let j = i + 1; j < companyEntries.length; j++) {
      if (processed.has(j)) continue;
      if (!roleMatch(companyEntries[i].role, companyEntries[j].role)) continue;
      // Safety: refuse to cluster two rows that point at distinct job IDs
      // on the same canonical ATS. They share role text and company but
      // are different postings (e.g. EnergyHub Greenhouse 8524847002 EV
      // vs 8523607002 C&I), and silent merge would lose user state.
      if (isDistinctSameAtsReq(companyEntries[i].notes, companyEntries[j].notes)) continue;
      cluster.push(companyEntries[j]);
      processed.add(j);
    }

    if (cluster.length < 2) continue;

    // Keep the one with highest score
    cluster.sort((a, b) => parseScore(b.score) - parseScore(a.score));
    const keeper = cluster[0];

    // Find the cluster entry with the most advanced status. If two entries
    // tie on status, pick the one with the canonical (non-aggregator) URL.
    // This row's URL and PDF marker are promoted onto the keeper, so we don't
    // lose the user's actual application URL when dedup keeps a higher-scored
    // but jobright/simplify-redirected duplicate.
    const AGGREGATOR_HOST_RE = /\b(jobright\.ai|simplify\.jobs|adzuna\.com)\b/i;
    const URL_RE = /https?:\/\/\S+/;
    function hasCanonicalUrl(notes) {
      const m = (notes || '').match(URL_RE);
      return m && !AGGREGATOR_HOST_RE.test(m[0]);
    }

    let mostAdvanced = keeper;
    let mostAdvancedRank = STATUS_RANK[keeper.status.toLowerCase()] || 0;
    for (let k = 1; k < cluster.length; k++) {
      const rank = STATUS_RANK[cluster[k].status.toLowerCase()] || 0;
      if (
        rank > mostAdvancedRank
        || (rank === mostAdvancedRank && rank > 0 && hasCanonicalUrl(cluster[k].notes) && !hasCanonicalUrl(mostAdvanced.notes))
      ) {
        mostAdvanced = cluster[k];
        mostAdvancedRank = rank;
      }
    }

    if (mostAdvanced.num !== keeper.num) {
      const lineIdx = entryLineMap.get(keeper.num);
      if (lineIdx !== undefined) {
        const parts = lines[lineIdx].split('|').map(s => s.trim());
        const promotions = [];
        if (parts[6] !== mostAdvanced.status) {
          parts[6] = mostAdvanced.status;
          promotions.push(`status="${mostAdvanced.status}"`);
        }
        // Promote PDF marker if the most-advanced row has a non-empty one
        // (✅ MLE / ✅ SDE / ✅ etc.) and the keeper has ❌ or empty.
        const advPdf = (mostAdvanced.pdf || '').trim();
        const keepPdf = (parts[7] || '').trim();
        if (advPdf && advPdf !== '❌' && (keepPdf === '❌' || !keepPdf)) {
          parts[7] = mostAdvanced.pdf;
          promotions.push(`pdf="${mostAdvanced.pdf}"`);
        }
        // Promote URL: if keeper's URL is on an aggregator host and the
        // most-advanced row has a canonical URL, swap them.
        const keepNotes = parts[8] || '';
        const keepUrlM = keepNotes.match(URL_RE);
        const advUrlM = (mostAdvanced.notes || '').match(URL_RE);
        if (
          keepUrlM && advUrlM
          && AGGREGATOR_HOST_RE.test(keepUrlM[0])
          && !AGGREGATOR_HOST_RE.test(advUrlM[0])
        ) {
          parts[8] = keepNotes.replace(keepUrlM[0], advUrlM[0]);
          promotions.push(`url=<canonical from #${mostAdvanced.num}>`);
        }
        lines[lineIdx] = '| ' + parts.slice(1, -1).join(' | ') + ' |';
        if (promotions.length) {
          console.log(`  📝 #${keeper.num}: ${promotions.join(', ')} (from #${mostAdvanced.num})`);
        }
      }
    }

    // Remove duplicates
    for (let k = 1; k < cluster.length; k++) {
      const dup = cluster[k];
      const lineIdx = entryLineMap.get(dup.num);
      if (lineIdx !== undefined) {
        linesToRemove.add(lineIdx);
        removed++;
        console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score}) → kept #${keeper.num} (${keeper.score})`);
      }
    }
  }
}

// Remove lines (in reverse order to preserve indices)
const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
for (const idx of sortedRemoveIndices) {
  lines.splice(idx, 1);
}

// Cross-surface duplicate warning. Strict roleMatch refuses to cluster
// generic intern titles (e.g. "Engineering Intern" appearing on Greenhouse +
// jobright + LinkedIn for the same underlying req) because same-company-
// same-generic-title can also be genuinely-distinct reqs (e.g. EnergyHub
// "Engineering Intern" = both EV team and C&I team). We surface these for
// human review instead of merging silently. Auto-merging here would corrupt
// state — e.g. collapse an Applied row for the EV req into an Applied row
// for the C&I req, losing the user's actual application target.
const survivingByCompany = new Map();
for (const entry of entries) {
  if (linesToRemove.has(entryLineMap.get(entry.num))) continue;
  const key = normalizeCompany(entry.company);
  if (!survivingByCompany.has(key)) survivingByCompany.set(key, []);
  survivingByCompany.get(key).push(entry);
}

const suspiciousClusters = [];
for (const [, companyEntries] of survivingByCompany) {
  if (companyEntries.length < 2) continue;
  const seen = new Set();
  for (let i = 0; i < companyEntries.length; i++) {
    if (seen.has(i)) continue;
    const cluster = [companyEntries[i]];
    seen.add(i);
    for (let j = i + 1; j < companyEntries.length; j++) {
      if (seen.has(j)) continue;
      if (!looseRoleMatch(companyEntries[i].role, companyEntries[j].role)) continue;
      if (isDistinctSameAtsReq(companyEntries[i].notes, companyEntries[j].notes)) continue;
      cluster.push(companyEntries[j]);
      seen.add(j);
    }
    if (cluster.length < 2) continue;
    // Only warn when the cluster spans ≥2 different hosts. Same-host
    // clusters are either genuinely distinct (same-ATS check above already
    // filtered) or already auto-merged by the strict pass.
    const hosts = new Set(cluster.map(e => urlHost(extractUrl(e.notes))).filter(Boolean));
    if (hosts.size < 2) continue;
    suspiciousClusters.push(cluster);
  }
}

if (suspiciousClusters.length) {
  console.log('\n⚠️  POTENTIAL CROSS-SURFACE DUPLICATES (review manually — same company + similar role text on different aggregator surfaces; auto-merge skipped because text isn\'t identical and surfaces don\'t share a canonical ATS id):');
  for (const cluster of suspiciousClusters) {
    console.log(`\n  ${cluster[0].company}:`);
    for (const e of cluster) {
      const host = urlHost(extractUrl(e.notes)) || '(no url)';
      console.log(`    #${e.num}  ${e.score.padEnd(6)}  ${e.status.padEnd(11)}  ${host.padEnd(28)}  "${e.role}"`);
    }
  }
  console.log('');
}

console.log(`\n📊 ${removed} duplicates removed`);

if (!DRY_RUN && removed > 0) {
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No duplicates found');
}
