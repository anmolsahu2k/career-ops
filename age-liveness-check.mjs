#!/usr/bin/env node
/**
 * age-liveness-check.mjs — liveness + true-age pass for the 21d hard filter.
 *
 * Extends the liveness-parallel pattern: loads each URL once (shared Chromium),
 * classifies liveness via liveness-core, AND extracts the displayed posting age.
 * Used to prune stale rows before spending eval-agent tokens, per the 21d cutoff
 * (modes/auto-pipeline.md Paso 0.5).
 *
 * Age extraction is deliberately CONSERVATIVE: it takes the MINIMUM of all
 * "N (hour|day|week|month)s ago" matches (plus "posted on <date>"). Aggregator
 * pages (jobright etc.) show an index age that UNDERSTATES true ATS age, so a
 * value > 21 is a safe lower bound => definitely stale => drop. Taking the min
 * guarantees we never false-drop a live job on a stray sidebar date (worst case
 * is a harmless false-keep that the eval-stage gate re-checks).
 *
 * Decision: drop_expired | drop_clearance (citizenship/clearance in body) |
 *           drop_stale (age>21) | keep_fresh | keep_unknown | keep_uncertain
 *
 * Usage: CONCURRENCY=15 node age-liveness-check.mjs urls.txt out.tsv
 * Output TSV: url \t liveness \t status \t age_days \t age_raw \t clearance \t decision
 */

import { chromium } from 'playwright';
import { readFile, writeFile } from 'fs/promises';
import { classifyLiveness, isSpaHost, isClearanceGated } from './liveness-core.mjs';

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '15', 10);
const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS || '21', 10);
const URLS_FILE = process.argv[2] || '/tmp/age-urls.txt';
const OUT_FILE = process.argv[3] || '/tmp/age-results.tsv';

const UNIT_DAYS = { hour: 0, hours: 0, day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30, year: 365, years: 365 };

// Extract a conservative (minimum) posting age in days from page text.
// Returns { days, raw } or { days: null, raw: '' }.
function extractAgeDays(bodyText) {
  const candidates = [];
  // "N unit(s) ago" — the dominant relative form (jobright: "· 1 week ago")
  const relRe = /(\d+)\s+(hour|hours|day|days|week|weeks|month|months|year|years)\s+ago/gi;
  let m;
  while ((m = relRe.exec(bodyText)) !== null) {
    const n = parseInt(m[1], 10);
    const days = n * UNIT_DAYS[m[2].toLowerCase()];
    candidates.push({ days, raw: m[0] });
  }
  // "today" / "just posted" / "posted today" => 0 days
  if (/\b(posted\s+today|just\s+posted|posted\s+moments?\s+ago)\b/i.test(bodyText)) {
    candidates.push({ days: 0, raw: 'today' });
  }
  // "Posted on <date>" — only with an explicit "posted" prefix (avoid copyright years)
  const absRe = /posted\s+(?:on\s+)?(\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2},? \d{4})/gi;
  while ((m = absRe.exec(bodyText)) !== null) {
    const d = new Date(m[1]);
    if (!isNaN(d)) {
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days >= 0 && days < 3650) candidates.push({ days, raw: m[0] });
    }
  }
  if (!candidates.length) return { days: null, raw: '' };
  // MIN — the safe choice: only drop when even the freshest reading is > cutoff.
  return candidates.reduce((a, b) => (b.days < a.days ? b : a));
}

async function checkUrl(context, url) {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = response?.status() ?? 0;
    await page.waitForTimeout(isSpaHost(page.url()) ? 5000 : 2000);
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const applyControls = await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]'));
      return c.filter((el) => {
        if (el.closest('nav, header, footer')) return false;
        if (el.closest('[aria-hidden="true"]')) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
      }).map((el) => [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    });
    const live = classifyLiveness({ status, finalUrl, bodyText, applyControls });
    const age = extractAgeDays(bodyText);
    const clearance = isClearanceGated(bodyText);
    return { liveness: live.result, status, age_days: age.days, age_raw: age.raw, clearance };
  } catch (err) {
    return { liveness: 'expired', status: 0, age_days: null, age_raw: `nav error: ${err.message.split('\n')[0]}`, clearance: false };
  } finally {
    await page.close().catch(() => {});
  }
}

function decide(r) {
  if (r.liveness === 'expired') return 'drop_expired';
  if (r.clearance) return 'drop_clearance';
  if (r.age_days != null && r.age_days > MAX_AGE_DAYS) return 'drop_stale';
  if (r.age_days == null) return r.liveness === 'uncertain' ? 'keep_uncertain' : 'keep_unknown';
  return 'keep_fresh';
}

async function main() {
  const text = await readFile(URLS_FILE, 'utf-8');
  const urls = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  console.error(`Checking ${urls.length} URLs (concurrency=${CONCURRENCY}, cutoff=${MAX_AGE_DAYS}d)`);
  const start = Date.now();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const results = new Array(urls.length);
  let next = 0, done = 0;
  const tally = {};

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= urls.length) return;
      const r = await checkUrl(context, urls[i]);
      const decision = decide(r);
      results[i] = { url: urls[i], ...r, decision };
      tally[decision] = (tally[decision] || 0) + 1;
      done++;
      if (done % 25 === 0) {
        const el = ((Date.now() - start) / 1000).toFixed(0);
        console.error(`  ${done}/${urls.length} (${el}s) ${JSON.stringify(tally)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await browser.close();

  const lines = results.map(r => [r.url, r.liveness, r.status ?? 0, r.age_days ?? '', (r.age_raw ?? '').replace(/\t/g, ' '), r.clearance ? 'clearance' : '', r.decision].join('\t'));
  await writeFile(OUT_FILE, lines.join('\n') + '\n');
  const el = ((Date.now() - start) / 1000).toFixed(0);
  console.error(`\nDone in ${el}s. ${JSON.stringify(tally)}`);
  console.error(`Results: ${OUT_FILE}`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
