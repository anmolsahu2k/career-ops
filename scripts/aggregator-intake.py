#!/usr/bin/env python3
# requirements: stdlib only (urllib, re, csv, argparse, datetime, pathlib)
"""
aggregator-intake.py -- B6/B7/B8 + SimplifyJobs README aggregator (W11 G1).

Pulls public GitHub READMEs that maintain markdown-table summer 2026
internship listings, parses the tables, dedupes by URL (intra-batch AND
against existing tracker rows), drops off-season postings (Fall 2026 /
Spring 2027 / Summer 2027 / Winter), filters for target-role internships
in the US (or remote, including India remote), and emits one TSV row per
kept listing to
  career-ops/batch/tracker-additions/{NNN}-{slug}-aggregator.tsv

NNN allocation is dynamic: starts at max(applications.md NN, existing
batch/tracker-additions/*.tsv NN, 100) + 1. This avoids collisions with
the 138-row tracker that already spans NN 1-257.

Output TSV is 9 tab-separated columns matching the merge-tracker.mjs
contract (status BEFORE score; merge-tracker handles the column swap when
writing into applications.md):
  num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes

Hard rules respected:
  - No em-dashes or en-dashes anywhere in emitted text.
  - No CV PDFs, no F-1/CPT explainer text.
  - Status uses canonical "Evaluated" from templates/states.yml.
  - Score is "0.0/5" (placeholder; means "not yet scored").
  - PDF emoji is the cross mark (no eval yet).
  - Report link points at reports/pending.md (a real file, satisfies
    verify-pipeline.mjs's existence check).

Usage:
  python3 career-ops/scripts/aggregator-intake.py [--limit N] [--dry-run]
"""

import argparse
import csv
import datetime as _dt
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve()
CAREER_OPS = SCRIPT_PATH.parent.parent
DATA_DIR = CAREER_OPS / "data"
LOG_DIR = DATA_DIR

# Canonical constants + helpers live in discovery_filters.py and are shared
# with all discovery sources (jobspy-ingest.py, future handshake-ingest.py,
# etc.). Import them so adding a deny-list token or fixing a regex propagates
# to every source automatically.
import discovery_filters as df
from discovery_filters import (
    BATCH_DIR, APPS_FILE, REPORTS_DIR,
    TARGET_ROLE_TOKENS, ROLE_DENY_TOKENS,
    US_STATE_CODES, US_CITY_HINTS, REMOTE_HINTS,
    SEASON_DENY_RE, AGE_TOKEN_RE, MONTH_NAMES,
    URL_RE, EM_DASH_RE, MAX_AGE_DAYS_DEFAULT,
    parse_age, parse_date_posted, normalize_url,
    role_in_season, _normalize_company, _normalize_role,
    collect_existing_signatures, next_available_nn,
    slugify, clean_text, is_internship,
    is_brand_denied, is_phd_only_title,
)
MERGED_DIR = BATCH_DIR / "merged"

