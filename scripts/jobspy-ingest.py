#!/usr/bin/env python3
# requirements: python-jobspy (pip install python-jobspy)
"""jobspy-ingest.py - JobSpy adapter for the career-ops discovery pipeline.

Wraps python-jobspy (https://github.com/speedyapply/JobSpy) to scrape
LinkedIn / Indeed / ZipRecruiter / Google Jobs for internship listings, then
routes raw rows through the canonical filter chain in `discovery_filters.py`
(same chain as `aggregator-intake.py`), then emits placeholder TSVs into
`batch/tracker-additions/` for the standard liveness -> eval -> merge flow.

Pipeline (canonical, shared with all discovery sources):
  scrape_jobs(per keyword x location) -> raw rows
    -> apply_unified_filter():
         title allow + deny  | season filter  | geo filter
       | within-run URL dedup | tracker URL dedup | fingerprint dedup
    -> emit TSVs at next_available_nn()..
    -> standard liveness gate (npm run liveness:batch)
    -> eval dispatch
    -> merge-tracker.mjs

Multi-keyword sweep: --keyword accepts comma-separated terms.
Multi-location sweep: --location accepts comma-separated locations (one query
per keyword x location pair). Indeed especially benefits from per-metro
queries; LinkedIn/ZipRecruiter accept country-string locations.

Weekend-aware recency: default `--hours_old` is 168h on Mon-Thu and 240h on
Fri-Sun (10 days) so weekend runs catch Friday-evening / Saturday postings
that would otherwise fall outside a tight window.

LinkedIn JD inlining: `linkedin_fetch_description=True` is set so the JD
body is returned with each row, avoiding a downstream WebFetch round-trip
during eval. Slower scrape but ~70% fewer eval-agent fetch failures.

Glassdoor disabled: returns HTTP 400 "location not parsed" on country-string
locations and python-jobspy doesn't expose city-level location IDs.

Stop conditions: captcha or HTTP 429 from any site -> log to stderr,
continue to next keyword/location combo (don't exit), summarize at end.

Usage:
  python3 scripts/jobspy-ingest.py
      [--keyword "kw1,kw2,..."]
      [--site linkedin,indeed,zip_recruiter,google]
      [--location "United States,San Francisco CA,..."]
      [--hours_old 168]      # auto-extends to 240 on Fri-Sun
      [--limit 25]
      [--no-clean]            # preserve existing jobspy TSVs (for incremental runs)
      [--dry-run]
"""

import argparse
import datetime as _dt
import sys
import time

import discovery_filters as df


DEFAULT_KEYWORDS = (
    "software engineer intern,"
    "machine learning intern,"
    "data science intern,"
    "ai engineer intern,"
    "data engineer intern,"
    "backend engineer intern"
)

# Multi-location sweep. "United States" is the broad query (best for LinkedIn,
# Google). Per-metro entries help Indeed which yields more results when given
# city-level locations. Separator is `|` not `,` because city,state strings
# ("San Francisco, CA") contain commas. Keep this list short to avoid rate
# limits (4 locations x 6 keywords x 3 sites ~= 24 jobspy calls).
DEFAULT_LOCATIONS = "United States|San Francisco, CA|New York, NY|Remote"

# Sites: LinkedIn (high-yield, captcha-prone), Indeed (better with per-metro),
# Google (Google Jobs aggregator, pulls from many indexed sources).
# Disabled:
# - Glassdoor: 400s on country-string locations, lib doesn't expose city IDs
# - ZipRecruiter: returns 403 Cloudflare ("forbidden aa") from any IP-without-
#   subscription as of 2026-05-04, attempted-and-removed
DEFAULT_SITES = "linkedin,indeed,google"

WEEKEND_DAYS = {4, 5, 6}  # Friday=4, Saturday=5, Sunday=6 per datetime.weekday()
WEEKDAY_HOURS = 168       # 7 days
WEEKEND_HOURS = 240       # 10 days, catches Fri-evening / Sat / Sun postings

INTER_SWEEP_SLEEP = 5     # seconds between (keyword, location) sweeps - reduces LinkedIn captcha risk


