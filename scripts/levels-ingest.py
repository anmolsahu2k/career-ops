#!/usr/bin/env python3
"""levels-ingest.py - Levels.fyi adapter for the career-ops discovery pipeline.

Levels.fyi (levels.fyi) curates jobs across companies they track for comp data.
The /jobs/internships path embeds Next.js __NEXT_DATA__ with structured fields
per posting: title, locations, applicationUrl, postingDate, expiryDate,
workArrangement, minBaseSalary, maxBaseSalary, baseSalaryCurrency.

Note: the /jobs/internships listing is a curated featured-companies surface,
NOT the full internship corpus (totalMatchingJobs reports ~25k, but the route
only returns 8 promoted companies x ~5-10 roles per request, ~50-80 raw rows
per fetch). Many returned roles aren't actually internships (FTE leaks
through), so the unified filter chain drops most. Net useful yield: ~5-15
candidates per run with low overlap to GitHub aggregators.

Pagination: the embedded payload is a single page of 8 companies; ?page=N
echoes the same payload (server-side pagination not exposed to the public
route). To get more variety, pass --keyword and --location to bias the
featured set toward different slices.

Usage:
  python3 scripts/levels-ingest.py
      [--keyword K1,K2,...]    # bias featured companies toward role keywords
      [--location loc1|loc2..] # pipe-separated location slugs (e.g. "san-francisco|new-york")
      [--max-age-days 21]
      [--no-clean]
      [--no-tracker-dedup]
      [--dry-run]
"""

import argparse
import datetime as _dt
import gzip
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import discovery_filters as df


# Disabled: new-grad URL unverified — re-enable once the correct FT path is confirmed.
ENABLED = False

HOMEPAGE = "https://www.levels.fyi/jobs/internships"
NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.+?)</script>', re.DOTALL
)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"

# Default sweep: hit a handful of biasing query strings to extract different
# featured slices. Levels.fyi rotates the "featured 8 companies" by query
# context, so 4-6 queries surface a meaningfully different set each time.
DEFAULT_KEYWORDS = "intern,software engineer intern,machine learning intern,data scientist intern,ai engineer intern,data engineer intern"


def _http_get(url, timeout=30):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/json",
            "Accept-Encoding": "gzip",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", errors="replace")


def fetch_initial_jobs_data(keyword=None, location=None):
    """Fetch /jobs/internships and extract initialJobsData.results[]."""
    qs = {}
    if keyword:
        qs["search"] = keyword
    if location:
        qs["location"] = location
    url = HOMEPAGE
    if qs:
        url = url + "?" + urllib.parse.urlencode(qs)
    text = _http_get(url)
    m = NEXT_DATA_RE.search(text)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return None
    pp = data.get("props", {}).get("pageProps", {})
    return pp.get("initialJobsData", {})


def normalize_job(company_dict, job):
    """Map a Levels.fyi job dict + parent company to discovery_filters row schema."""
    locations = job.get("locations") or []
    location_str = ", ".join(locations) if locations else ""
    workarr = (job.get("workArrangement") or "").lower()
    is_remote = "remote" in workarr or "remote" in location_str.lower()

    # Age from postingDate
    age_days = None
    pd = job.get("postingDate")
    if pd:
        try:
            posted = _dt.datetime.fromisoformat(pd.replace("Z", "+00:00")).date()
            age_days = (_dt.date.today() - posted).days
            if age_days < 0:
                age_days = 0
        except (ValueError, TypeError):
            age_days = None

    # Comp band string for Notes extras
    comp = ""
    minb = job.get("minBaseSalary")
    maxb = job.get("maxBaseSalary")
    cur = job.get("baseSalaryCurrency") or "USD"
    if minb and maxb:
        if minb == maxb:
            comp = f"{cur} {minb:,}/yr"
        else:
            comp = f"{cur} {minb:,}-{maxb:,}/yr"
    elif minb or maxb:
        comp = f"{cur} {minb or maxb:,}/yr"

    return {
        "title": (job.get("title") or "").strip(),
        "company": (company_dict.get("companyName") or "").strip(),
        "url": (job.get("applicationUrl") or "").strip(),
        "location": location_str,
        "is_remote": is_remote,
        "age_days": age_days,
        "_comp": comp,
        "_workplace_type": workarr or None,
        "_expiry_date": job.get("expiryDate"),
        "_company_slug": company_dict.get("companySlug"),
        "_employee_count": company_dict.get("employeeCount"),
    }