SOURCES = [
    # speedyapply (both SWE and AI) expose an "Age" column with values like
    # "5d", "1mo", "8w", "12h" — parsed by parse_age() into integer days.
    {
        "name": "speedyapply-swe",
        "url": "https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/README.md",
    },
    {
        "name": "speedyapply-ai",
        "url": "https://raw.githubusercontent.com/speedyapply/2026-AI-College-Jobs/main/README.md",
    },
    # vanshb03 exposes a "Date Posted" column with values like "Apr 29" or
    # "Apr 24" (month abbrev + day, no year) — parsed by parse_date_posted().
    {
        "name": "vanshb03-summer2027",
        "url": "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/main/README.md",
    },
    # SimplifyJobs exposes age inline in the apply-button cell as "Xd" / "Xmo"
    # — parsed by the same parse_age() function.
    {
        # SimplifyJobs default branch is "dev" (not "main"); main returns 404.
        "name": "simplifyjobs-summer2026",
        "url": "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md",
    },
    # jobright-ai family added 2026-05-05. User asked for "aaronwangj/awesome-
    # ai-internships" but that repo doesn't exist; the closest live analog is
    # the jobright-ai org's per-domain repos (157+52+35+25 stars). Default
    # branch is `master` (not `main`). Tables use markdown pipe rows with
    # company/role/location/type/posted columns. Date column uses "May 05"
    # format (parsed by parse_date_posted). Apply URLs go through
    # jobright.ai/jobs/info/{hash}?utm_campaign=1079&utm_source=git which
    # 302-redirects to the canonical employer ATS — works fine for liveness
    # gate and eval-agent fetch.
    {
        "name": "jobright-ai-swe",
        "url": "https://raw.githubusercontent.com/jobright-ai/2026-Software-Engineer-Internship/master/README.md",
    },
    {
        "name": "jobright-ai-engineer",
        "url": "https://raw.githubusercontent.com/jobright-ai/2026-Engineer-Internship/master/README.md",
    },
    {
        "name": "jobright-ai-data-analysis",
        "url": "https://raw.githubusercontent.com/jobright-ai/2026-Data-Analysis-Internship/master/README.md",
    },
    {
        "name": "jobright-ai-summary",
        "url": "https://raw.githubusercontent.com/jobright-ai/2026-Internship/master/README.md",
    },
    # PrepAIJobs and summer2026internships were dropped 2026-05-03: both
    # README tables are stale (no recent updates) and contributed mostly
    # off-cycle / already-closed postings. Re-add only if they resume daily
    # updates with a parseable freshness signal.
]

# Markdown-table parsing regexes (aggregator-specific; not shared).
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
EMOJI_LINK_RE = re.compile(r"<a [^>]*href=\"([^\"]+)\"[^>]*>")
HTML_TAG_RE = re.compile(r"<[^>]+>")
# (TARGET_ROLE_TOKENS, ROLE_DENY_TOKENS, US_STATE_CODES, US_CITY_HINTS,
# REMOTE_HINTS, SEASON_DENY_RE, AGE_TOKEN_RE, MONTH_NAMES, URL_RE, EM_DASH_RE,
# parse_age, parse_date_posted, normalize_url, role_in_season,
# _normalize_company, _normalize_role, collect_existing_signatures,
# next_available_nn, slugify, clean_text, is_internship are all imported from
# discovery_filters above.)


def fetch(url, timeout=30):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "career-ops-aggregator/1.0 (+local pipeline)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


def strip_md(text):
    if not text:
        return ""
    text = HTML_TAG_RE.sub(" ", text)
    # Collapse markdown links `[display](url)` to just `display`. Otherwise
    # jobright-ai aggregator rows leak the URL into the Company/Role
    # columns, which the dashboard renders as raw markdown noise.
    text = LINK_RE.sub(r"\1", text)
    text = text.replace("**", "").replace("`", "")
    text = EM_DASH_RE.sub(",", text)  # rule 1: no em/en dashes
    text = re.sub(r"\s+", " ", text).strip()
    return text


def first_link(cell):
    """Extract the first URL from a markdown table cell, if any."""
    if not cell:
        return None
    m = LINK_RE.search(cell)
    if m:
        url = m.group(2).strip()
        # Some READMEs embed a tracking redirect like
        # https://simplify.jobs/?utm_... -- keep as-is, dedupe will handle.
        return url
    m2 = EMOJI_LINK_RE.search(cell)
    if m2:
        return m2.group(1).strip()
    # plain url?
    m3 = re.search(r"https?://\S+", cell)
    if m3:
        return m3.group(0).rstrip(").,")
    return None


# slugify and is_internship are imported from discovery_filters above.

# Aggregator-specific overrides (semantically different from the shared
# module's defaults):
# - role_matches_targets: aggregator does NOT require "intern" in the title
#   itself, because is_internship() runs separately and accepts intern signal
#   from the type_cell.
# - location_is_us_or_remote: aggregator accepts MISSING location as US-OK
#   (many aggregator rows have no location column at all). The shared module
#   default for jobspy/etc. rejects missing location.

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


