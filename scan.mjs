#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against scan-history.tsv +
 * applications.md, and writes new offers to a transient TSV at
 * data/scan-results-{YYYY-MM-DD}.tsv for IMMEDIATE evaluation by the
 * /career-ops scan skill workflow.
 *
 * No triage state: this script does NOT write to data/pipeline.md.
 * The skill workflow reads the transient TSV, evaluates each new
 * candidate inline, and discards the TSV when done.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const APPLICATIONS_PATH = 'data/applications.md';
const SCAN_RESULTS_PATH = (date) => `data/scan-results-${date}.tsv`;

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Explicit api field — autodetect ATS by URL pattern.
  // Useful when careers_url is the company's custom careers page (e.g.
  // langfuse.com/careers) but the underlying ATS is Greenhouse/Ashby/Lever/Workday.
  if (company.api) {
    if (company.api.includes('greenhouse')) return { type: 'greenhouse', url: company.api };
    if (company.api.includes('ashbyhq.com')) return { type: 'ashby', url: company.api };
    if (company.api.includes('lever.co'))    return { type: 'lever', url: company.api };
    if (company.api.includes('myworkdayjobs.com') || company.api.includes('myworkdaysite.com')) {
      return { type: 'workday', url: company.api };
    }
  }

  const url = company.careers_url || '';

  // Workday — auto-derive POST endpoint from public careers URL.
  // Pattern: https://{tenant}.{wdN}.myworkdayjobs.com/[locale/]{site}
  // -> POST  https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
  // Approach inspired by kbhujbal/go-get-jobs (workday_main/get_workday_jobs.go).
  const wdMatch = url.match(/https:\/\/([a-z0-9-]+\.wd\d+)\.myworkdayjobs\.com\/(?:[^/]+\/)?([^/?#]+)/);
  if (wdMatch) {
    const tenant = wdMatch[1].split('.')[0];
    return {
      type: 'workday',
      url: `https://${wdMatch[1]}.myworkdayjobs.com/wday/cxs/${tenant}/${wdMatch[2]}/jobs`,
    };
  }

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Workday (POST endpoint with pagination) ─────────────────────────
//
// Workday tenants expose a documented-but-unofficial JSON POST API at
// {tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs that
// returns 20 postings per page with a `total` field. Approach ported
// from kbhujbal/go-get-jobs.
//
// We cap at WORKDAY_MAX_PAGES (50 pages = 1000 jobs) per company since
// Workday tenants can have 5000+ active reqs and our title filter
// rejects ~99% anyway. Workday sorts by post date desc by default, so
// the first 50 pages cover all recent postings.

const WORKDAY_MAX_PAGES = 50;
const WORKDAY_LIMIT = 20;

async function postWorkdayPage(jobsUrl, offset) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(jobsUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_LIMIT, offset, searchText: '' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWorkdayJobs(jobsUrl, companyName, preUrlOverride) {
  // Derive PreURL from the API URL so we can build full job links.
  // Input:  https://salesforce.wd12.myworkdayjobs.com/wday/cxs/salesforce/External_Career_Site/jobs
  // Output: https://salesforce.wd12.myworkdayjobs.com/en-US/External_Career_Site
  // Override: companies on the alternate `wd*.myworkdaysite.com` recruiting
  // domain use a different public-face pattern (/en-US/recruiting/{tenant}/{site}),
  // so portals.yml can pass `workday_pre_url:` to skip the derivation.
  let preUrl;
  if (preUrlOverride) {
    preUrl = preUrlOverride;
  } else {
    const m = jobsUrl.match(/^(https:\/\/[^/]+)\/wday\/cxs\/[^/]+\/([^/]+)\/jobs$/);
    if (!m) throw new Error(`bad workday URL: ${jobsUrl}`);
    preUrl = `${m[1]}/en-US/${m[2]}`;
  }

  const first = await postWorkdayPage(jobsUrl, 0);
  const allJobs = [...(first.jobPostings || [])];
  const total = first.total || 0;

  const remainingPages = Math.min(
    Math.ceil(total / WORKDAY_LIMIT) - 1,
    WORKDAY_MAX_PAGES - 1,
  );
  if (remainingPages > 0) {
    const offsets = Array.from({ length: remainingPages }, (_, i) => (i + 1) * WORKDAY_LIMIT);
    const pages = await Promise.all(
      offsets.map(o => postWorkdayPage(jobsUrl, o).catch(() => ({ jobPostings: [] })))
    );
    for (const p of pages) allJobs.push(...(p.jobPostings || []));
  }

  return allJobs.map(j => ({
    title: j.title || '',
    url: preUrl + (j.externalPath || ''),
    company: companyName,
    location: j.locationsText || '',
  }));
}

// ── External board parsers ──────────────────────────────────────────
//
// External boards are niche aggregators (moaijobs, agentic-engineering-jobs,
// deeplearningjobs). Two feed shapes are supported: structured JSON and
// XML sitemap. Boards with feed_type: none are documented config only and
// require WebSearch fallback at the skill-workflow level.

function parseExternalJson(json, sourceName) {
  // Tolerant parser for { data: [...] } (agentic API) and { jobs: [...] } shapes.
  const items = json.data || json.jobs || [];
  return items.map(j => {
    const url = j.applyMethods?.[0]?.value || j.url || j.jobUrl || j.absolute_url || '';
    return {
      title: j.title || '',
      url,
      company: j.companyName || j.company || sourceName,
      location: j.location || j.city || '',
    };
  }).filter(o => o.url && o.title);
}

function parseSitemapXml(xml, sourceName, urlPattern) {
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const filtered = urlPattern ? urls.filter(u => u.includes(urlPattern)) : urls;
  return filtered.map(u => {
    const segments = u.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    // Strip a trailing -{digits} ID suffix (moai pattern: /job/{title-slug}-{id})
    const titleSlug = last.replace(/-\d+$/, '');
    const title = titleSlug.replace(/-/g, ' ').trim();
    // For /jobs/{company}/{role} (deeplearningjobs), the second-to-last
    // segment is the company. For /job/{slug-id} (moai), no company info.
    const company = (urlPattern === '/jobs/' && segments.length >= 2)
      ? segments[segments.length - 2].replace(/-/g, ' ')
      : sourceName;
    return { title, url: u, company, location: '' };
  }).filter(o => o.title);
}

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  const mustMatch = titleFilter?.must_match ? new RegExp(titleFilter.must_match, 'i') : null;

  return (title) => {
    if (mustMatch && !mustMatch.test(title)) return false;
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

// Brand-alias map: subsidiary slug -> canonical parent slug, loaded from portals.yml.
// Same map drives merge-tracker.mjs. Used to fold dedup keys so the same posting
// hitting the pipeline under "NetSuite" matches one already in tracker as "Oracle".
let _companyAliases = null;
function loadCompanyAliasesScan() {
  if (_companyAliases) return _companyAliases;
  _companyAliases = {};
  const portalsPath = './portals.yml';
  if (!existsSync(portalsPath)) return _companyAliases;
  const lines = readFileSync(portalsPath, 'utf-8').split('\n');
  let inAliases = false;
  for (const line of lines) {
    if (/^company_aliases:\s*$/.test(line)) { inAliases = true; continue; }
    if (inAliases) {
      if (/^\S/.test(line) && !/^#/.test(line)) break;
      const m = line.match(/^\s+([a-z0-9-]+):\s*([a-z0-9-]+)\s*(#.*)?$/);
      if (m) _companyAliases[m[1]] = m[2];
    }
  }
  return _companyAliases;
}
function aliasResolve(name) {
  const aliases = loadCompanyAliasesScan();
  const dashed = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return aliases[dashed] || dashed;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        // Fold to canonical parent slug so subsidiary mentions match parent rows.
        const canonical = aliasResolve(company);
        seen.add(`${canonical}::${role}`);
        if (canonical !== company) seen.add(`${company}::${role}`); // also keep raw for legacy
      }
    }
  }
  return seen;
}

// ── Scan-results writer (transient, consumed by skill workflow) ─────

function writeScanResults(offers, date) {
  if (offers.length === 0) return null;

  const path = SCAN_RESULTS_PATH(date);
  const header = 'url\tcompany\ttitle\tlocation\tsource\n';
  const rows = offers.map(o =>
    `${o.url}\t${o.company}\t${o.title}\t${o.location || ''}\t${o.source}`
  ).join('\n') + '\n';

  writeFileSync(path, header + rows, 'utf-8');
  return path;
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      let jobs;
      if (type === 'workday') {
        jobs = await fetchWorkdayJobs(url, company.name, company.workday_pre_url);
      } else {
        const json = await fetchJson(url);
        jobs = PARSERS[type](json, company.name);
      }
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 4b. External-board scan (aggregator sites with structured feeds).
  // feed_type: none entries are skipped here; they require Claude WebSearch
  // at the skill-workflow level (out of scope for this zero-token scanner).
  const externalBoards = (config.external_boards || [])
    .filter(b => b.enabled !== false)
    .filter(b => b.feed_type === 'json' || b.feed_type === 'sitemap')
    .filter(b => !filterCompany || b.name.toLowerCase().includes(filterCompany));

  const externalSkipped = (config.external_boards || []).filter(
    b => b.enabled === false || b.feed_type === 'none'
  ).length;

  console.log(`Scanning ${externalBoards.length} external boards via feed (${externalSkipped} skipped — no structured feed)`);

  const externalTasks = externalBoards.map(board => async () => {
    try {
      let jobs;
      if (board.feed_type === 'json') {
        const json = await fetchJson(board.feed_url);
        jobs = parseExternalJson(json, board.name);
      } else {
        // sitemap
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(board.feed_url, { signal: ctrl.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const xml = await res.text();
          jobs = parseSitemapXml(xml, board.name, board.url_pattern);
        } finally {
          clearTimeout(timer);
        }
      }

      totalFound += jobs.length;
      for (const job of jobs) {
        if (!titleFilter(job.title)) { totalFiltered++; continue; }
        if (seenUrls.has(job.url)) { totalDupes++; continue; }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `external-${board.name}` });
      }
    } catch (err) {
      errors.push({ company: `[external] ${board.name}`, error: err.message });
    }
  });

  await parallelFetch(externalTasks, CONCURRENCY);

  // 5. Write results
  let resultsPath = null;
  if (!dryRun && newOffers.length > 0) {
    resultsPath = writeScanResults(newOffers, date);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`External boards:       ${externalBoards.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nCandidates written to ${resultsPath}`);
      console.log(`scan-history updated at ${SCAN_HISTORY_PATH}`);
      console.log(`\n→ Inline evaluation REQUIRED: per the no-triage-state rule,`);
      console.log(`  the skill workflow must now evaluate every row in ${resultsPath}`);
      console.log(`  through auto-pipeline before this scan is considered complete.`);
      console.log(`  Delete ${resultsPath} after evaluation.`);
    }
  } else if (!dryRun) {
    console.log('\n(no new candidates — nothing to evaluate)');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
