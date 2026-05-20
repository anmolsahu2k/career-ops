#!/usr/bin/env python3
"""adzuna-ingest.py - Adzuna API adapter for the career-ops discovery pipeline.

Adzuna (https://developer.adzuna.com/) exposes a free REST API across 16
countries. US tier: 1000 calls/month, 50 results per call, JSON. Each posting
has title, company, location, redirect_url, salary, and a publish date - all
mappable to the canonical filter schema.

API key required: register at https://developer.adzuna.com/ for a free
app_id + app_key, then set:
  export ADZUNA_APP_ID=...
  export ADZUNA_APP_KEY=...

Pipeline (canonical, shared with all discovery sources):
  GET /v1/api/jobs/us/search/{page}  (per keyword + page)
    -> apply_unified_filter()
    -> emit TSVs at next_available_nn()
    -> standard liveness gate
    -> eval dispatch
    -> merge-tracker.mjs

Usage:
  python3 scripts/adzuna-ingest.py
      [--keyword "kw1,kw2,..."]
      [--country us]
      [--max-pages 2]              # 50 results per page; default 2 = 100 per kw
      [--max-age-days 21]
      [--no-clean]
      [--dry-run]
"""

import argparse
import datetime as _dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import discovery_filters as df


API_TEMPLATE = (
    "https://api.adzuna.com/v1/api/jobs/{country}/search/{page}?"
    "app_id={app_id}&app_key={app_key}&results_per_page=50&what={what}&where={where}&content-type=application/json"
)

DEFAULT_KEYWORDS = (
    "software engineer intern,"
    "machine learning intern,"
    "data science intern,"
    "ai engineer intern,"
    "data engineer intern"
)

UA = "Mozilla/5.0"
INTER_QUERY_SLEEP = 0.5  # seconds between API calls
INTER_RESOLVE_SLEEP = 0.4  # seconds between redirect-follow HEAD calls