def parse_markdown_tables(md):
    """
    Yield list-of-row-cells for each markdown table found in `md`.
    Each row is a list of cell strings; the first row is the header.
    """
    lines = md.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("|") and "|" in line[1:]:
            # gather contiguous table lines
            table = []
            j = i
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                table.append(lines[j])
                j += 1
            if len(table) >= 2:
                # second row should be the separator (---)
                if re.match(r"^\|[\s:|-]+\|\s*$", table[1]):
                    rows = []
                    for row in table:
                        cells = [c.strip() for c in row.strip().strip("|").split("|")]
                        rows.append(cells)
                    yield rows
            i = j
        else:
            i += 1


HTML_TABLE_RE = re.compile(r"<table[^>]*>(.*?)</table>", re.DOTALL | re.IGNORECASE)
HTML_TR_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL | re.IGNORECASE)
HTML_TH_RE = re.compile(r"<th[^>]*>(.*?)</th>", re.DOTALL | re.IGNORECASE)
HTML_TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.DOTALL | re.IGNORECASE)


def parse_html_tables(md):
    """
    Yield list-of-row-cells for each HTML <table> found in `md`. The
    SimplifyJobs README uses HTML tables; speedyapply / vanshb03 use
    markdown pipe tables. Both formats are returned as the same shape:
    rows[0] is the header, rows[1] is treated as a separator (filler),
    rows[2:] are the body. Cells are returned as raw HTML so downstream
    can run first_link() against them.
    """
    for table_match in HTML_TABLE_RE.finditer(md):
        body = table_match.group(1)
        rows = []
        # headers
        header_cells = []
        for tr in HTML_TR_RE.finditer(body):
            tr_body = tr.group(1)
            ths = HTML_TH_RE.findall(tr_body)
            if ths:
                header_cells = [h.strip() for h in ths]
                break
        if not header_cells:
            continue
        rows.append(header_cells)
        rows.append(["---"] * len(header_cells))  # filler separator
        for tr in HTML_TR_RE.finditer(body):
            tr_body = tr.group(1)
            tds = HTML_TD_RE.findall(tr_body)
            if not tds:
                continue
            rows.append([td.strip() for td in tds])
        if len(rows) >= 3:
            yield rows


def parse_all_tables(md):
    """Parse both markdown pipe tables and HTML tables from a README."""
    yielded = 0
    for tbl in parse_markdown_tables(md):
        yielded += 1
        yield tbl
    for tbl in parse_html_tables(md):
        yielded += 1
        yield tbl


def find_col(header, *names):
    """Return the first column index whose header (case-insensitive)
    contains any of the provided names, else None."""
    lower = [h.lower().strip() for h in header]
    for nm in names:
        for idx, h in enumerate(lower):
            if nm in h:
                return idx
    return None


