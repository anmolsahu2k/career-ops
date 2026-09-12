#!/usr/bin/env node

/**
 * scan-linkedin.mjs — LinkedIn public jobs-guest scanner (OPT-IN, personal use)
 *
 * Hits LinkedIn's public `jobs-guest` endpoints, the same ones an anonymous
 * browser loads: no auth, no API key, no logged-in surfaces. LinkedIn
 * nonetheless prohibits automated access in its Terms of Service, so this
 * scanner is:
 *
 *   - NOT part of `/career-ops scan` — it never runs in the default sweep.
 *   - Disabled until `linkedin_guest.enabled: true` is set in portals.yml, so
 *     the ToS call is made once, deliberately, in config — not implicitly on
 *     every run.
 *   - Paced sequentially (REQUEST_DELAY_MS) with a hard per-run request ceiling.
 *
 * `linkedin-hiring-searches.mjs` remains the zero-exposure path: it only
 * generates search URLs for the user to click. Prefer it when it suffices.
 *
 * Quality caveat: rows land as `linkedin.com/jobs/view/{id}` URLs — LinkedIn's
 * MIRROR of the posting, not the employer's own req page. The liveness gate and
 * preflight-ats.mjs both read the employer ATS, so an eval agent must resolve
 * the real apply URL from the LinkedIn page before scoring. Every row carries a
 * `LINKEDIN-MIRROR` Notes prefix to force that step.
 *
 * Survivors land in the same per-date handoff TSV and scan-history ledger as
 * every other scanner, under `SRC: linkedin-guest`.
 *
 * Usage:
 *   node scan-linkedin.mjs --dry-run
 *   node scan-linkedin.mjs --query "ml engineer" --location "Remote"
 *   node scan-linkedin.mjs --days 14 --pages 2 --remote remote
 *   node scan-linkedin.mjs --self-test      # offline fixture test, no network
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
const SCAN_HISTORY_PATH = join(P.dataDir, 'scan-history.tsv');
mkdirSync(P.dataDir, { recursive: true });

const SOURCE_ID = 'linkedin-guest';
const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const PAGE_SIZE = 10;            // fixed by the endpoint
const FETCH_TIMEOUT_MS = 20_000;
const REQUEST_DELAY_MS = 3_000;  // deliberately slow: keep volume low, stay polite
const MAX_REQUESTS = 40;         // hard ceiling per invocation
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_QUERIES = [
  'new grad software engineer',
  'entry level software engineer',
  'machine learning engineer new grad',
  'data scientist new grad',
];

const WORK_TYPE = { onsite: '1', remote: '2', hybrid: '3' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Fetch ───────────────────────────────────────────────────────────

async function fetchHtml(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    // 429 is LinkedIn telling us to slow down. Back off, then give up on this
    // query rather than hammering — the volume rule is the whole point.
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 2) {
        clearTimeout(timer);
        await sleep(REQUEST_DELAY_MS * (attempt + 2));
        return fetchHtml(url, attempt + 1);
      }
      throw new Error(`HTTP ${res.status} (backed off, giving up)`);
    }
    if (res.status === 404) return '';   // past the last page
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Posted-within window as LinkedIn's f_TPR seconds value. */
export function daysToTPR(days) {
  if (!days || days <= 0) return null;
  return `r${days * 86400}`;
}

export function buildUrl(query, opts, page) {
  const p = new URLSearchParams();
  if (query) p.set('keywords', query);
  if (opts.location) p.set('location', opts.location);
  const tpr = daysToTPR(opts.days);
  if (tpr) p.set('f_TPR', tpr);
  const wt = WORK_TYPE[String(opts.remote || '').toLowerCase()];
  if (wt) p.set('f_WT', wt);
  p.set('start', String(page * PAGE_SIZE));
  return `${SEARCH_URL}?${p}`;
}

// ── Parse ───────────────────────────────────────────────────────────