def resolve_redirect(url, timeout=10):
    """Follow an Adzuna redirect_url to the final employer URL.

    Adzuna's redirect_url is `https://www.adzuna.com/details/{id}` which 302s
    to the employer's careers page. When N parallel eval agents WebFetch the
    same adzuna.com host in a short window, the aggregator returns HTTP 429.
    Resolving the redirect once at ingest time and storing the final employer
    URL bypasses the rate limit entirely.

    Returns (resolved_url, success_bool). On any failure (network, 429, weird
    redirect chain) we return the original URL with success=False so the row
    still goes through; the eval agent's WebFetch will just hit adzuna.com
    as before.
    """
    req = urllib.request.Request(url, headers={"User-Agent": UA}, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            final = resp.url or ""
            if final and final != url and "adzuna.com" not in final:
                return final, True
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        pass
    return url, False


def fetch_page(country, app_id, app_key, what, where, page=1):
    url = API_TEMPLATE.format(
        country=country,
        page=page,
        app_id=app_id,
        app_key=app_key,
        what=urllib.parse.quote(what),
        where=urllib.parse.quote(where),
    )
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return {"error": f"HTTP {e.code}: {body[:200]}"}
    except Exception as e:
        return {"error": str(e)}


def normalize_hit(hit):
    company = (hit.get("company") or {}).get("display_name") or ""
    title = hit.get("title") or ""
    # Adzuna occasionally returns redirect_url with a trailing "." (sentence-style
    # punctuation joined onto the URL upstream). Strip trailing junk so the
    # liveness gate doesn't flag the row as expired on a non-existent path.
    url = (hit.get("redirect_url") or "").strip().rstrip(".,;:")

    loc_obj = hit.get("location") or {}
    loc = loc_obj.get("display_name") or ", ".join(loc_obj.get("area") or [])

    age_days = None
    created = hit.get("created") or ""
    if created:
        try:
            published = _dt.datetime.fromisoformat(created.replace("Z", "+00:00")).date()
            age_days = (_dt.date.today() - published).days
            if age_days < 0:
                age_days = 0
        except (ValueError, TypeError):
            age_days = None

    salary_lo = hit.get("salary_min")
    salary_hi = hit.get("salary_max")
    comp = ""
    if salary_lo or salary_hi:
        comp = f"${int(salary_lo or salary_hi):,}-${int(salary_hi or salary_lo):,}/yr"

    contract_time = hit.get("contract_time") or ""  # "full_time" / "part_time"
    contract_type = hit.get("contract_type") or ""  # "permanent" / "contract"

    # 500-char description blurb from the search API. Stored in extras so the
    # eval agent has a JD snippet to score from even if eval-time WebFetch of
    # the employer site fails. Newlines collapsed; em-dashes preserved here
    # (emit_tsv strips them before writing).
    description = (hit.get("description") or "").strip()
    description = " ".join(description.split())
    if len(description) > 480:
        # Cut at a sentence boundary within the last 80 chars when possible.
        cut = description.rfind(". ", 0, 480)
        description = description[: cut + 1] if cut > 320 else description[:480]

    return {
        "title": title,
        "company": company,
        "url": url,
        "location": loc,
        "is_remote": "remote" in loc.lower(),
        "age_days": age_days,
        "site": "adzuna",
        "_comp": comp,
        "_contract_time": contract_time,
        "_contract_type": contract_type,
        "_description": description,
    }


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--keyword", default=DEFAULT_KEYWORDS, help="comma-separated search terms")
    p.add_argument("--country", default="us", help="Adzuna country code (default us)")
    p.add_argument("--where", default="United States", help="location string")
    p.add_argument("--max-pages", type=int, default=2, help="pages per keyword (50 results/page)")
    p.add_argument("--max-age-days", type=int, default=df.MAX_AGE_DAYS_DEFAULT)
    p.add_argument("--no-clean", action="store_true")
    p.add_argument("--no-tracker-dedup", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    app_id = os.environ.get("ADZUNA_APP_ID")
    app_key = os.environ.get("ADZUNA_APP_KEY")
    if not app_id or not app_key:
        print(
            "error: ADZUNA_APP_ID and ADZUNA_APP_KEY env vars not set.\n"
            "  Register a free app at https://developer.adzuna.com/, then:\n"
            "    export ADZUNA_APP_ID=...\n"
            "    export ADZUNA_APP_KEY=...\n"
            "  Free tier: 1000 calls/month, 50 results/call.",
            file=sys.stderr,
        )
        return 2

    keywords = [k.strip() for k in args.keyword.split(",") if k.strip()]
    today_iso = _dt.date.today().isoformat()

    print(f"# adzuna-ingest run {today_iso}", file=sys.stderr)
    print(f"  country={args.country} where={args.where!r}", file=sys.stderr)
    print(f"  keywords ({len(keywords)}): {keywords}", file=sys.stderr)
    print(f"  max pages per keyword: {args.max_pages} (50 results/page)", file=sys.stderr)
    print(f"  total API calls budget: {len(keywords) * args.max_pages}", file=sys.stderr)

    if not args.dry_run and df.BATCH_DIR.exists() and not args.no_clean:
        cleared = sum(1 for f in df.BATCH_DIR.glob("*-adzuna.tsv"))
        for f in df.BATCH_DIR.glob("*-adzuna.tsv"):
            f.unlink()
        if cleared:
            print(f"  cleared {cleared} stale adzuna TSVs (use --no-clean to keep them)", file=sys.stderr)
    elif args.no_clean:
        print("  --no-clean: preserving existing adzuna TSVs", file=sys.stderr)

    if args.no_tracker_dedup:
        existing_urls, existing_fps = set(), set()
        print("  skipping tracker dedup (--no-tracker-dedup)", file=sys.stderr)
    else:
        existing_urls, existing_fps = df.collect_existing_signatures()
        print(f"  tracker baseline: {len(existing_urls)} URLs, {len(existing_fps)} fingerprints", file=sys.stderr)

    raw_rows = []
    for keyword in keywords:
        for page in range(1, args.max_pages + 1):
            data = fetch_page(args.country, app_id, app_key, keyword, args.where, page=page)
            if "error" in data:
                print(f"  [{keyword!r} page {page}] error: {data['error']}", file=sys.stderr)
                break
            results = data.get("results") or []
            if not results:
                print(f"  [{keyword!r} page {page}] 0 rows (end of paging)", file=sys.stderr)
                break
            print(f"  [{keyword!r} page {page}]: {len(results)} raw rows", file=sys.stderr)
            for r in results:
                raw_rows.append(normalize_hit(r))
            time.sleep(INTER_QUERY_SLEEP)

    if not raw_rows:
        print("  no rows returned", file=sys.stderr)
        return 0
    print(f"  total raw rows: {len(raw_rows)}", file=sys.stderr)

    kept, drops = df.apply_unified_filter(
        raw_rows,
        source_tag="adzuna",
        max_age_days=args.max_age_days,
        existing_urls=existing_urls,
        existing_fps=existing_fps,
    )
    print(f"  drops: {drops}", file=sys.stderr)
    print(f"  kept after unified filter: {len(kept)}", file=sys.stderr)

    # Resolve adzuna.com redirects to employer URLs (kept rows only). Skipping
    # this would mean N parallel eval-agent WebFetches hammer adzuna.com and
    # get rate-limited (HTTP 429). Resolving once at ingest is cheap because
    # `kept` is typically <10 rows after the unified filter.
    if kept and not args.dry_run:
        resolved_n = 0
        for row in kept:
            orig = row.get("url") or ""
            if "adzuna.com" not in orig:
                continue
            new_url, ok = resolve_redirect(orig)
            if ok:
                row["url"] = new_url
                resolved_n += 1
            time.sleep(INTER_RESOLVE_SLEEP)
        print(f"  resolved {resolved_n}/{len(kept)} adzuna redirects to employer URLs", file=sys.stderr)

    start_nn = df.next_available_nn()
    print(f"  starting NN: {start_nn}", file=sys.stderr)

    written = []
    for offset, row in enumerate(kept):
        num = start_nn + offset
        extras = {}
        if row.get("_comp"):
            extras["comp"] = row["_comp"]
        if row.get("_contract_time"):
            extras["contract_time"] = row["_contract_time"]
        if row.get("_description"):
            extras["jd_snippet"] = row["_description"]
        path, _line = df.emit_tsv(
            num=num,
            date=today_iso,
            company=row["company"],
            role=row["title"],
            url=row["url"],
            source="adzuna",
            age_days=row.get("age_days"),
            suffix="adzuna",
            sponsorship=None,  # Adzuna doesn't expose visa-sponsorship signal
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