def main(argv=None):
    if not ENABLED:
        print(
            "levels-ingest deferred: new-grad URL unverified",
            file=sys.stderr,
        )
        return 0

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument(
        "--keyword",
        default=DEFAULT_KEYWORDS,
        help="comma-separated biasing queries; '' = base /jobs/internships listing",
    )
    p.add_argument(
        "--location",
        default="",
        help="pipe-separated location slugs to bias by; empty = no location bias",
    )
    p.add_argument("--max-age-days", type=int, default=df.MAX_AGE_DAYS_DEFAULT)
    p.add_argument("--no-clean", action="store_true")
    p.add_argument("--no-tracker-dedup", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    keywords = [k.strip() for k in args.keyword.split(",") if k.strip()] or [""]
    locations = [l.strip() for l in args.location.split("|")] if args.location else [""]
    today_iso = _dt.date.today().isoformat()

    print(f"# levels-ingest run {today_iso}", file=sys.stderr)
    print(f"  keywords ({len(keywords)}): {keywords}", file=sys.stderr)
    print(f"  locations ({len(locations)}): {locations}", file=sys.stderr)

    if not args.dry_run and df.BATCH_DIR.exists() and not args.no_clean:
        cleared = sum(1 for f in df.BATCH_DIR.glob("*-levels.tsv"))
        for f in df.BATCH_DIR.glob("*-levels.tsv"):
            f.unlink()
        if cleared:
            print(
                f"  cleared {cleared} stale levels TSVs (use --no-clean to keep them)",
                file=sys.stderr,
            )
    elif args.no_clean:
        print("  --no-clean: preserving existing levels TSVs", file=sys.stderr)

    if args.no_tracker_dedup:
        existing_urls, existing_fps = set(), set()
        print("  skipping tracker dedup (--no-tracker-dedup)", file=sys.stderr)
    else:
        existing_urls, existing_fps = df.collect_existing_signatures()
        print(
            f"  tracker baseline: {len(existing_urls)} URLs, {len(existing_fps)} fingerprints",
            file=sys.stderr,
        )

    raw_rows = []
    seen_urls_in_run = set()
    sweep_count = 0
    total_sweeps = len(keywords) * len(locations)

    for keyword in keywords:
        for location in locations:
            sweep_count += 1
            label = f"[{sweep_count}/{total_sweeps}] kw={keyword!r} loc={location!r}"
            try:
                ijd = fetch_initial_jobs_data(keyword or None, location or None)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
                print(f"  {label}: error {exc}", file=sys.stderr)
                continue
            if ijd is None:
                print(f"  {label}: no NEXT_DATA returned", file=sys.stderr)
                continue
            results = ijd.get("results") or []
            sweep_jobs = 0
            for company in results:
                jobs = company.get("jobs") or []
                for job in jobs:
                    row = normalize_job(company, job)
                    if not row["url"]:
                        continue
                    # within-sweep URL dedup so the same featured-company spam
                    # across keyword variants doesn't blow up the count.
                    if row["url"] in seen_urls_in_run:
                        continue
                    seen_urls_in_run.add(row["url"])
                    raw_rows.append(row)
                    sweep_jobs += 1
            print(
                f"  {label}: {len(results)} companies, {sweep_jobs} new jobs",
                file=sys.stderr,
            )
            if sweep_count < total_sweeps:
                time.sleep(0.5)  # be polite to Cloudfront

    print(f"  total raw rows: {len(raw_rows)}", file=sys.stderr)
    if not raw_rows:
        print("  no rows returned", file=sys.stderr)
        return 0

    kept, drops = df.apply_unified_filter(
        raw_rows,
        source_tag="levels",
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
        if row.get("_comp"):
            extras["comp"] = row["_comp"]
        if row.get("_workplace_type"):
            extras["workplace"] = row["_workplace_type"]
        path, _line = df.emit_tsv(
            num=num,
            date=today_iso,
            company=row["company"],
            role=row["title"],
            url=row["url"],
            source="levels",
            age_days=row.get("age_days"),
            suffix="levels",
            sponsorship=None,  # Levels.fyi does not expose visa sponsorship
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