def harvest_table(rows, source_name):
    """Yield dicts {company, role, location, url, source} from a parsed table."""
    if len(rows) < 3:
        return
    header = [strip_md(c) for c in rows[0]]
    body = rows[2:]  # rows[1] is the separator

    company_idx = find_col(header, "company", "employer")
    role_idx = find_col(header, "role", "position", "title", "job")
    loc_idx = find_col(header, "location")
    # speedyapply uses "Posting" for the apply column; SimplifyJobs uses
    # "Application"; vanshb03 uses "Application/Link".
    url_idx = find_col(header, "application", "apply", "posting", "link")
    type_idx = find_col(header, "type")
    # Freshness: speedyapply has "Age" column ("5d", "1mo"); vanshb03 has
    # "Date Posted" ("Apr 29"); SimplifyJobs encodes age inline in the apply
    # cell with a "Xd" / "Xmo" badge — handled below as a fallback scan.
    age_idx = find_col(header, "age")
    date_posted_idx = find_col(header, "date posted", "posted", "date")

    # If we cannot identify a company column AND a role column, bail out.
    if company_idx is None or role_idx is None:
        return

    # Many aggregator READMEs use a leading arrow ↳ to mean "same company as
    # the row above"; track previous company to resolve those.
    last_company = ""
    for raw in body:
        if len(raw) < 2:
            continue
        joined = "|".join(raw)
        if not joined.strip("|").strip():
            continue
        # strip markdown formatting
        cells = [strip_md(c) for c in raw]

        comp_cell = cells[company_idx] if company_idx < len(cells) else ""
        role_cell = cells[role_idx] if role_idx < len(cells) else ""
        loc_cell = cells[loc_idx] if (loc_idx is not None and loc_idx < len(cells)) else ""
        url_cell_raw = raw[url_idx] if (url_idx is not None and url_idx < len(raw)) else ""
        type_cell = cells[type_idx] if (type_idx is not None and type_idx < len(cells)) else ""
        age_cell = cells[age_idx] if (age_idx is not None and age_idx < len(cells)) else ""
        date_posted_cell = cells[date_posted_idx] if (date_posted_idx is not None and date_posted_idx < len(cells)) else ""

        # Resolve freshness. Try age column first (speedyapply, SimplifyJobs),
        # fall back to date-posted (vanshb03), then last-resort scan the apply
        # cell for an embedded badge token (SimplifyJobs HTML rows).
        age_days = parse_age(age_cell)
        if age_days is None:
            age_days = parse_date_posted(date_posted_cell)
        if age_days is None:
            age_days = parse_age(url_cell_raw)

        # Resolve "same as above" markers
        if comp_cell in ("", "↳", "->", "\"", "''"):
            comp_cell = last_company
        else:
            last_company = comp_cell

        url = first_link(url_cell_raw) or first_link(raw[role_idx]) or first_link(raw[company_idx] if company_idx < len(raw) else "")
        if not url:
            continue
        # strip query strings only when they're tracking; keep as-is for dedupe

        if not comp_cell or not role_cell:
            continue

        yield {
            "company": comp_cell,
            "role": role_cell,
            "location": loc_cell,
            "url": url.strip(),
            "type": type_cell,
            "source": source_name,
            "age_days": age_days,  # int or None if source/row has no signal
        }


