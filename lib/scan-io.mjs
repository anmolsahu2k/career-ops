// lib/scan-io.mjs — shared feed-intake plumbing for the zero-token scanners.
//
// scan.mjs (ATS APIs), scan-freehire.mjs and scan-linkedin.mjs all land rows in
// the SAME two files: the per-date handoff TSV consumed by the eval workflow,
// and the scan-history ledger that drives dedup + per-source analytics. Those
// helpers used to live inside scan.mjs, where a second scanner could only reuse
// them by copying — and a copied dedup rule that drifts is how the same req
// reaches evaluation twice. One definition, three callers.
//
// Nothing here fetches. Feed-specific fetching/parsing stays in each scanner.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';

// Intern/co-op titles are dropped repo-wide: this is a full-time / new-grad
// search (CLAUDE.md Rule 5). Word-boundary regex rather than an entry in the
// substring-matched `negative` list, which cannot hold 'intern' without also
// killing 'International ...' titles.
export const INTERN_DENY_RE = /\b(intern(?:s|ship|ships)?|co-?op|apprentice(?:ship)?|trainee|summer\s*20\d{2}|summer\s*(?:analyst|associate)|university\s*hire|university\s*recruit)\b/i;

/** Build the 3-stage title filter (intern deny -> must_match -> positive/negative). */
export function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  const mustMatch = titleFilter?.must_match ? new RegExp(titleFilter.must_match, 'i') : null;

  return (title) => {
    if (INTERN_DENY_RE.test(title)) return false;
    if (mustMatch && !mustMatch.test(title)) return false;
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

/** Every URL already seen: the scan-history ledger plus any URL in the tracker. */
export function loadSeenUrls({ scanHistoryPath, applicationsPath }) {
  const seen = new Set();

  if (existsSync(scanHistoryPath)) {
    const lines = readFileSync(scanHistoryPath, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  if (existsSync(applicationsPath)) {
    const text = readFileSync(applicationsPath, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

// Brand-alias map: subsidiary slug -> canonical parent slug, loaded from portals.yml.
// Same map drives merge-tracker.mjs. Used to fold dedup keys so the same posting
// hitting the pipeline under "NetSuite" matches one already in tracker as "Oracle".
const _aliasCache = new Map();
export function loadCompanyAliases(portalsPath) {
  if (_aliasCache.has(portalsPath)) return _aliasCache.get(portalsPath);
  const aliases = {};
  if (existsSync(portalsPath)) {
    const lines = readFileSync(portalsPath, 'utf-8').split('\n');
    let inAliases = false;
    for (const line of lines) {
      if (/^company_aliases:\s*$/.test(line)) { inAliases = true; continue; }
      if (inAliases) {
        if (/^\S/.test(line) && !/^#/.test(line)) break;
        const m = line.match(/^\s+([a-z0-9-]+):\s*([a-z0-9-]+)\s*(#.*)?$/);
        if (m) aliases[m[1]] = m[2];
      }
    }
  }
  _aliasCache.set(portalsPath, aliases);
  return aliases;
}

/** Fold a company name to its canonical parent slug. */
export function aliasResolve(name, portalsPath) {
  const aliases = loadCompanyAliases(portalsPath);
  const dashed = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return aliases[dashed] || dashed;
}

/** `company::role` keys already in the tracker, folded through brand aliases. */
export function loadSeenCompanyRoles({ applicationsPath, portalsPath }) {
  const seen = new Set();
  if (existsSync(applicationsPath)) {
    const text = readFileSync(applicationsPath, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        const canonical = aliasResolve(company, portalsPath);
        seen.add(`${canonical}::${role}`);
        if (canonical !== company) seen.add(`${company}::${role}`); // also keep raw for legacy
      }
    }
  }
  return seen;
}

// ── Writers ─────────────────────────────────────────────────────────

export const scanResultsPath = (dataDir, date) => join(dataDir, `scan-results-${date}.tsv`);

/**
 * Append survivors to the per-date handoff TSV consumed by the eval workflow.
 * ALWAYS appends when the file exists: every scanner writes this same file, and
 * an unconditional overwrite silently discarded a prior run's survivors (hit
 * 2026-07-30, 493 rows, recoverable only because scan-history had them).
 */
export function writeScanResults(offers, date, dataDir) {
  if (offers.length === 0) return null;

  const path = scanResultsPath(dataDir, date);
  const header = 'url\tcompany\ttitle\tlocation\tsource\n';
  const rows = offers.map(o =>
    `${o.url}\t${o.company}\t${o.title}\t${o.location || ''}\t${o.source}`
  ).join('\n') + '\n';

  if (existsSync(path)) {
    appendFileSync(path, rows, 'utf-8');
  } else {
    writeFileSync(path, header + rows, 'utf-8');
  }
  return path;
}

/**
 * Append to the scan-history ledger. `location` is column 7 (added 2026-07-31):
 * the scanners capture it but the ledger used to drop it, so rebuilding the
 * handoff file from history lost every location and pushed Canada-only and
 * Sydney reqs into a US-only eval wave.
 */
export function appendToScanHistory(offers, date, scanHistoryPath) {
  if (!existsSync(scanHistoryPath)) {
    writeFileSync(scanHistoryPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  if (offers.length === 0) return;

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded\t${(o.location || '').replace(/\t/g, ' ')}`
  ).join('\n') + '\n';

  appendFileSync(scanHistoryPath, lines, 'utf-8');
}

/** Log rows the scanner dropped, so per-source yields stay honest. */
export function logSkipped(rows, date, scanHistoryPath, status) {
  if (rows.length === 0) return;
  if (!existsSync(scanHistoryPath)) {
    writeFileSync(scanHistoryPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  const lines = rows.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\t${status}\t${(o.location || '').replace(/\t/g, ' ')}`
  ).join('\n') + '\n';
  appendFileSync(scanHistoryPath, lines, 'utf-8');
}
