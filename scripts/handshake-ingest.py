#!/usr/bin/env python3
# requirements: stdlib only (csv, argparse, datetime, pathlib, re)
# Smoke test: drop a sample CSV at career-ops/data/handshake-sample.csv and run
#   python3 career-ops/scripts/handshake-ingest.py career-ops/data/handshake-sample.csv --dry-run
"""
handshake-ingest.py -- F19 Handshake CSV ingester (W11 G1).

The user manually exports saved searches from the Handshake UI (CMU SSO,
no public API, no scraping per ToS). This script ingests those CSV files
and emits one TSV row per kept listing into
  career-ops/batch/tracker-additions/{NNN}-{slug}-handshake.tsv

NNN starts at 300 (handshake bucket; aggregator uses 100s, jobspy 200s).

Expected Handshake CSV columns (case-insensitive, partial-match tolerant):
  - "Job Title" / "Title"
  - "Employer" / "Company"
  - "Location" / "Job Location"
  - "Job URL" / "URL" / "Apply URL"
  - "Posted Date" / "Date Posted"
  - "Job Type" / "Position Type"

Filters:
  - "Job Type" must contain "Internship" (case-insensitive).
  - Location must be US, US-remote, or generic remote.
  - Role title must match the target-role allow-list.

Hard rules respected:
  - No em-dashes or en-dashes in any emitted text.
  - No CV PDFs, no F-1/CPT explainer text.
  - Status uses canonical "Evaluated" from templates/states.yml.
  - Score is "0.0/5" (placeholder).
  - PDF emoji is the cross mark.
  - Report link points at reports/pending.md.

Usage:
  python3 career-ops/scripts/handshake-ingest.py path/to/handshake-YYYY-MM-DD.csv \\
      [--limit N] [--dry-run]
"""

import argparse
import csv
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

REMOTE_HINTS = ["remote", "anywhere", "work from home", "wfh"]


def slugify(name):
    s = name.lower()
    s = EM_DASH_RE.sub("-", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:60] or "company"


def clean_text(s):
    if s is None:
        return ""
    s = EM_DASH_RE.sub(",", str(s))
    s = re.sub(r"\s+", " ", s).strip()
    return s


def find_field(row, *names):
    """Look up a CSV row dict with case- and whitespace-insensitive match."""
    norm = {re.sub(r"\s+", "", k.lower()): v for k, v in row.items() if k}
    for nm in names:
        key = re.sub(r"\s+", "", nm.lower())
        if key in norm:
            return norm[key]
    # fallback: substring match against any header
    for nm in names:
        nlow = nm.lower()
        for k, v in row.items():
            if k and nlow in k.lower():
                return v
    return ""


def is_internship(job_type, role):
    blob = f"{job_type} {role}".lower()
    return "intern" in blob


def role_matches_targets(role):
    rl = " " + role.lower() + " "
    if not any(tok in rl for tok in TARGET_ROLE_TOKENS):
        return False
    if any(tok in rl for tok in ROLE_DENY_TOKENS):
        return False
    return True


def location_is_us_or_remote(location):
    if not location:
        return True
    loc = location.lower()
    if any(h in loc for h in REMOTE_HINTS):
        return True
    if any(h in loc for h in US_CITY_HINTS):
        return True
    if " usa" in loc or "united states" in loc or loc.endswith(", us"):
        return True
    for code in US_STATE_CODES:
        if re.search(r"[,\s]" + code + r"\b", location):
            return True
    return False


def emit_tsv(num, date, company, role, url, source_csv, dry_run):
    slug = slugify(company)
    path = BATCH_DIR / f"{num:03d}-{slug}-handshake.tsv"

    notes = (
        f"Handshake import via {source_csv}. URL: {url}. "
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
    p.add_argument("csv_path", help="path to a Handshake CSV export")
    p.add_argument("--limit", type=int, default=None, help="cap TSVs written")
    p.add_argument("--dry-run", action="store_true", help="preview only, write nothing")
    args = p.parse_args(argv)

    csv_path = Path(args.csv_path).expanduser().resolve()
    if not csv_path.exists():
        print(f"error: CSV not found: {csv_path}", file=sys.stderr)
        return 2

    today = _dt.date.today().isoformat()
    print(f"# handshake-ingest run {today} on {csv_path.name}", file=sys.stderr)

    # Clear stale handshake TSVs (300-399 bucket) to avoid orphans on re-run.
    if not args.dry_run and BATCH_DIR.exists():
        cleared = 0
        for f in BATCH_DIR.glob("*-handshake.tsv"):
            try:
                lead = int(f.name.split("-", 1)[0])
            except ValueError:
                continue
            if 300 <= lead <= 399:
                f.unlink()
                cleared += 1
        if cleared:
            print(f"  cleared {cleared} stale handshake TSVs", file=sys.stderr)

    raw = 0
    kept = []
    seen_urls = set()
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            raw += 1
            company = clean_text(find_field(row, "employer", "company"))
            role = clean_text(find_field(row, "job title", "title", "position"))
            location = clean_text(find_field(row, "location", "job location"))
            url = clean_text(find_field(row, "job url", "url", "apply url", "link"))
            job_type = clean_text(find_field(row, "job type", "position type", "type"))

            if not company or not role:
                continue
            if not is_internship(job_type, role):
                continue
            if not role_matches_targets(role):
                continue
            if not location_is_us_or_remote(location):
                continue
            if not url:
                # Handshake rows without a Job URL are often unusable downstream.
                continue
            key = url.split("?")[0].rstrip("/").lower()
            if key in seen_urls:
                continue
            seen_urls.add(key)
            kept.append({"company": company, "role": role, "url": url})

    print(f"  raw rows: {raw}", file=sys.stderr)
    print(f"  kept after filters + dedupe: {len(kept)}", file=sys.stderr)

    if args.limit is not None:
        kept = kept[: args.limit]
        print(f"  after --limit: {len(kept)}", file=sys.stderr)

    written = []
    for offset, entry in enumerate(kept):
        num = 300 + offset
        path, _line = emit_tsv(
            num=num,
            date=today,
            company=entry["company"],
            role=entry["role"],
            url=entry["url"],
            source_csv=csv_path.name,
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