def weekend_aware_hours(today, base_hours):
    """If running on Fri/Sat/Sun and base is the default 168h, slide to 240h.
    If user passed a non-default --hours_old, respect it as-is."""
    if base_hours == WEEKDAY_HOURS and today.weekday() in WEEKEND_DAYS:
        return WEEKEND_HOURS
    return base_hours


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument(
        "--keyword",
        default=DEFAULT_KEYWORDS,
        help="comma-separated list of search terms; one scrape per term",
    )
    p.add_argument(
        "--site",
        default=DEFAULT_SITES,
        help="comma-separated jobspy sites (default: linkedin,indeed,zip_recruiter,google; glassdoor disabled, broken on country-string locations)",
    )
    p.add_argument(
        "--location",
        default=DEFAULT_LOCATIONS,
        help="pipe-separated locations (use `|` not `,` because city,state strings contain commas); one query per (keyword, location) pair",
    )
    p.add_argument(
        "--hours_old",
        type=int,
        default=WEEKDAY_HOURS,
        help=f"recency window in hours (default {WEEKDAY_HOURS}h Mon-Thu, "
             f"auto-extends to {WEEKEND_HOURS}h on Fri-Sun)",
    )
    p.add_argument("--limit", type=int, default=25, help="results per site per (keyword, location)")
    p.add_argument(
        "--max-age-days",
        type=int,
        default=df.MAX_AGE_DAYS_DEFAULT,
        help="drop rows older than this (default %(default)s)",
    )
    p.add_argument(
        "--no-clean",
        action="store_true",
        help="preserve existing jobspy TSVs in batch dir (for incremental / additive runs)",
    )
    p.add_argument(
        "--inline-jd",
        action="store_true",
        help="fetch LinkedIn JD body during scrape (linkedin_fetch_description=True). "
             "Slower (~5x per LinkedIn sweep) but doubles as a free liveness gate "
             "and avoids the eval-agent WebFetch round-trip. Off by default until "
             "downstream consumes the JD body from the TSV.",
    )
    p.add_argument("--no-tracker-dedup", action="store_true", help="debugging only")
    p.add_argument(
        "--time-budget",
        type=int,
        default=480,
        help="max wall-seconds to spend on the sweep matrix (default 480s = 8min). "
             "LinkedIn calls are slow and the orchestrator was previously SIGKILLing "
             "the script mid-sweep; this lets the script exit cleanly with partial "
             "results, run the unified filter on what it has, and emit TSVs.",
    )
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    sites = [s.strip() for s in args.site.split(",") if s.strip()]
    keywords = [k.strip() for k in args.keyword.split(",") if k.strip()]
    locations = [l.strip() for l in args.location.split("|") if l.strip()]
    today = _dt.date.today()
    today_iso = today.isoformat()

    # Weekend-aware hours_old.
    effective_hours = weekend_aware_hours(today, args.hours_old)
    weekend_note = ""
    if effective_hours != args.hours_old:
        weekend_note = f" (weekend slide: {args.hours_old}h -> {effective_hours}h, today is {today.strftime('%A')})"

    try:
        from jobspy import scrape_jobs  # type: ignore
    except ImportError:
        print(
            "error: python-jobspy not installed. Run: pip install python-jobspy",
            file=sys.stderr,
        )
        return 2

    print(f"# jobspy-ingest run {today_iso}", file=sys.stderr)
    print(f"  sites={sites}", file=sys.stderr)
    print(f"  keywords ({len(keywords)}): {keywords}", file=sys.stderr)
    print(f"  locations ({len(locations)}): {locations}", file=sys.stderr)
    print(f"  hours_old={effective_hours}{weekend_note}, limit={args.limit}/site/(keyword,location)", file=sys.stderr)
    print(f"  total scrape calls: {len(keywords) * len(locations)} ({len(keywords)} keywords x {len(locations)} locations)", file=sys.stderr)

    # Clean stale jobspy TSVs from batch dir (unless --no-clean).
    if not args.dry_run and df.BATCH_DIR.exists() and not args.no_clean:
        cleared = 0
        for f in df.BATCH_DIR.glob("*-jobspy.tsv"):
            f.unlink()
            cleared += 1
        if cleared:
            print(f"  cleared {cleared} stale jobspy TSVs (use --no-clean to keep them)", file=sys.stderr)
    elif args.no_clean:
        print("  --no-clean: preserving existing jobspy TSVs", file=sys.stderr)

    # Tracker dedup signatures.
    if args.no_tracker_dedup:
        existing_urls, existing_fps = set(), set()
        print("  skipping tracker dedup (--no-tracker-dedup)", file=sys.stderr)
    else:
        existing_urls, existing_fps = df.collect_existing_signatures()
        print(f"  tracker baseline: {len(existing_urls)} URLs, {len(existing_fps)} fingerprints", file=sys.stderr)

    # Multi-keyword x multi-location sweep.
    raw_rows = []
    captcha_hits = []
    skipped_combos = 0
    sweep_count = 0
    total_sweeps = len(keywords) * len(locations)
    sweep_started = time.monotonic()
    budget_exit = False
    for keyword in keywords:
        if budget_exit:
            break
        for location in locations:
            if time.monotonic() - sweep_started > args.time_budget:
                remaining = total_sweeps - sweep_count
                print(
                    f"  time-budget {args.time_budget}s exceeded; exiting sweep "
                    f"early with {sweep_count}/{total_sweeps} done ({remaining} skipped). "
                    f"Partial results will still be filtered + emitted.",
                    file=sys.stderr,
                )
                budget_exit = True
                break
            sweep_count += 1
            label = f"[{sweep_count}/{total_sweeps}] {keyword!r} @ {location!r}"
            try:
                jobs = scrape_jobs(
                    site_name=sites,
                    search_term=keyword,
                    location=location,
                    results_wanted=args.limit,
                    hours_old=effective_hours,
                    country_indeed="USA",
                    linkedin_fetch_description=args.inline_jd,
                )
            except Exception as exc:
                msg = str(exc).lower()
                if "captcha" in msg or "429" in msg or "rate" in msg or "blocked" in msg:
                    offending = "unknown"
                    for s in sites:
                        if s in msg:
                            offending = s
                            break
                    captcha_hits.append((keyword, location, offending))
                    skipped_combos += 1
                    print(f"  {label}: captcha/rate-limit on {offending}, skipping", file=sys.stderr)
                else:
                    skipped_combos += 1
                    print(f"  {label}: error {exc}", file=sys.stderr)
                # Don't exit - continue with the next combo so partial yield survives.
                # Sleep extra after a captcha to give the offending site time to cool off.
                time.sleep(INTER_SWEEP_SLEEP * 2)
                continue

            if jobs is None or len(jobs) == 0:
                print(f"  {label}: 0 rows", file=sys.stderr)
            else:
                rows = jobs.to_dict(orient="records") if hasattr(jobs, "to_dict") else list(jobs)
                print(f"  {label}: {len(rows)} raw rows", file=sys.stderr)

                for r in rows:
                    raw_rows.append({
                        "title": r.get("title") or r.get("job_title") or "",
                        "company": r.get("company") or r.get("employer") or "",
                        "url": r.get("job_url") or r.get("url") or "",
                        "location": r.get("location") or "",
                        "is_remote": bool(r.get("is_remote") or False),
                        "age_days": None,  # jobspy filters by hours_old at query time
                        "site": r.get("site") or "jobspy",
                        "description": r.get("description") or "",  # JD body if linkedin_fetch_description worked
                    })

            # Pace between sweeps to reduce captcha risk on later calls.
            if sweep_count < total_sweeps:
                time.sleep(INTER_SWEEP_SLEEP)

    if captcha_hits:
        print(f"\n  captcha summary: {len(captcha_hits)} sweep(s) blocked", file=sys.stderr)
        for k, l, s in captcha_hits[:5]:
            print(f"    - {s}: keyword={k!r} location={l!r}", file=sys.stderr)
        if len(captcha_hits) > 5:
            print(f"    ... and {len(captcha_hits) - 5} more", file=sys.stderr)

    if not raw_rows:
        print("  no rows returned across all sweeps", file=sys.stderr)
        return 0

    attempted = sweep_count
    successful = attempted - skipped_combos
    print(
        f"  total raw rows: {len(raw_rows)} from {successful}/{total_sweeps} successful sweeps "
        f"({attempted} attempted; {total_sweeps - attempted} skipped by time-budget)",
        file=sys.stderr,
    )

    # Canonical filter chain (shared with aggregator-intake.py).
    kept, drops = df.apply_unified_filter(
        raw_rows,
        source_tag="jobspy",
        max_age_days=args.max_age_days,
        existing_urls=existing_urls,
        existing_fps=existing_fps,
    )
    print(f"  drops: {drops}", file=sys.stderr)
    print(f"  kept after unified filter: {len(kept)}", file=sys.stderr)

    # Allocate sequential NNs from next_available_nn().
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
            source=row.get("site", "jobspy"),
            age_days=None,
            suffix="jobspy",
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
