#!/usr/bin/env node

/**
 * scan-freehire.mjs — Zero-token freehire.me aggregator scanner
 *
 * freehire.me normalises postings from ~50 ATS platforms into one JSON schema
 * behind a public, unauthenticated REST API (no key, no signup). This scanner
 * runs the FT / new-grad queries against it, applies the same portals.yml title
 * filter and dedup sets as scan.mjs, and appends survivors to the SAME per-date
 * handoff TSV — so the liveness gate and eval workflow consume it unchanged.
 *
 * Zero Claude API tokens: pure HTTP + JSON.
 *
 * Why a denylist and not an allowlist of hosts: about half the corpus is direct
 * ATS (greenhouse/ashby/workday/lever) and a good chunk is company-branded
 * career hosts (careers.hpe.com, weareroku.com) that an allowlist would throw
 * away. What must go is the RE-HOSTS — adzuna/whatjobs/google-jobs/echojobs
 * wrappers — because a re-hosted URL defeats the liveness gate and the JD fetch
 * (see memory reference_ats_api_preflight: only the ATS settles geo + liveness),
 * and adzuna already has its own ingest, so keeping them double-counts a source.
 *
 * Usage:
 *   node scan-freehire.mjs                      # default query set, US, <=21d
 *   node scan-freehire.mjs --dry-run            # preview, write nothing
 *   node scan-freehire.mjs --query "ml engineer"
 *   node scan-freehire.mjs --days 14 --pages 3
 *   node scan-freehire.mjs --all-sources        # keep re-hosted rows too
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { resolvePaths } from './lib/paths.mjs';
import {
  buildTitleFilter,
  loadSeenUrls,
  loadSeenCompanyRoles,
  writeScanResults,
  appendToScanHistory,
  logSkipped,
} from './lib/scan-io.mjs';

const P = resolvePaths(import.meta.url);
const PORTALS_PATH = P.portalsFile;
const SCAN_HISTORY_PATH = join(P.dataDir, 'scan-history.tsv');
const APPLICATIONS_PATH = P.appsFile;
mkdirSync(P.dataDir, { recursive: true });

const SOURCE_ID = 'freehire';
const BASE_URL = (process.env.FREEHIRE_API_URL || 'https://freehire.me').replace(/\/+$/, '');
const SEARCH_PATH = '/api/v1/agent/jobs/search';
const PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 20_000;

// Matches MAX_AGE_DAYS_DEFAULT in scripts/discovery_filters.py and the 21-day
// eval cutoff in modes/auto-pipeline.md. Keep the three in step.
const DEFAULT_MAX_AGE_DAYS = 21;

// Recall drivers only — the portals.yml title filter is what actually decides.
const DEFAULT_QUERIES = [
  'new grad software engineer',
  'software engineer',
  'machine learning engineer',
  'ai engineer',
  'data engineer',
  'data scientist',
  'data analyst',
  'forward deployed engineer',
];

// freehire `source` values that are RE-HOSTS of a posting that lives elsewhere.
// Dropped by default: the URL points at a wrapper, not the employer's ATS.
const REHOST_SOURCES = new Set([
  'adzuna', 'whatjobs', 'google', 'echojobs', 'aijobs', 'arbeitnow', 'jooble',
  'talent', 'neuvoo', 'careerjet', 'jobrapido', 'ziprecruiter', 'indeed',
  'simplyhired', 'linkedin', 'glassdoor', 'monster', 'dice', 'jobspy',
]);

function parseArgs(argv) {
  const has = (f) => argv.includes(f);
  const val = (f, d) => {
    const i = argv.indexOf(f);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
  };
  return {
    dryRun: has('--dry-run'),
    allSources: has('--all-sources'),
    query: val('--query', null),
    country: val('--country', 'us'),
    days: Number(val('--days', DEFAULT_MAX_AGE_DAYS)),
    pages: Number(val('--pages', 2)),
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'career-ops-scan/1.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Drop freehire's attribution params so the URL matches the employer's own. */
function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\?$/, '');
  } catch {
    return raw;
  }
}