def write_tsv(num, date, company, role, notes_url, source, age_days, dry_run):
    slug = slugify(company)
    fname = f"{num:03d}-{slug}-aggregator.tsv"
    path = BATCH_DIR / fname

    age_blurb = f"Posted {age_days}d ago. " if age_days is not None else "Age unknown. "
    notes = (
        f"Aggregator discovery via {source}. {age_blurb}URL: {notes_url}. "
        "Not yet evaluated; promote to per-role eval before applying."
    )
    notes = EM_DASH_RE.sub(",", notes)  # safety net

    cols = [
        str(num),
        date,
        company,
        role,
        "Evaluated",  # canonical status (means: discovery row, pending eval)
        "0.0/5",
        "❌",  # cross mark, no eval yet
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
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help="cap total TSVs written (after dedup + filter)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be written without creating files",
    )
    p.add_argument(
        "--no-clean",
        action="store_true",
        help="skip clearing existing *-aggregator.tsv files (use when extending an in-flight batch)",
    )
    p.add_argument(
        "--max-age-days",
        type=int,
        default=MAX_AGE_DAYS_DEFAULT,
        help=f"drop rows whose posting is older than N days (default "
             f"{MAX_AGE_DAYS_DEFAULT}). Rows with no parseable age are KEPT "
             "(so vanshb03/SimplifyJobs rows missing dates aren't silently filtered).",
    )
    args = p.parse_args(argv)

    today = _dt.date.today().isoformat()
    print(f"# aggregator-intake run {today}", file=sys.stderr)

    # Clean up stale aggregator TSVs in batch/tracker-additions/ (NOT merged/)
    # so re-runs don't leave orphan files when filter ordering shifts. We
    # match by the `-aggregator.tsv` suffix only; jobspy and handshake output
    # use different suffixes and are never touched. Skipped under --no-clean
    # which is the right mode when extending an in-flight batch (in-flight
    # TSVs are already in the dedup set from BATCH_DIR scan, so we won't
    # rewrite them anyway).
    if not args.dry_run and not args.no_clean and BATCH_DIR.exists():
        cleared = 0
        for f in BATCH_DIR.glob("*-aggregator.tsv"):
            f.unlink()
            cleared += 1
        if cleared:
            print(f"  cleared {cleared} stale aggregator TSVs", file=sys.stderr)
    elif args.no_clean:
        print(f"  --no-clean: keeping existing aggregator TSVs in {BATCH_DIR}", file=sys.stderr)

    fetched_per_source = {}
    all_rows = []

    for src in SOURCES:
        try:
            md = fetch(src["url"])
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            print(f"  ! fetch failed for {src['name']}: {exc}", file=sys.stderr)
            fetched_per_source[src["name"]] = {"raw": 0, "kept": 0, "error": str(exc)}
            continue

        raw_count = 0
        for table in parse_all_tables(md):
            for entry in harvest_table(table, src["name"]):
                raw_count += 1
                all_rows.append(entry)
        fetched_per_source[src["name"]] = {"raw": raw_count, "kept": 0}
        print(f"  + {src['name']}: {raw_count} raw rows", file=sys.stderr)

    # Dedupe by URL (case-insensitive, strip trailing slash + utm)
    seen = set()
    deduped = []
    for entry in all_rows:
        key = normalize_url(entry["url"])
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(entry)

    after_dedup = len(deduped)
    print(f"  = {after_dedup} after URL dedupe", file=sys.stderr)

    # Filter: must be internship + target role + US/remote + in-season +
    # brand-allowed + non-PhD-only.
    kept = []
    dropped_brand = dropped_phd = 0
    for entry in deduped:
        if not is_internship(entry["role"], entry.get("type", "")):
            continue
        if not role_matches_targets(entry["role"]):
            continue
        if not role_in_season(entry["role"]):
            continue
        if is_brand_denied(entry["company"]):
            dropped_brand += 1
            continue
        if is_phd_only_title(entry["role"]):
            dropped_phd += 1
            continue
        if not location_is_us_or_remote(entry.get("location", "")):
            continue
        kept.append(entry)

    after_filter = len(kept)
    print(
        f"  = {after_filter} after target-role + US/remote + season + brand + PhD filter "
        f"({dropped_brand} brand-deny, {dropped_phd} PhD-only)",
        file=sys.stderr,
    )

    # Age filter: drop rows older than --max-age-days. Rows with no parseable
    # age signal (sources/columns that don't expose freshness) are KEPT, so a
    # source-format change doesn't silently nuke the whole batch.
    fresh = []
    dropped_age = 0
    for entry in kept:
        age = entry.get("age_days")
        if age is not None and age > args.max_age_days:
            dropped_age += 1
            continue
        fresh.append(entry)
    kept = fresh
    print(
        f"  = {len(kept)} after age filter "
        f"({dropped_age} dropped as > {args.max_age_days}d old; "
        f"rows with no age signal kept by default)",
        file=sys.stderr,
    )

    # Cross-dedup against existing tracker. Use BOTH URL match (catches the
    # easy case) AND company+role fingerprint (catches the case where the
    # aggregator has simplify.jobs/p/... redirects while applications.md has
    # the direct ATS URL). Must run before --limit so the budget isn't eaten
    # by rows merge-tracker.mjs would just discard.
    existing_urls, existing_fps = collect_existing_signatures()
    print(
        f"  ~ {len(existing_urls)} URLs and {len(existing_fps)} company/role fingerprints "
        f"known from applications.md + reports/",
        file=sys.stderr,
    )
    novel = []
    dropped_url = dropped_fp = 0
    for e in kept:
        if normalize_url(e["url"]) in existing_urls:
            dropped_url += 1
            continue
        fp = (_normalize_company(e["company"]), _normalize_role(e["role"]))
        if fp[0] and fp[1] and fp in existing_fps:
            dropped_fp += 1
            continue
        novel.append(e)
        existing_fps.add(fp)  # also dedup intra-batch by fingerprint
    after_tracker_dedup = len(novel)
    print(
        f"  = {after_tracker_dedup} after tracker dedup "
        f"({dropped_url} URL match, {dropped_fp} company+role fingerprint match)",
        file=sys.stderr,
    )

    # Per-source kept counts (post-filter, post-tracker-dedup)
    for entry in novel:
        s = fetched_per_source.get(entry["source"])
        if s:
            s["kept"] += 1

    if args.limit is not None:
        novel = novel[: args.limit]
        print(f"  = {len(novel)} after --limit", file=sys.stderr)

    # Emit TSVs with dynamic NN starting after the highest existing number.
    start_nn = next_available_nn()
    print(f"  NN allocation starts at {start_nn} (max existing + 1)", file=sys.stderr)
    written = []
    for offset, entry in enumerate(novel):
        num = start_nn + offset
        path, _line = write_tsv(
            num=num,
            date=today,
            company=entry["company"],
            role=entry["role"],
            notes_url=entry["url"],
            source=entry["source"],
            age_days=entry.get("age_days"),
            dry_run=args.dry_run,
        )
        written.append((path, entry))

    if args.dry_run:
        print(f"\n[dry-run] would write {len(written)} TSV files", file=sys.stderr)
        for path, entry in written[:10]:
            print(f"  -> {path.name}: {entry['company']} | {entry['role']}", file=sys.stderr)
    else:
        print(f"\nwrote {len(written)} TSV files to {BATCH_DIR}", file=sys.stderr)

    # Write run log
    log_path = LOG_DIR / f"aggregator-intake-{today}.md"
    if not args.dry_run:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        lines = [
            f"# Aggregator Intake Run, {today}",
            "",
            "Adapter: career-ops/scripts/aggregator-intake.py (W11 Group 1).",
            "",
            "## Per-source counts",
            "",
            "| Source | Raw rows | Kept after filter |",
            "|--------|----------|-------------------|",
        ]
        for src in SOURCES:
            stats = fetched_per_source.get(src["name"], {"raw": 0, "kept": 0})
            err = stats.get("error")
            note = f" (fetch error: {err})" if err else ""
            lines.append(
                f"| {src['name']}{note} | {stats.get('raw', 0)} | {stats.get('kept', 0)} |"
            )
        lines += [
            "",
            f"- Combined raw rows: {sum(s.get('raw', 0) for s in fetched_per_source.values())}",
            f"- After URL dedup: {after_dedup}",
            f"- After target-role + US/remote + season filter: {after_filter}",
            f"- After cross-dedup vs applications.md + reports/: {after_tracker_dedup}",
            f"- TSVs written: {len(written)}",
            f"- Output dir: career-ops/batch/tracker-additions/",
            "",
            "Filter rules: role must contain a target token (SDE/AI/MLE/DS/DE/DA + ",
            "adjacents), must not contain a deny token (Senior/Manager/PM/Sales/etc.), ",
            "must not match a SEASON_DENY pattern (Fall 2026 / Spring-Summer 2027+), ",
            "location must be US, US-remote, or generic remote (India remote OK, no CPT). ",
            "Then cross-dedup against URLs already in applications.md and reports/. ",
            "NN allocation is dynamic: starts at max(applications.md NN, batch/*.tsv NN, 99) + 1.",
            "",
            "Next step: run merge-tracker.mjs, dedup-tracker.mjs, normalize-statuses.mjs, ",
            "then verify-pipeline.mjs from the career-ops/ directory.",
            "",
        ]
        log_text = "\n".join(lines)
        # final em-dash sweep on the log
        log_text = EM_DASH_RE.sub(",", log_text)
        with open(log_path, "w", encoding="utf-8") as fh:
            fh.write(log_text)
        print(f"log: {log_path}", file=sys.stderr)
    else:
        print(f"[dry-run] would write log: {log_path}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
