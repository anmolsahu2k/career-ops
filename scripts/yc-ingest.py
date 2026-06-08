#!/usr/bin/env python3
"""yc-ingest.py - YC Work at a Startup adapter for the career-ops pipeline.

YC's `workatastartup.com/jobs` page is gated behind:
  1. Cloudflare bot challenge on plain HTTP (returns 406 to curl/urllib).
  2. JS-rendered React SPA that loads jobs via authenticated XHR.

We use Playwright via subprocess (same pattern as startupjobs-ingest.py) to
render the public jobs page, then scrape the rendered job cards. YC W25/W26
batches plus older active YC companies are surfaced.

Pagination: YC loads results in chunks via infinite scroll; we trigger
window.scrollTo + waitForTimeout per page until no new cards appear or
--max-pages is reached.

Yield: ~50-200 raw rows per run; high overlap with workatastartup-also-on-
GitHub-aggregator postings, but ~10-30 unique YC-only intern reqs typical.

Requires Playwright Chromium installed (workspace already uses it for
liveness-parallel.mjs).

Usage:
  python3 scripts/yc-ingest.py
      [--keyword K1,K2,..]    # default: intern-targeted role queries
      [--max-pages 3]
      [--max-age-days 21]
      [--no-clean]
      [--no-tracker-dedup]
      [--dry-run]
"""

import argparse
import datetime as _dt
import json
import os
import subprocess
import sys

import discovery_filters as df


# Disabled: FT surface (/jobs?q=) unverified — re-enable once URL is confirmed.
ENABLED = False

DEFAULT_KEYWORDS = (
    "software engineer new grad,"
    "machine learning engineer new grad,"
    "data scientist new grad,"
    "data engineer new grad,"
    "ai engineer new grad,"
    "forward deployed engineer,"
    "solutions engineer new grad,"
    "new grad software engineer,"
    "entry level software engineer,"
    "university graduate software engineer"
)


