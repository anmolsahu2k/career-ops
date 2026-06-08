#!/usr/bin/env python3
"""startupjobs-ingest.py - startup.jobs adapter for career-ops discovery.

startup.jobs is Cloudflare-protected (returns "Just a moment..." to plain
curl), so this adapter uses Playwright via subprocess to render the search
results and parse the visible job cards. Slower than HTTP-only adapters
(LinkedIn/Indeed via jobspy, Hiring Cafe via Next.js JSON, Adzuna via REST)
but the only way to reach this source.

Pipeline (canonical, shared with all discovery sources):
  Playwright fetch (per keyword) -> raw rows
    -> apply_unified_filter()
    -> emit TSVs at next_available_nn()
    -> standard liveness gate
    -> eval dispatch
    -> merge-tracker.mjs

Requires Playwright Chromium installed (already a workspace dep for
liveness-parallel.mjs).

Usage:
  python3 scripts/startupjobs-ingest.py
      [--keyword "kw1,kw2,..."]    # comma-separated; default 5 archetypes
      [--max-pages-per-query 1]    # 25-50 rows per page on startup.jobs
      [--max-age-days 21]
      [--no-clean]
      [--dry-run]
"""

import argparse
import datetime as _dt
import json
import os
import subprocess
import sys
import urllib.parse
from pathlib import Path

import discovery_filters as df


# Disabled: FT category URL unverified (was /internships; FT equivalent unknown).
# Re-enable once the correct full-time category path is confirmed.
ENABLED = False

# startup.jobs's keyword search is brittle; the /internships category page
# was the most reliable entry point. FT equivalent needs verification before
# re-enabling.
DEFAULT_QUERIES = (
    "software,"
    "engineer,"
    "ai,"
    "ml,"
    "data"
)

# Inline Playwright runner. Output: JSON to stdout, logs to stderr.
# startup.jobs URL: https://startup.jobs/?q={keyword}&l=United+States.
# Job-detail links sit at the root: /{slug-with-id} like /founding-ml-engineer-remy-7690938.
# Title is inside the card in a <div class="sm:truncate">; company link is a sibling /company/{slug}.
NODE_SCRAPER = r"""
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();
const queries = JSON.parse(process.env.QUERIES);
const maxPages = parseInt(process.env.MAX_PAGES || '2', 10);
const all = [];
const JOB_HREF_RE = /^https:\/\/startup\.jobs\/[a-z0-9-]+-\d+$/;

async function scrapeCurrentPage() {
  return await page.evaluate((re) => {
    const reFn = new RegExp(re);
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!reFn.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const titleEl = a.querySelector('div');
      const title = (titleEl?.innerText || a.innerText || '').trim();
      let company = '';
      let location = '';
      const card = a.closest('li, article, div[class*="border"], div[class*="rounded"]') || a.parentElement?.parentElement;
      if (card) {
        const compLink = card.querySelector('a[href^="/company/"]');
        if (compLink) company = (compLink.innerText || '').trim();
        const txt = card.innerText || '';
        const lines = txt.split('\n').map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          if (line === title || line === company) continue;
          if (/^(Remote|United States|US|USA|[A-Z][a-z]+,? [A-Z]{2}|[A-Z][a-z]+ [A-Z][a-z]+,? [A-Z]{2})/.test(line)) {
            location = line;
            break;
          }
        }
      }
      out.push({ href, title, company, location });
    }
    return out;
  }, JOB_HREF_RE.source);
}

for (const q of queries) {
  // Use the /internships category as base; q narrows the result set.
  // Pagination uses preserved c=internship + page=N.
  const baseQ = q.kw ? `&q=${encodeURIComponent(q.kw)}` : '';
  const url = `https://startup.jobs/internships?l=United+States${baseQ}`;
  process.stderr.write(`  [${q.label}] ${url}\n`);
  let pageCount = 0;
  let rowCount = 0;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(6000);
    for (let pg = 1; pg <= maxPages; pg++) {
      pageCount = pg;
      const rows = await scrapeCurrentPage();
      const newRows = rows.filter(r => !all.some(a => a.href === r.href));
      for (const r of newRows) all.push({ ...r, query: q.kw });
      rowCount += newRows.length;
      if (newRows.length === 0 && pg > 1) break;
      if (pg < maxPages) {
        // Click "Show more results" / "Load next page" to load the next page.
        const nextLink = await page.$('a[href*="page="][rel="next"], a:has-text("Show more results"), a:has-text("Load next page")');
        if (!nextLink) break;
        try {
          await nextLink.click({ timeout: 5000 });
          await page.waitForTimeout(4000);
        } catch (e) { break; }
      }
    }
    process.stderr.write(`  [${q.label}] ${rowCount} cards across ${pageCount} page(s)\n`);
  } catch (e) {
    process.stderr.write(`  [${q.label}] error: ${e.message.split('\n')[0]}\n`);
  }
}
process.stdout.write(JSON.stringify(all));
await browser.close();
"""


