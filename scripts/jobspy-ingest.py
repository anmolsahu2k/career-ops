#!/usr/bin/env python3
# requirements: python-jobspy (pip install python-jobspy)
"""
jobspy-ingest.py -- A1 JobSpy adapter (W11 G1).

Wraps the python-jobspy library (https://github.com/speedyapply/JobSpy)
to scrape LinkedIn / Indeed / Glassdoor / Google / ZipRecruiter for
internship listings and emit them into the career-ops pipeline.

Output: one TSV row per kept listing to
  career-ops/batch/tracker-additions/{NNN}-{slug}-jobspy.tsv

NNN starts at 200 (jobspy bucket; aggregator uses 100s, handshake 300s).

Filters:
  - Title must contain "intern" (case-insensitive).
  - Title must match the target-role allow-list.
  - is_remote OR location contains a US hint (state code, US city, "remote-us").

Stop conditions: captcha or HTTP 429 from any site -> log to stderr,
exit 1, message "JobSpy hit rate limit / captcha on {site}; stopped".

Hard rules respected:
  - No em-dashes or en-dashes in any emitted text.
  - No CV PDFs, no F-1/CPT explainer text.
  - Status uses canonical "Evaluated".
  - Score is "0.0/5" (placeholder).
  - PDF emoji is the cross mark.
  - Report link points at reports/pending.md.

Usage:
  python3 career-ops/scripts/jobspy-ingest.py \\
      --keyword "software engineer intern" \\
      --site linkedin,indeed,glassdoor \\
      --hours_old 168 --limit 25 [--dry-run]

Note: this script was NOT executed during W11 G1 because LinkedIn
rate-limits aggressively. Run it off-hours and in small batches.
"""

import argparse
import datetime as _dt
import re
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve()
CAREER_OPS = SCRIPT_PATH.parent.parent
BATCH_DIR = CAREER_OPS / "batch" / "tracker-additions"

# Rule 1: never emit en-dash (U+2013) or em-dash (U+2014) into candidate-facing text.
# Built from chr() so the source file has no literal en/em-dash characters.
EM_DASH_RE = re.compile("[" + chr(0x2013) + chr(0x2014) + "]")

TARGET_ROLE_TOKENS = [
    "software", "swe", "sde", "backend", "front", "full stack", "fullstack",
    "full-stack", "platform", "infra", "infrastructure", "devops", "sre",
    "site reliability", "cloud", "data engineer", "data eng", "data analyst",
    "data science", "data scientist", "machine learning", "ml ", "mle",
    "ai ", "applied scientist", "research engineer", "research scientist",
    "research intern", "deep learning", "nlp", "computer vision", "perception",
    "robotics", "engineer", "developer", "appsec", "security", "qa",
    "quality", "solutions", "analytics", "analyst",
]

ROLE_DENY_TOKENS = [
    "manager", "senior", " staff ", "principal", "director", "vp ",
    "vice president", "head of", "lead ", "marketing", "sales", " hr ",
    "human resources", "finance", "accounting", "consultant", "consulting",
    "strategy", "operations", "recruiter", "designer", "ux ", "ui ",
    "graphic", "content writer", "copywriter", "product manager", " pm ",
    "program manager", "project manager",
]

US_STATE_CODES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
    "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
    "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
    "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
    "WI", "WY", "DC",
}

US_CITY_HINTS = [
    "new york", "san francisco", "seattle", "austin", "boston", "chicago",
    "los angeles", "san jose", "sunnyvale", "mountain view", "palo alto",
    "redmond", "menlo park", "san diego", "atlanta", "dallas", "denver",
    "houston", "miami", "philadelphia", "phoenix", "portland", "raleigh",
    "salt lake city", "san mateo", "santa clara", "santa monica",
    "washington", "detroit", "minneapolis", "pittsburgh", "nashville",
    "columbus", "san bruno", "bellevue", "cambridge", "irvine", "cupertino",
    "foster city", "newark", "jersey city", "ann arbor", "remote us",
    "remote, us", "remote-us", "us remote", "u.s.",
]


def clean_text(s):
    if s is None:
        return ""
    s = EM_DASH_RE.sub(",", str(s))
    s = re.sub(r"\s+", " ", s).strip()
    return s


def slugify(name):
    s = name.lower()
    s = EM_DASH_RE.sub("-", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:60] or "company"


def role_matches_targets(role):
    rl = " " + role.lower() + " "
    if "intern" not in rl:
        return False
    if not any(tok in rl for tok in TARGET_ROLE_TOKENS):
        return False
    if any(tok in rl for tok in ROLE_DENY_TOKENS):
        return False
    return True