/** Decode the handful of entities that show up in card text. */
function decode(s) {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function firstMatch(chunk, ...regexes) {
  for (const re of regexes) {
    const m = chunk.match(re);
    if (m && decode(m[1])) return decode(m[1]);
  }
  return '';
}

/**
 * Parse job cards out of a search response.
 *
 * Split on the posting URN rather than `<li>`: the URN is the one token the
 * endpoint is guaranteed to emit per card, so a markup reshuffle costs fields,
 * not the whole page. The canonical URL is REBUILT from the posting id — the
 * href in the card carries per-impression tracking params that would defeat URL
 * dedup across runs.
 */
export function parseJobCards(html) {
  const cards = [];
  for (const chunk of String(html).split(/data-entity-urn="urn:li:jobPosting:/).slice(1)) {
    const idMatch = chunk.match(/^(\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const title = firstMatch(chunk,
      /class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/i,
      /class="sr-only"[^>]*>([\s\S]*?)<\/span>/i);
    if (!title) continue;

    // Live markup wraps the company in `hidden-nested-link`; the subtitle <h4>
    // is the fallback when the link is absent.
    const company = firstMatch(chunk,
      /class="hidden-nested-link"[^>]*>([\s\S]*?)<\/a>/i,
      /class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/i);

    cards.push({
      id,
      title,
      company,
      location: firstMatch(chunk, /class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/i),
      source: SOURCE_ID,
      url: `https://www.linkedin.com/jobs/view/${id}`,
      _date: (chunk.match(/datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1] || null,
    });
  }
  return cards;
}

/** Days since the card's posted date, or null when absent. */
export function cardAgeDays(card, now = new Date()) {
  if (!card._date) return null;
  const t = Date.parse(card._date);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/** Apply the intake gates. Same contract as scan-freehire.mjs filterJobs. */
export function filterCards(cards, { titleFilter, seenUrls, seenCompanyRoles, maxAgeDays, now = new Date() }) {
  const kept = [];
  const dropped = { title: [], stale: [], nocompany: [], dupe: [] };

  for (const c of cards) {
    if (!c.url || !c.title) continue;
    if (!titleFilter(c.title)) { dropped.title.push(c); continue; }
    // A card with no company cannot be deduped against the tracker or slugged
    // into a report path, so it is not evaluable.
    if (!c.company) { dropped.nocompany.push(c); continue; }

    const age = cardAgeDays(c, now);
    if (age !== null && age > maxAgeDays) { dropped.stale.push(c); continue; }

    if (seenUrls.has(c.url)) { dropped.dupe.push(c); continue; }
    const key = `${c.company.toLowerCase()}::${c.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key)) { dropped.dupe.push(c); continue; }

    seenUrls.add(c.url);
    seenCompanyRoles.add(key);
    kept.push(c);
  }
  return { kept, dropped };
}

// ── Self-test (offline, no network) ─────────────────────────────────

function selfTest() {
  const html = readFileSync(join(P.root, 'tests/fixtures/linkedin-jobs-guest.html'), 'utf-8');
  const cards = parseJobCards(html);
  let failures = 0;
  const check = (name, cond) => { if (!cond) { failures++; console.log(`  FAIL ${name}`); } else console.log(`  ok   ${name}`); };
  const byId = (id) => cards.find(c => c.id === id);

  console.log('parse:');
  check('parses all 4 well-formed cards, skips the title-less one', cards.length === 4);
  check('extracts title', byId('4111111111')?.title === 'Software Engineer, New Grad (2027)');
  check('extracts company via hidden-nested-link', byId('4111111111')?.company === 'Acme Robotics');
  check('extracts company via subtitle fallback', byId('4444444444')?.company === 'Hooli');
  check('extracts location', byId('4111111111')?.location === 'San Francisco, CA');
  check('extracts the posted date', byId('4111111111')?._date === '2026-08-05');
  check('rebuilds canonical url from posting id (no tracking params)',
    cards.every(c => c.url === `https://www.linkedin.com/jobs/view/${c.id}` && !c.url.includes('?')));
  check('decodes html entities in company', byId('4222222222')?.company === 'Globex & Co');

  console.log('filter:');
  const config = yaml.load(readFileSync(P.portalsFile, 'utf-8'));
  const titleFilter = buildTitleFilter(config.title_filter);
  const now = new Date('2026-08-09T00:00:00Z');
  const { kept, dropped } = filterCards(cards, {
    titleFilter, seenUrls: new Set(), seenCompanyRoles: new Set(), maxAgeDays: 21, now,
  });
  check('drops the intern title', dropped.title.some(c => /Intern/i.test(c.title)));
  check('drops the recruiter title', dropped.title.some(c => /Recruiter/i.test(c.title)));
  check('keeps the new-grad SWE role', kept.some(c => /New Grad/i.test(c.title)));
  check('keeps the new-grad MLE role', kept.some(c => /Machine Learning/i.test(c.title)));
  check('every survivor is within the age window', kept.every(c => (cardAgeDays(c, now) ?? 0) <= 21));

  const tight = filterCards(cards, {
    titleFilter, seenUrls: new Set(), seenCompanyRoles: new Set(), maxAgeDays: 1, now,
  });
  check('age gate drops cards older than the window', tight.dropped.stale.length > 0);

  const dupe = filterCards(cards, {
    titleFilter, seenUrls: new Set(cards.map(c => c.url)), seenCompanyRoles: new Set(), maxAgeDays: 21, now,
  });
  check('url dedup drops everything already seen', dupe.kept.length === 0);

  console.log('url building:');
  check('daysToTPR(7) is r604800', daysToTPR(7) === 'r604800');
  check('daysToTPR(0) is null', daysToTPR(0) === null);
  const u = buildUrl('new grad swe', { location: 'United States', days: 7, remote: 'remote' }, 2);
  check('f_TPR set from days', u.includes('f_TPR=r604800'));
  check('f_WT set from --remote', u.includes('f_WT=2'));
  check('start paginates by 10', u.includes('start=20'));

  console.log(failures === 0 ? '\nself-test PASSED' : `\nself-test FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── Main ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const val = (f, d) => {
    const i = argv.indexOf(f);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    query: val('--query', null),
    location: val('--location', null),
    days: Number(val('--days', NaN)),
    pages: Number(val('--pages', NaN)),
    remote: val('--remote', null), // onsite | remote | hybrid
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  const cli = parseArgs(argv);
  const config = yaml.load(readFileSync(P.portalsFile, 'utf-8'));
  const cfg = config.linkedin_guest || {};

  // Opt-in gate. The ToS tradeoff is the user's call to make once, in config.
  if (cfg.enabled !== true) {
    console.error('scan-linkedin.mjs is OPT-IN and currently disabled.\n');
    console.error('Automated access to LinkedIn is against their Terms of Service. This');
    console.error('scanner exists because the yield is real, but enabling it is your call.\n');
    console.error('To enable, set in portals.yml:\n');
    console.error('  linkedin_guest:');
    console.error('    enabled: true\n');
    console.error('Zero-exposure alternative: `node linkedin-hiring-searches.mjs`, which only');
    console.error('generates search URLs for you to click (no automated fetching at all).');
    process.exit(2);
  }

  const opts = {
    location: cli.location ?? cfg.location ?? 'United States',
    days: Number.isFinite(cli.days) ? cli.days : (cfg.days ?? 21),
    pages: Number.isFinite(cli.pages) ? cli.pages : (cfg.pages ?? 1),
    remote: cli.remote ?? cfg.remote ?? null,
  };
  const queries = cli.query ? [cli.query] : (cfg.queries?.length ? cfg.queries : DEFAULT_QUERIES);

  const titleFilter = buildTitleFilter(config.title_filter);
  const seenUrls = loadSeenUrls({ scanHistoryPath: SCAN_HISTORY_PATH, applicationsPath: P.appsFile });
  const seenCompanyRoles = loadSeenCompanyRoles({ applicationsPath: P.appsFile, portalsPath: P.portalsFile });

  console.log('LinkedIn jobs-guest scan — PERSONAL USE ONLY, keep volume low.');
  console.log(`Queries: ${queries.length} | location="${opts.location}" | <=${opts.days}d | ${opts.pages} page(s) each`);
  console.log(`Pacing: ${REQUEST_DELAY_MS}ms between requests, ceiling ${MAX_REQUESTS}`);
  if (cli.dryRun) console.log('(dry run — no files will be written)');
  console.log();

  const date = new Date().toISOString().slice(0, 10);
  const allKept = [];
  const allDropped = { title: [], stale: [], nocompany: [], dupe: [] };
  let requests = 0, totalCards = 0, emptyPages = 0;
  const errors = [];

  outer:
  for (const query of queries) {
    for (let page = 0; page < opts.pages; page++) {
      if (requests >= MAX_REQUESTS) {
        console.log(`(request ceiling ${MAX_REQUESTS} reached — stopping)`);
        break outer;
      }
      if (requests > 0) await sleep(REQUEST_DELAY_MS);
      requests++;

      let html;
      try {
        html = await fetchHtml(buildUrl(query, opts, page));
      } catch (err) {
        errors.push({ query, page, error: err.message });
        break; // stop paging this query
      }
      const cards = parseJobCards(html);
      totalCards += cards.length;
      if (cards.length === 0 && html.length > 500) emptyPages++;

      const { kept, dropped } = filterCards(cards, { titleFilter, seenUrls, seenCompanyRoles, maxAgeDays: opts.days });
      allKept.push(...kept);
      for (const k of Object.keys(allDropped)) allDropped[k].push(...dropped[k]);

      if (cards.length < PAGE_SIZE) break; // last page
    }
  }

  console.log('━'.repeat(45));
  console.log(`LinkedIn Scan — ${date}`);
  console.log('━'.repeat(45));
  console.log(`Requests made:         ${requests}`);
  console.log(`Cards parsed:          ${totalCards}`);
  console.log(`Filtered by title:     ${allDropped.title.length} removed`);
  console.log(`No company on card:    ${allDropped.nocompany.length} removed`);
  console.log(`Stale (>${opts.days}d):         ${allDropped.stale.length} removed`);
  console.log(`Duplicates:            ${allDropped.dupe.length} skipped`);
  console.log(`New candidates:        ${allKept.length}`);

  // A non-trivial page that yields zero cards means the markup moved, not that
  // LinkedIn ran out of jobs. Say so — a silent 0 reads as "no new roles".
  if (emptyPages > 0) {
    console.log(`\n⚠ ${emptyPages} non-empty page(s) parsed to 0 cards — the card markup may have changed.`);
    console.log('  Re-check the selectors in parseJobCards() against a live response.');
  }
  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors.slice(0, 5)) console.log(`  ✗ "${e.query}" p${e.page}: ${e.error}`);
  }

  if (cli.dryRun) {
    for (const o of allKept.slice(0, 15)) console.log(`  + ${o.title} — ${o.company} (${o.location})`);
    console.log('\n(dry run — run without --dry-run to save results)');
    return;
  }
  if (allKept.length === 0) {
    console.log('\n(no new candidates — nothing to evaluate)');
    return;
  }

  const resultsPath = writeScanResults(allKept, date, P.dataDir);
  appendToScanHistory(allKept, date, SCAN_HISTORY_PATH);
  logSkipped(allDropped.title, date, SCAN_HISTORY_PATH, 'skipped_filter');
  logSkipped(allDropped.nocompany, date, SCAN_HISTORY_PATH, 'skipped_filter');
  logSkipped(allDropped.stale, date, SCAN_HISTORY_PATH, 'skipped_stale');

  console.log(`\nCandidates appended to ${resultsPath}`);
  console.log(`\n→ Liveness gate REQUIRED before any eval agent is dispatched.`);
  console.log(`→ These are LinkedIn MIRROR urls, not employer req pages. Each eval agent must`);
  console.log(`  resolve the real apply URL from the LinkedIn page before scoring, stamp`);
  console.log(`  'LINKEDIN-MIRROR' in Notes, and record SRC: ${SOURCE_ID}.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