def _parse_card(card):
    """Map the Node-side card dict to the discovery_filters row schema."""
    return {
        "title": (card.get("title") or "").strip(),
        "company": (card.get("company") or "").strip(),
        "url": card.get("href") or "",
        "location": (card.get("location") or "").strip(),
        "is_remote": "remote" in (card.get("location") or "").lower(),
        "age_days": None,  # startup.jobs cards don't expose age in list view
        "site": "startup.jobs",
    }


def main(argv=None):
    if not ENABLED:
        print(
            "startupjobs-ingest deferred: FT category URL unverified",
            file=sys.stderr,
        )
        return 0

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--keyword", default=DEFAULT_QUERIES, help="comma-separated narrowing queries; '' = base /internships listing")
    p.add_argument("--max-pages-per-query", type=int, default=2)
    p.add_argument("--max-age-days", type=int, default=df.MAX_AGE_DAYS_DEFAULT)
    p.add_argument("--no-clean", action="store_true")
    p.add_argument("--no-tracker-dedup", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    keywords = [k.strip() for k in args.keyword.split(",")]  # keep "" entries to allow base listing
    today_iso = _dt.date.today().isoformat()

    print(f"# startupjobs-ingest run {today_iso}", file=sys.stderr)
    print(f"  keywords ({len(keywords)}): {keywords}", file=sys.stderr)

    if not args.dry_run and df.BATCH_DIR.exists() and not args.no_clean:
        cleared = sum(1 for f in df.BATCH_DIR.glob("*-startupjobs.tsv"))
        for f in df.BATCH_DIR.glob("*-startupjobs.tsv"):
            f.unlink()
        if cleared:
            print(f"  cleared {cleared} stale startupjobs TSVs (use --no-clean to keep them)", file=sys.stderr)
    elif args.no_clean:
        print("  --no-clean: preserving existing startupjobs TSVs", file=sys.stderr)

    if args.no_tracker_dedup:
        existing_urls, existing_fps = set(), set()
        print("  skipping tracker dedup (--no-tracker-dedup)", file=sys.stderr)
    else:
        existing_urls, existing_fps = df.collect_existing_signatures()
        print(f"  tracker baseline: {len(existing_urls)} URLs, {len(existing_fps)} fingerprints", file=sys.stderr)

    queries = [{"kw": k, "label": f"{i+1}/{len(keywords)} {k}"} for i, k in enumerate(keywords)]

    # Write the Node script to a temp file (subprocess can't pass it via -e/--eval easily because of imports)
    runner_path = df.CAREER_OPS / "scripts" / "_startupjobs_runner.mjs"
    runner_path.write_text(NODE_SCRAPER)

    env = os.environ.copy()
    env["QUERIES"] = json.dumps(queries)
    env["MAX_PAGES"] = str(args.max_pages_per_query)
    try:
        proc = subprocess.run(
            ["node", str(runner_path)],
            cwd=str(df.CAREER_OPS),
            capture_output=True,
            text=True,
            timeout=300,
            env=env,
        )
    except subprocess.TimeoutExpired:
        print("error: startupjobs Playwright runner timed out after 300s", file=sys.stderr)
        runner_path.unlink(missing_ok=True)
        return 1
    finally:
        # Echo runner stderr to our stderr.
        pass

    if proc.stderr:
        sys.stderr.write(proc.stderr)
    runner_path.unlink(missing_ok=True)

    if proc.returncode != 0:
        print(f"error: runner exited {proc.returncode}", file=sys.stderr)
        return 1

    try:
        cards = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        print(f"error: runner returned non-JSON: {e}", file=sys.stderr)
        return 1

    raw_rows = [_parse_card(c) for c in cards]
    raw_rows = [r for r in raw_rows if r["title"] and r["url"]]
    print(f"  total raw rows: {len(raw_rows)}", file=sys.stderr)

    if not raw_rows:
        print("  no rows after parse", file=sys.stderr)
        return 0

    kept, drops = df.apply_unified_filter(
        raw_rows,
        source_tag="startupjobs",
        max_age_days=args.max_age_days,
        existing_urls=existing_urls,
        existing_fps=existing_fps,
    )
    print(f"  drops: {drops}", file=sys.stderr)
    print(f"  kept after unified filter: {len(kept)}", file=sys.stderr)

    start_nn = df.next_available_nn()
    print(f"  starting NN: {start_nn}", file=sys.stderr)

    written = []
    for offset, row in enumerate(kept):
        num = start_nn + offset
        path, _line = df.emit_tsv(
            num=num,
            date=today_iso,
            company=row["company"],
            role=row["title"],
            url=row["url"],
            source="startupjobs",
            age_days=row.get("age_days"),
            suffix="startupjobs",
            sponsorship=None,
            dry_run=args.dry_run,
        )
        written.append(path)

    if args.dry_run:
        print(f"[dry-run] would write {len(written)} TSV files", file=sys.stderr)
    else:
        print(f"wrote {len(written)} TSV files to {df.BATCH_DIR}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