def location_is_us(location, is_remote):
    if is_remote:
        return True
    if not location:
        return False
    loc = location.lower()
    if any(h in loc for h in US_CITY_HINTS):
        return True
    if " usa" in loc or "united states" in loc or loc.endswith(", us"):
        return True
    for code in US_STATE_CODES:
        if re.search(r"[,\s]" + code + r"\b", location):
            return True
    return False


def emit_tsv(num, date, company, role, url, site, dry_run):
    slug = slugify(company)
    path = BATCH_DIR / f"{num:03d}-{slug}-jobspy.tsv"

    notes = (
        f"JobSpy discovery via {site}. URL: {url}. "
        "Not yet evaluated; promote to per-role eval before applying."
    )
    notes = EM_DASH_RE.sub(",", notes)

    cols = [
        str(num),
        date,
        company,
        role,
        "Evaluated",
        "0.0/5",
        "❌",
        "[%03d](reports/pending.md)" % num,
        notes,
    ]
    line = "\t".join(cols) + "\n"

    if dry_run:
        return path, line
    BATCH_DIR.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(line)
    return path, line


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--keyword", default="software engineer intern")
    p.add_argument(
        "--site",
        default="linkedin,indeed,glassdoor",
        help="comma-separated jobspy sites",
    )
    p.add_argument("--hours_old", type=int, default=168, help="recency window in hours")
    p.add_argument("--limit", type=int, default=25, help="max results per site")
    p.add_argument("--location", default="United States")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    sites = [s.strip() for s in args.site.split(",") if s.strip()]
    today = _dt.date.today().isoformat()

    try:
        from jobspy import scrape_jobs  # type: ignore
    except ImportError:
        print(
            "error: python-jobspy not installed. Run: pip install python-jobspy",
            file=sys.stderr,
        )
        return 2

    print(f"# jobspy-ingest run {today}", file=sys.stderr)
    print(f"  keyword={args.keyword!r} sites={sites} hours_old={args.hours_old} limit={args.limit}", file=sys.stderr)

    # Clear stale jobspy TSVs (200-299 bucket) to avoid orphans on re-run.
    if not args.dry_run and BATCH_DIR.exists():
        cleared = 0
        for f in BATCH_DIR.glob("*-jobspy.tsv"):
            try:
                lead = int(f.name.split("-", 1)[0])
            except ValueError:
                continue
            if 200 <= lead <= 299:
                f.unlink()
                cleared += 1
        if cleared:
            print(f"  cleared {cleared} stale jobspy TSVs", file=sys.stderr)

    try:
        jobs = scrape_jobs(
            site_name=sites,
            search_term=args.keyword,
            location=args.location,
            results_wanted=args.limit,
            hours_old=args.hours_old,
            country_indeed="USA",
            is_remote=None,
        )
    except Exception as exc:  # broad: jobspy raises various site-specific exceptions
        msg = str(exc).lower()
        if "captcha" in msg or "429" in msg or "rate" in msg or "blocked" in msg:
            offending = "unknown"
            for s in sites:
                if s in msg:
                    offending = s
                    break
            print(
                f"JobSpy hit rate limit / captcha on {offending}; stopped",
                file=sys.stderr,
            )
            return 1
        print(f"jobspy error: {exc}", file=sys.stderr)
        return 1

    if jobs is None or len(jobs) == 0:
        print("  no rows returned", file=sys.stderr)
        return 0

    # jobs is a pandas DataFrame; iterate via to_dict
    rows = jobs.to_dict(orient="records") if hasattr(jobs, "to_dict") else list(jobs)
    raw = len(rows)
    print(f"  raw rows: {raw}", file=sys.stderr)

    kept = []
    seen_urls = set()
    for r in rows:
        title = clean_text(r.get("title") or r.get("job_title") or "")
        company = clean_text(r.get("company") or r.get("employer") or "")
        location = clean_text(r.get("location") or "")
        url = clean_text(r.get("job_url") or r.get("url") or "")
        is_remote = bool(r.get("is_remote") or False)
        site = clean_text(r.get("site") or "")

        if not company or not title or not url:
            continue
        if not role_matches_targets(title):
            continue
        if not location_is_us(location, is_remote):
            continue
        key = url.split("?")[0].rstrip("/").lower()
        if key in seen_urls:
            continue
        seen_urls.add(key)
        kept.append((title, company, url, site or "jobspy"))

    print(f"  kept after filter + dedupe: {len(kept)}", file=sys.stderr)

    written = []
    for offset, (title, company, url, site) in enumerate(kept):
        num = 200 + offset
        path, _line = emit_tsv(
            num=num,
            date=today,
            company=company,
            role=title,
            url=url,
            site=site,
            dry_run=args.dry_run,
        )
        written.append(path)

    if args.dry_run:
        print(f"[dry-run] would write {len(written)} TSV files", file=sys.stderr)
    else:
        print(f"wrote {len(written)} TSV files to {BATCH_DIR}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