# Inline Playwright runner. YC loads job listings client-side; we navigate
# to /jobs?role=intern (and other narrowing variants), wait for cards to
# render, then extract anchor links pointing at /jobs/{id}-{slug}.
NODE_SCRAPER = r"""
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 1200 },
});
const page = await ctx.newPage();

const queries = JSON.parse(process.env.QUERIES);
const maxPages = parseInt(process.env.MAX_PAGES || '3', 10);
const all = [];
// /internships card anchors point at ycombinator.com/companies/{slug}/jobs/
// {hash-role-slug}; the workatastartup.com/jobs/{id} pattern is for the
// authenticated /jobs route (which we don't use anymore).
const JOB_HREF_RE = /^https:\/\/www\.ycombinator\.com\/companies\/[a-z0-9-]+\/jobs\/[A-Za-z0-9_-]+/;

async function scrapeCurrentPage() {
  return await page.evaluate((reSrc) => {
    const reFn = new RegExp(reSrc);
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!reFn.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const card = a.closest('div.directory-row, li, article, div[class*="rounded"], div[class*="border"]') || a.parentElement;
      let title = (a.innerText || '').trim();
      let company = '';
      let location = '';
      let workType = '';
      let comp = '';
      let postedHint = '';
      if (card) {
        // Company link <a href="/companies/{slug}"> is usually the first inner link.
        const compLink = card.querySelector('a[href*="/companies/"]');
        if (compLink) company = (compLink.innerText || '').trim();
        // YC's /internships card body has the format:
        //   {Company} (BatchTag) • {tagline} ({age}) {Title} Internship • Engineering • {sub} • ${comp band} / monthly • {Location}
        const txt = (card.innerText || '').replace(/\s+/g, ' ').trim();
        // Posted-age hint: "(5 months ago)", "(2 months ago)", etc.
        const ageM = txt.match(/\((\d+\s+(?:day|days|week|weeks|month|months|year|years)\s+ago)\)/i);
        if (ageM) postedHint = ageM[1];
        // Comp band: "$5K - $10K / monthly" or "$110K - $130K"
        const compM = txt.match(/\$\d[\dKk.,]*\s*[-]\s*\$\d[\dKk.,]*\s*\/?\s*\w*/);
        if (compM) comp = compM[0];
        // Work type: explicit "Internship" / "Full-time" / "Part-time" mid-text
        const typeM = txt.match(/\b(Internship|Full[- ]?time|Part[- ]?time|Co-?op|Contract)\b/i);
        if (typeM) workType = typeM[0];
        // Location: best-effort. YC postings end with the location after the
        // last "•" delimiter. Locations look like "San Francisco, CA, US"
        // or "Remote (US)" or "Berlin, Germany".
        const parts = txt.split('•').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          // Last segment that matches a location-ish pattern.
          for (let i = parts.length - 1; i >= 0; i--) {
            const seg = parts[i];
            if (/\b(remote|onsite|hybrid|US|USA|United States|[A-Z][a-z]+,? [A-Z]{2}|[A-Z][a-z]+ [A-Z][a-z]+,? [A-Z]{2}|Germany|Canada|UK|France|Japan|India|Singapore)\b/.test(seg)
                && !/Internship|Full[- ]?time|Engineering|Backend|Frontend|Full stack|Design|Operations|Marketing|Sales/i.test(seg)) {
              location = seg.replace(/^.*?\$[^/]+\s*\/\s*\w+\s*/, '').trim();
              break;
            }
          }
        }
      }
      out.push({ href, title, company, location, workType, comp, postedHint });
    }
    return out;
  }, JOB_HREF_RE.source);
}

async function scrollUntilStable(maxScrolls) {
  let prevCount = 0;
  let stable = 0;
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2500);
    const cards = await page.$$eval('a[href*="/jobs/"]', els => els.length);
    if (cards <= prevCount) {
      stable++;
      if (stable >= 2) break;
    } else {
      stable = 0;
    }
    prevCount = cards;
  }
}

for (const q of queries) {
  // The /jobs path is the FT listing on workatastartup.com. Free-text
  // narrowing via ?q= is supported but unverified against a live run;
  // this source is currently ENABLED=False until the URL is confirmed.
  const kwParam = q.kw ? `?q=${encodeURIComponent(q.kw)}` : '';
  const url = `https://www.workatastartup.com/jobs${kwParam}`;
  process.stderr.write(`  [${q.label}] ${url}\n`);
  let rowCount = 0;
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    if (!res || !res.ok()) {
      process.stderr.write(`  [${q.label}] http ${res ? res.status() : '?'}\n`);
      continue;
    }
    await page.waitForTimeout(5000);
    // Some pages need a manual scroll to trigger the listings render.
    await scrollUntilStable(maxPages * 4);
    const rows = await scrapeCurrentPage();
    const newRows = rows.filter(r => !all.some(a => a.href === r.href));
    for (const r of newRows) all.push({ ...r, query: q.kw });
    rowCount = newRows.length;
    process.stderr.write(`  [${q.label}] ${rowCount} new cards (total accumulated: ${all.length})\n`);
  } catch (e) {
    process.stderr.write(`  [${q.label}] error: ${(e.message || '').split('\n')[0]}\n`);
  }
}

process.stdout.write(JSON.stringify(all));
await browser.close();
"""


_YC_COMPANY_FROM_URL_RE = __import__("re").compile(
    r"//www\.ycombinator\.com/companies/([a-z0-9][a-z0-9-]*)/jobs/"
)


def _parse_card(card):
    """Map YC card dict to discovery_filters row schema."""
    role = (card.get("title") or "").strip()
    work = (card.get("workType") or "").lower()
    location = (card.get("location") or "").strip()
    comp = (card.get("comp") or "").strip()
    posted = (card.get("postedHint") or "").lower()
    company = (card.get("company") or "").strip()
    href = card.get("href") or ""
    # Strip trailing "Apply" leftovers from the location string.
    if location.endswith("Apply"):
        location = location[: -len("Apply")].strip()
    # Card-text extraction often misses the company link on /internships
    # (the company link sits in a sibling card, not inside the job-link
    # ancestor). Fall back to deriving company from the URL slug:
    #   /companies/{slug}/jobs/...
    # We humanize "browser-use" -> "browser use", "14-ai" -> "14 ai", etc.
    if not company and href:
        m = _YC_COMPANY_FROM_URL_RE.search(href)
        if m:
            slug = m.group(1)
            # Strip trailing -N batch disambiguators (mosaic-2 -> mosaic).
            slug = __import__("re").sub(r"-\d+$", "", slug)
            company = slug.replace("-", " ").title()
    # If card title doesn't mention intern but workType does, append for the
    # title-level intern-token regex used by role_matches_targets.
    if "intern" not in role.lower() and "intern" in work:
        role = (role + " (intern)").strip()

    age_days = None
    # Parse postedHint like "5 months ago", "2 days ago"
    import re as _re
    m = _re.match(r"\s*(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago", posted)
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        if "day" in unit:
            age_days = n
        elif "week" in unit:
            age_days = n * 7
        elif "month" in unit:
            age_days = n * 30
        elif "year" in unit:
            age_days = n * 365

    return {
        "title": role,
        "company": company,
        "url": href,
        "location": location,
        "is_remote": "remote" in location.lower() or "remote" in work,
        "age_days": age_days,
        "site": "workatastartup",
        "_workplace_type": work or None,
        "_comp": comp,
    }