function ageDays(job, now) {
  const stamp = job.posted_at || job.created_at;
  if (!stamp) return null;
  const t = Date.parse(stamp);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

async function searchPage(query, opts, page) {
  const p = new URLSearchParams({
    q: query,
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
    semantic_ratio: '0',          // keyword search; the semantic index is opt-in
    include_description: 'false', // titles + metadata are all the filter needs
  });
  if (opts.days > 0) p.set('posted_within_days', String(opts.days));
  if (opts.country) p.append('countries', opts.country);
  const env = await fetchJson(`${BASE_URL}${SEARCH_PATH}?${p}`);
  return { rows: env?.data || [], total: env?.meta?.total ?? null };
}

/**
 * Decide one freehire row against every intake gate. Pure: it reads the dedup
 * sets but never mutates them, so main() owns the "mark as seen" side effect and
 * this stays testable offline (--self-test) while the network is unreachable.
 *
 * verdict: 'keep' | 'skip' (unusable row) | 'rehost' | 'title' | 'stale' | 'dupe'
 */
export function classifyRow(j, { titleFilter, seenUrls, seenCompanyRoles, maxAgeDays, allSources = false, now = Date.now() }) {
  const title = (j.title || '').trim();
  const url = cleanUrl(j.url || '');
  const company = (j.company || '').trim() || 'Unknown';
  if (!title || !url) return { verdict: 'skip', offer: null };

  const offer = {
    url, company, title,
    location: (j.location || '').replace(/\t/g, ' '),
    source: SOURCE_ID,
  };

  if (!allSources && REHOST_SOURCES.has(String(j.source || '').toLowerCase())) {
    return { verdict: 'rehost', offer };
  }
  if (!titleFilter(title)) return { verdict: 'title', offer };

  // Age is a HARD filter here, not a note: the API's posted_within_days is
  // best-effort and rows without a timestamp slip through it.
  const age = ageDays(j, now);
  if (age !== null && age > maxAgeDays) return { verdict: 'stale', offer };

  if (seenUrls.has(url)) return { verdict: 'dupe', offer };
  if (seenCompanyRoles.has(`${company.toLowerCase()}::${title.toLowerCase()}`)) {
    return { verdict: 'dupe', offer };
  }
  return { verdict: 'keep', offer };
}

// == Self-test (offline, fixture-driven, no network) =================
//
// The freehire API is a third-party service with no SLA, and this repo has been
// bitten by feeds whose shape moved. tests/fixtures/freehire-search.json is a
// REAL captured response, so this pins the parse + gate behaviour without a
// network round-trip.

function selfTest() {
  const fx = JSON.parse(readFileSync(join(P.root, 'tests/fixtures/freehire-search.json'), 'utf-8'));
  const rows = fx.data || [];
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const titleFilter = buildTitleFilter(config.title_filter);
  const now = Date.parse('2026-08-09T00:00:00Z');

  let failures = 0;
  const check = (name, cond) => { if (!cond) { failures++; console.log(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };
  const classify = (extra = {}) => rows.map(j => classifyRow(j, {
    titleFilter, seenUrls: new Set(), seenCompanyRoles: new Set(),
    maxAgeDays: 100000, now, ...extra,
  }));

  console.log('fixture:');
  check('fixture has rows', rows.length > 0);

  console.log('parse:');
  const all = classify();
  check('every row yields an offer', all.every(r => r.offer !== null));
  check('strips utm_ attribution from urls', all.every(r => !/utm_/.test(r.offer.url)));
  check('keeps the employer host', all.some(r => /myworkdayjobs\.com|ashbyhq\.com/.test(r.offer.url)));
  check('company and title populated', all.every(r => r.offer.company && r.offer.title));
  check('source stamped as freehire', all.every(r => r.offer.source === SOURCE_ID));

  console.log('gates:');
  check('drops the recruiter title', all.some(r => r.verdict === 'title' && /Recruiter/i.test(r.offer.title)));
  check('keeps at least one new-grad engineering role', all.some(r => r.verdict === 'keep'));
  check('never keeps an intern title', all.filter(r => r.verdict === 'keep').every(r => !/\bintern(ship)?\b/i.test(r.offer.title)));

  const stale = classify({ maxAgeDays: 0 });
  check('age gate drops dated rows at maxAge 0', stale.some(r => r.verdict === 'stale'));

  const dupeUrls = new Set(all.map(r => r.offer.url));
  const dupes = rows.map(j => classifyRow(j, {
    titleFilter, seenUrls: dupeUrls, seenCompanyRoles: new Set(), maxAgeDays: 100000, now,
  }));
  check('url dedup drops everything already seen', dupes.every(r => r.verdict !== 'keep'));

  console.log('re-host handling:');
  const fake = { title: 'Software Engineer, New Grad', url: 'https://www.whatjobs.com/x', company: 'Acme', source: 'whatjobs' };
  check('drops a re-hosted row by default',
    classifyRow(fake, { titleFilter, seenUrls: new Set(), seenCompanyRoles: new Set(), maxAgeDays: 100000, now }).verdict === 'rehost');
  check('--all-sources keeps it',
    classifyRow(fake, { titleFilter, seenUrls: new Set(), seenCompanyRoles: new Set(), maxAgeDays: 100000, now, allSources: true }).verdict === 'keep');

  console.log('unusable rows:');
  check('a row with no url is skipped, not kept',
    classifyRow({ title: 'SWE', url: '' }, { titleFilter, seenUrls: new Set(), seenCompanyRoles: new Set(), maxAgeDays: 100000, now }).verdict === 'skip');

  console.log(failures === 0 ? '\nself-test PASSED' : `\nself-test FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (process.argv.includes('--self-test')) return selfTest();
  const queries = opts.query ? [opts.query] : DEFAULT_QUERIES;

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found.');
    process.exit(1);
  }
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const titleFilter = buildTitleFilter(config.title_filter);

  console.log(`freehire scan — ${queries.length} queries, country=${opts.country}, <=${opts.days}d, ${opts.pages} page(s) each`);
  console.log(`Re-hosted rows: ${opts.allSources ? 'KEPT (--all-sources)' : 'dropped (default)'}`);
  if (opts.dryRun) console.log('(dry run — no files will be written)');

  const seenUrls = loadSeenUrls({ scanHistoryPath: SCAN_HISTORY_PATH, applicationsPath: APPLICATIONS_PATH });
  const seenCompanyRoles = loadSeenCompanyRoles({ applicationsPath: APPLICATIONS_PATH, portalsPath: PORTALS_PATH });

  const now = Date.now();
  const date = new Date().toISOString().slice(0, 10);
  const newOffers = [];
  const staleRows = [];
  const errors = [];
  let totalFound = 0, filteredTitle = 0, filteredRehost = 0, filteredStale = 0, dupes = 0;

  for (const query of queries) {
    for (let page = 0; page < opts.pages; page++) {
      let rows;
      try {
        ({ rows } = await searchPage(query, opts, page));
      } catch (err) {
        errors.push({ query, page, error: err.message });
        break;
      }
      if (rows.length === 0) break;
      totalFound += rows.length;

      for (const j of rows) {
        const { verdict, offer } = classifyRow(j, {
          titleFilter, seenUrls, seenCompanyRoles,
          maxAgeDays: opts.days, allSources: opts.allSources, now,
        });
        if (verdict === 'skip') continue;
        if (verdict === 'rehost') { filteredRehost++; continue; }
        if (verdict === 'title') { filteredTitle++; continue; }
        if (verdict === 'stale') { filteredStale++; staleRows.push(offer); continue; }
        if (verdict === 'dupe') { dupes++; continue; }
        seenUrls.add(offer.url);
        seenCompanyRoles.add(`${offer.company.toLowerCase()}::${offer.title.toLowerCase()}`);
        newOffers.push(offer);
      }
      if (rows.length < PAGE_SIZE) break; // last page for this query
    }
  }

  let resultsPath = null;
  if (!opts.dryRun && newOffers.length > 0) {
    resultsPath = writeScanResults(newOffers, date, P.dataDir);
    appendToScanHistory(newOffers, date, SCAN_HISTORY_PATH);
  }
  // Stale drops are logged even on an otherwise empty run so per-source yields
  // stay honest (see memory reference_src_token_analytics).
  if (!opts.dryRun) logSkipped(staleRows, date, SCAN_HISTORY_PATH, 'skipped_stale');

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`freehire Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Rows returned:         ${totalFound}`);
  console.log(`Dropped (re-host):     ${filteredRehost}`);
  console.log(`Dropped (title):       ${filteredTitle}`);
  console.log(`Dropped (>${opts.days}d):        ${filteredStale}`);
  console.log(`Duplicates:            ${dupes}`);
  console.log(`New candidates:        ${newOffers.length}`);

  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ "${e.query}" p${e.page}: ${e.error}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew candidates:');
    for (const o of newOffers.slice(0, 25)) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (newOffers.length > 25) console.log(`  ... and ${newOffers.length - 25} more`);
    if (opts.dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nCandidates written to ${resultsPath}`);
      console.log(`\n→ Liveness gate REQUIRED before any eval agent is dispatched:`);
      console.log(`  extract survivor URLs from ${resultsPath} into /tmp/scan-urls.txt, then run`);
      console.log(`  npm run liveness:bulk -- /tmp/scan-urls.txt /tmp/scan-liveness.tsv`);
      console.log(`  Drop every URL classified 'expired' (log skipped_expired in scan-history).`);
      console.log(`→ Then evaluate every survivor via auto-pipeline and delete the TSV.`);
    }
  } else if (!opts.dryRun) {
    console.log('\n(no new candidates — nothing to evaluate)');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
