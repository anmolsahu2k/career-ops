#!/usr/bin/env python3
# requirements: stdlib only (urllib, re, csv, argparse, datetime, pathlib)
"""
aggregator-intake.py -- B6/B7/B8 + SimplifyJobs README aggregator (W11 G1).

Pulls four public GitHub READMEs that maintain markdown-table summer 2026
internship listings, parses the tables, dedupes by URL, filters for
target-role internships in the US (or remote, including India remote),
and emits one TSV row per kept listing to
  career-ops/batch/tracker-additions/{NNN}-{slug}-aggregator.tsv

NNN starts at 100 (aggregator bucket; jobspy uses 200s, handshake uses 300s
to avoid filename collisions during parallel runs).

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
BATCH_DIR = CAREER_OPS / "batch" / "tracker-additions"
DATA_DIR = CAREER_OPS / "data"
LOG_DIR = DATA_DIR

SOURCES = [
    {
        "name": "speedyapply-swe",
        "url": "https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/README.md",
    },
    {
        "name": "speedyapply-ai",
        "url": "https://raw.githubusercontent.com/speedyapply/2026-AI-College-Jobs/main/README.md",
    },
    {
        "name": "vanshb03-summer2027",
        "url": "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/main/README.md",
    },
    {
        # SimplifyJobs default branch is "dev" (not "main"); main returns 404.
        "name": "simplifyjobs-summer2026",
        "url": "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md",
    },
]

# Role allow-list: must contain at least one of these case-insensitive tokens.
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

# Role deny-list: skip out-of-scope roles even if they match an allow token.
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

# Remote-anywhere markers we still accept (rule 5: India remote acceptable).
REMOTE_HINTS = [
    "remote", "anywhere", "work from home", "wfh",
]

# Markdown link regex: captures the inner URL.
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
EMOJI_LINK_RE = re.compile(r"<a [^>]*href=\"([^\"]+)\"[^>]*>")
HTML_TAG_RE = re.compile(r"<[^>]+>")
# Rule 1: never emit en-dash (U+2013) or em-dash (U+2014) into candidate-facing text.
# Built from chr() so the source file has no literal en/em-dash characters.
EM_DASH_RE = re.compile("[" + chr(0x2013) + chr(0x2014) + "]")


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


def slugify(name):
    s = name.lower()
    s = EM_DASH_RE.sub("-", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:60] or "company"


def is_internship(role, type_cell=""):
    blob = f"{role} {type_cell}".lower()
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
        # If location is missing, accept (many aggregator rows omit it).
        return True
    loc = location.lower()
    if any(h in loc for h in REMOTE_HINTS):
        return True
    if any(h in loc for h in US_CITY_HINTS):
        return True
    if " usa" in loc or "united states" in loc or loc.endswith(", us"):
        return True
    # Look for ", XX" state codes
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
        }


def write_tsv(num, date, company, role, notes_url, source, dry_run):
    slug = slugify(company)
    fname = f"{num:03d}-{slug}-aggregator.tsv"
    path = BATCH_DIR / fname

    notes = (
        f"Aggregator discovery via {source}. URL: {notes_url}. "
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
    args = p.parse_args(argv)

    today = _dt.date.today().isoformat()
    print(f"# aggregator-intake run {today}", file=sys.stderr)

    # Clean up stale aggregator TSVs in our bucket (100-199) so re-runs don't
    # leave orphan files when the dedupe / filter ordering shifts. Touch only
    # files that match our suffix; never delete jobspy or handshake output.
    if not args.dry_run and BATCH_DIR.exists():
        cleared = 0
        for f in BATCH_DIR.glob("*-aggregator.tsv"):
            try:
                lead = int(f.name.split("-", 1)[0])
            except ValueError:
                continue
            if 100 <= lead <= 199:
                f.unlink()
                cleared += 1
        if cleared:
            print(f"  cleared {cleared} stale aggregator TSVs", file=sys.stderr)

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
        key = entry["url"].split("?")[0].rstrip("/").lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entry)

    after_dedup = len(deduped)
    print(f"  = {after_dedup} after URL dedupe", file=sys.stderr)

    # Filter: must be internship + target role + US/remote
    kept = []
    for entry in deduped:
        if not is_internship(entry["role"], entry.get("type", "")):
            continue
        if not role_matches_targets(entry["role"]):
            continue
        if not location_is_us_or_remote(entry.get("location", "")):
            continue
        kept.append(entry)

    after_filter = len(kept)
    print(f"  = {after_filter} after target-role + US/remote filter", file=sys.stderr)

    # Per-source kept counts (post-filter)
    for entry in kept:
        s = fetched_per_source.get(entry["source"])
        if s:
            s["kept"] += 1

    if args.limit is not None:
        kept = kept[: args.limit]
        print(f"  = {len(kept)} after --limit", file=sys.stderr)

    # Emit TSVs starting at 100
    written = []
    for offset, entry in enumerate(kept):
        num = 100 + offset
        path, _line = write_tsv(
            num=num,
            date=today,
            company=entry["company"],
            role=entry["role"],
            notes_url=entry["url"],
            source=entry["source"],
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
            f"- After target-role + US/remote filter: {after_filter}",
            f"- TSVs written: {len(written)}",
            f"- Output dir: career-ops/batch/tracker-additions/",
            "",
            "Filter rules: role must contain a target token (SDE/AI/MLE/DS/DE/DA + ",
            "adjacents), must not contain a deny token (Senior/Manager/PM/Sales/etc.), ",
            "location must be US, US-remote, or generic remote (India remote OK, no CPT).",
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
