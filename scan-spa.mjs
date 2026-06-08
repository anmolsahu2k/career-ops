#!/usr/bin/env node

/**
 * scan-spa.mjs — Playwright-based scanner for SPA / no-API companies
 *
 * Companion to scan.mjs. Where scan.mjs handles Greenhouse/Ashby/Lever via
 * JSON APIs (zero browser overhead), this script handles the long tail of
 * companies that require browser rendering: Workable (Cloudflare-protected),
 * Workday, iCIMS, custom careers SPAs.
 *
 * Triggered by portals.yml entries with `scan_method: playwright` and a
 * `playwright_provider` (workable|generic) that selects the extractor.
 *
 * Output: same data/scan-results-{date}.tsv format as scan.mjs (the inline
 * eval workflow consumes both uniformly). Appends to data/scan-history.tsv.
 *
 * Zero Claude API tokens. Pure Playwright + DOM extraction.
 *
 * Usage:
 *   node scan-spa.mjs                            # scan all enabled SPA entries
 *   node scan-spa.mjs --dry-run                  # preview without writing
 *   node scan-spa.mjs --company "Hugging Face"   # single-company scan
 *
 * Adding a new provider:
 *   1. Write a `extract<Name>(page, sourceName)` async function that
 *      runs page.evaluate(...) and returns { title, url, location }[].
 *   2. Add it to the EXTRACTORS map.
 *   3. Tag the relevant portals.yml entry with `playwright_provider: <name>`.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { resolvePaths } from './lib/paths.mjs';

const P = resolvePaths(import.meta.url);
const PORTALS_PATH = P.portalsFile;                            // shared root config
const SCAN_HISTORY_PATH = join(P.dataDir, 'scan-history.tsv');
const APPLICATIONS_PATH = P.appsFile;
const SCAN_RESULTS_PATH = (date) => join(P.dataDir, `scan-results-${date}.tsv`);

mkdirSync(P.dataDir, { recursive: true });

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const NAV_TIMEOUT_MS = 30000;
const HYDRATION_MS = 6000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Title filter (logic shared with scan.mjs) ───────────────────────

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

// ── Per-provider extractors ─────────────────────────────────────────

async function extractWorkable(page, sourceName) {
  return await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/j/"]');
    return Array.from(links).map(a => {
      const li = a.closest('li') || a.parentElement;
      const liText = (li?.innerText || '').trim().replace(/\s+/g, ' ');
      // Workable renders title + metadata (location, dept, type) in the same
      // container. Title is everything before the first location/work-mode marker.
      const m = liText.match(/^(.+?)\s+(Remote|Onsite|On-site|Hybrid|In-Office|In office)/i);
      const title = m ? m[1].trim() : liText.split(/[\n\r]/)[0].trim();
      const rest = m ? liText.slice(m[0].length).trim() : '';
      const locMatch = rest.match(/^([A-Z][^,]+(?:,\s*[A-Z][^,]+)*)/);
      const location = locMatch ? locMatch[1].slice(0, 100) : '';
      return { title, url: a.href, location };
    }).filter(j => j.title && j.url);
  });
}

async function extractGeneric(page, sourceName) {
  // Heuristic for unknown SPAs: find <a> elements whose href contains a job-
  // listing path segment, and pull text from the link or nearest heading.
  // Lossy by design — per-company custom extractors will always do better.
  return await page.evaluate(() => {
    const seen = new Set();
    const jobs = [];
    for (const a of document.querySelectorAll('a')) {
      const href = a.href || '';
      if (!/\/(jobs?|careers?|positions?|openings?|j)\//i.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      let title = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
      if (!title) {
        const h = a.closest('article, li, div')?.querySelector('h1, h2, h3, h4');
        title = (h?.innerText || '').trim();
      }
      if (title && title.length > 4 && title.length < 200) {
        jobs.push({ title, url: href, location: '' });
      }
    }
    return jobs;
  });
}

const EXTRACTORS = { workable: extractWorkable, generic: extractGeneric };

// ── Dedup (mirrors scan.mjs) ────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const m of text.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(m[0]);
  }
  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const m of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const co = m[1].trim().toLowerCase();
      const role = m[2].trim().toLowerCase();
      if (co && role && co !== 'company') seen.add(`${co}::${role}`);
    }
  }
  return seen;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found.');
    process.exit(1);
  }

  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const titleFilter = buildTitleFilter(config.title_filter);

  const targets = (config.tracked_companies || [])
    .filter(c => c.enabled !== false)
    .filter(c => c.scan_method === 'playwright')
    .filter(c => c.playwright_provider && EXTRACTORS[c.playwright_provider])
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));

  if (targets.length === 0) {
    console.log('No SPA companies to scan (no enabled entries with scan_method: playwright + supported playwright_provider).');
    return;
  }

  console.log(`Scanning ${targets.length} SPA companies via Playwright (concurrency=${CONCURRENCY})`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();
  const date = new Date().toISOString().slice(0, 10);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA });

  let totalFound = 0, totalFiltered = 0, totalDupes = 0;
  const newOffers = [];
  const errors = [];
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= targets.length) return;
      const company = targets[i];
      const page = await context.newPage();
      try {
        await page.goto(company.careers_url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await page.waitForTimeout(HYDRATION_MS);
        const extractor = EXTRACTORS[company.playwright_provider];
        const jobs = await extractor(page, company.name);
        totalFound += jobs.length;
        for (const job of jobs) {
          if (!titleFilter(job.title)) { totalFiltered++; continue; }
          if (seenUrls.has(job.url)) { totalDupes++; continue; }
          const key = `${company.name.toLowerCase()}::${job.title.toLowerCase()}`;
          if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
          seenUrls.add(job.url);
          seenCompanyRoles.add(key);
          newOffers.push({ ...job, company: company.name, source: `playwright-${company.playwright_provider}` });
        }
      } catch (err) {
        errors.push({ company: company.name, error: err.message.split('\n')[0] });
      } finally {
        await page.close().catch(() => {});
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));
  await browser.close();

  // Write/append results — same TSV format as scan.mjs so the inline-eval
  // workflow handles both sources without branching.
  let resultsPath = null;
  if (!dryRun && newOffers.length > 0) {
    resultsPath = SCAN_RESULTS_PATH(date);
    const header = 'url\tcompany\ttitle\tlocation\tsource\n';
    const rows = newOffers.map(o => `${o.url}\t${o.company}\t${o.title}\t${o.location || ''}\t${o.source}`).join('\n') + '\n';
    if (existsSync(resultsPath)) {
      appendFileSync(resultsPath, rows, 'utf-8');
    } else {
      writeFileSync(resultsPath, header + rows, 'utf-8');
    }
    if (!existsSync(SCAN_HISTORY_PATH)) {
      writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
    }
    const histLines = newOffers.map(o => `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`).join('\n') + '\n';
    appendFileSync(SCAN_HISTORY_PATH, histLines, 'utf-8');
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`SPA Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);
  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.company}: ${e.error}`);
  }
  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    if (!dryRun) console.log(`\nResults: ${resultsPath}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
