#!/usr/bin/env node
/**
 * liveness-parallel.mjs — fast bulk liveness checker
 *
 * Runs the liveness-core classifier across many URLs concurrently, sharing
 * one Chromium instance. Use this instead of check-liveness.mjs when you
 * have more than a handful of URLs.
 *
 * Usage:
 *   # From a list of URLs:
 *   CONCURRENCY=20 node liveness-parallel.mjs urls.txt out.tsv
 *
 *   # From the live aggregator TSVs (auto-extract):
 *   node liveness-parallel.mjs --from-batch out.tsv
 *
 * Output TSV columns: url \t result \t status \t reason
 *
 * Recommended cadence: run before any bulk eval-agent dispatch to drop
 * dead URLs and save Claude tokens. ~140s wall time for 750 URLs at
 * CONCURRENCY=20. Zero Claude API tokens (pure Playwright).
 */

import { chromium } from 'playwright';
import { readFile, writeFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyLiveness, isSpaHost } from './liveness-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '20', 10);

async function urlsFromBatch() {
  const dir = join(HERE, 'batch/tracker-additions');
  // All discovery sources (aggregator, jobspy, handshake, ...) write *.tsv into
  // batch/tracker-additions/ and the canonical pipeline gates them all the same
  // way. Glob all tsvs, not just one source's. Skip the merged/ subdirectory.
  const files = (await readdir(dir)).filter(f => f.endsWith('.tsv'));
  const urls = new Set();
  const URL_RE = /\*\*URL:\*\*\s*(\S+)/;
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf-8');
    const line = text.split('\n')[0];
    const parts = line.split('\t');
    const notes = parts[8] || '';
    const reportCell = parts[7] || '';
    let m = notes.match(/URL:\s*(\S+)/);
    if (m) { urls.add(m[1].replace(/[.,]+$/, '')); continue; }
    const rp = (reportCell.match(/\(([^)]+\.md)\)/) || [])[1];
    if (rp) {
      try {
        const reportText = await readFile(join(HERE, rp), 'utf-8');
        const m2 = reportText.match(URL_RE);
        if (m2) urls.add(m2[1].replace(/[.,]+$/, ''));
      } catch (e) { /* report not found, skip */ }
    }
  }
  return Array.from(urls);
}

const args = process.argv.slice(2);
const fromBatch = args[0] === '--from-batch';
const URLS_FILE = fromBatch ? null : (args[0] || '/tmp/liveness-urls.txt');
const OUT_FILE = fromBatch ? (args[1] || '/tmp/liveness-results.tsv') : (args[1] || '/tmp/liveness-results.tsv');

async function checkUrl(context, url) {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = response?.status() ?? 0;
    // SPA hosts (Workday, iCIMS, Lever, etc.) need longer hydration before
    // their apply button is visible to document.querySelectorAll().
    await page.waitForTimeout(isSpaHost(page.url()) ? 5000 : 2000);
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const applyControls = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]')
      );
      return candidates
        .filter((el) => {
          if (el.closest('nav, header, footer')) return false;
          if (el.closest('[aria-hidden="true"]')) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (!el.getClientRects().length) return false;
          return Array.from(el.getClientRects()).some((r) => r.width > 0 && r.height > 0);
        })
        .map((el) => [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title')]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    });
    const out = classifyLiveness({ status, finalUrl, bodyText, applyControls });
    return { ...out, status };
  } catch (err) {
    return { result: 'expired', reason: `nav error: ${err.message.split('\n')[0]}`, status: 0 };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  let urls;
  if (fromBatch) {
    urls = await urlsFromBatch();
    console.error(`Extracted ${urls.length} URLs from batch/tracker-additions/*.tsv`);
  } else {
    const text = await readFile(URLS_FILE, 'utf-8');
    urls = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  }
  console.error(`Checking ${urls.length} URLs with concurrency=${CONCURRENCY}`);
  const start = Date.now();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  const results = new Array(urls.length);
  let next = 0, done = 0;
  let active = 0, expired = 0, uncertain = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= urls.length) return;
      const url = urls[i];
      const r = await checkUrl(context, url);
      results[i] = { url, ...r };
      done++;
      if (r.result === 'active') active++;
      else if (r.result === 'expired') expired++;
      else uncertain++;
      if (done % 25 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.error(`  ${done}/${urls.length} done (${active}A ${expired}X ${uncertain}? in ${elapsed}s)`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await browser.close();

  // Write TSV: url \t result \t status \t reason
  const lines = results.map(r => [r.url, r.result, r.status ?? 0, (r.reason ?? '').replace(/\t/g, ' ')].join('\t'));
  await writeFile(OUT_FILE, lines.join('\n') + '\n');

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.error(`\nDone in ${elapsed}s. ${active} active, ${expired} expired, ${uncertain} uncertain.`);
  console.error(`Results: ${OUT_FILE}`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