def main(argv=None):
    if not ENABLED:
        print(
            "yc-ingest deferred: FT surface (/jobs?q=) unverified",
            file=sys.stderr,
        )
        return 0

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument(
        "--keyword",
        default=DEFAULT_KEYWORDS,
        help="comma-separated narrowing queries; '' = base FT listing",
    )
    p.add_argument("--max-pages", type=int, default=3)
    p.add_argument("--max-age-days", type=int, default=df.MAX_AGE_DAYS_DEFAULT)
    p.add_argument("--no-clean", action="store_true")
    p.add_argument("--no-tracker-dedup", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    keywords = [k.strip() for k in args.keyword.split(",")]
    today_iso = _dt.date.today().isoformat()

    print(f"# yc-ingest run {today_iso}", file=sys.stderr)
    print(f"  keywords ({len(keywords)}): {keywords}", file=sys.stderr)

    if not args.dry_run and df.BATCH_DIR.exists() and not args.no_clean:
        cleared = sum(1 for f in df.BATCH_DIR.glob("*-yc.tsv"))
        for f in df.BATCH_DIR.glob("*-yc.tsv"):
            f.unlink()
        if cleared:
            print(
                f"  cleared {cleared} stale yc TSVs (use --no-clean to keep them)",
                file=sys.stderr,
            )

    if args.no_tracker_dedup:
        existing_urls, existing_fps = set(), set()
        print("  skipping tracker dedup (--no-tracker-dedup)", file=sys.stderr)
    else:
        existing_urls, existing_fps = df.collect_existing_signatures()
        print(
            f"  tracker baseline: {len(existing_urls)} URLs, {len(existing_fps)} fingerprints",
            file=sys.stderr,
        )

    queries = [{"kw": k, "label": f"{i+1}/{len(keywords)} {k or '(base)'}"} for i, k in enumerate(keywords)]

    runner_path = df.CAREER_OPS / "scripts" / "_yc_runner.mjs"
    runner_path.write_text(NODE_SCRAPER)

    env = os.environ.copy()
    env["QUERIES"] = json.dumps(queries)
    env["MAX_PAGES"] = str(args.max_pages)
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
        print("error: yc Playwright runner timed out after 300s", file=sys.stderr)
        runner_path.unlink(missing_ok=True)
        return 1

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
    raw_rows = [r for r in raw_rows if r["title"] and r["company"] and r["url"]]
    print(f"  total raw rows: {len(raw_rows)}", file=sys.stderr)
    if not raw_rows:
        print("  no rows after parse", file=sys.stderr)
        return 0

    kept, drops = df.apply_unified_filter(
        raw_rows,
        source_tag="yc",
        max_age_days=args.max_age_days,
        existing_urls=existing_urls,
        existing_fps=existing_fps,
    )
    print(f"  drops: {drops}", file=sys.stderr)
    print(f"  kept after unified filter: {len(kept)}", file=sys.stderr)

    if not kept:
        return 0

    start_nn = df.next_available_nn()
    print(f"  starting NN: {start_nn}", file=sys.stderr)

    written = []
    for offset, row in enumerate(kept):
        num = start_nn + offset
        extras = {}
        if row.get("_workplace_type"):
            extras["workplace"] = row["_workplace_type"]
        if row.get("_comp"):
            extras["comp"] = row["_comp"]
        path, _line = df.emit_tsv(
            num=num,
            date=today_iso,
            company=row["company"],
            role=row["title"],
            url=row["url"],
            source="yc",
            age_days=row.get("age_days"),
            suffix="yc",
            sponsorship=None,
            extras=extras,
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
