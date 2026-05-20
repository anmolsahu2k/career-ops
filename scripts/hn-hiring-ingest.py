#!/usr/bin/env python3
"""hn-hiring-ingest.py - Hacker News "Ask HN: Who is hiring?" adapter.

The first of every month, an HN whoishiring bot starts a single thread titled
"Ask HN: Who is hiring? ({Month} {Year})". Top-level comments follow a loose
convention:

  Company | Role | Location | Full-time/Part-time/Intern | (optional comp/visa)
  Description...
  Apply: <link>

This adapter pulls the latest thread via the HN Algolia search API, fetches
all top-level comments via the HN items API, parses the first-line header
into (company, role, location, type, comp), filters for INTERN entries,
and emits placeholder TSVs.

Yield: low (typically 2-8 intern roles per monthly thread) but unique - HN
hiring rarely overlaps with the GitHub aggregators because postings are
small startups that don't run full ATS pipelines.

URL scheme: each comment becomes a synthetic permalink:
  https://news.ycombinator.com/item?id={comment_id}
The actual application URL is buried in the comment body (often `<a href>`
inside the description); we extract it as the canonical apply URL when
available, falling back to the HN permalink.

Usage:
  python3 scripts/hn-hiring-ingest.py
      [--month YYYY-MM]      # default: current month's thread
      [--max-age-days 21]
      [--no-clean]
      [--no-tracker-dedup]
      [--dry-run]
"""

import argparse
import datetime as _dt
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from html import unescape

import discovery_filters as df


ALGOLIA_SEARCH = (
    "https://hn.algolia.com/api/v1/search_by_date"
    "?query=who+is+hiring&tags=story,author_whoishiring&hitsPerPage=12"
)
HN_ITEM_API = "https://hn.algolia.com/api/v1/items/{id}"
HN_PERMALINK = "https://news.ycombinator.com/item?id={id}"

UA = "career-ops-hn-ingest/1.0 (+local pipeline)"

# Recognize the standard HN whoishiring header line. Splits on " | " or " - "
# (em-dashes already normalized to commas downstream).
HEADER_SEP_RE = re.compile(r"\s*[|]\s*|\s+[-–—]\s+")

INTERN_TOKEN_RE = re.compile(
    r"\b(intern(s|ship|ships)?|co-?op|apprentice|summer\s*20\d{2})\b",
    re.IGNORECASE,
)

# Some posters use brackets or parens around metadata; strip them for matching.
META_STRIP_RE = re.compile(r"[\[\]()<>]")
# Common location tokens to recognize a "location" field heuristically.
LOC_HINT_RE = re.compile(
    r"^(remote|onsite|hybrid|us|usa|united states|nyc|sf|seattle|austin|"
    r"boston|chicago|la|los angeles|san francisco|san jose|new york|"
    r"london|berlin|toronto|amsterdam|paris|bangalore|tokyo|"
    r"\w+,\s*[A-Z]{2}|\w+,\s*\w+|\w+\s+\w+,\s*[A-Z]{2})",
    re.IGNORECASE,
)


def _http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def find_latest_thread(month_str=None):
    """Return the comment-thread id of the latest 'Ask HN: Who is hiring?' post.

    If month_str (YYYY-MM) is given, find that month's thread; else newest.
    """
    text = _http_get(ALGOLIA_SEARCH)
    data = json.loads(text)
    hits = data.get("hits", []) or []
    candidates = []
    for h in hits:
        title = (h.get("title") or "").lower()
        if "who is hiring" not in title:
            continue
        if "wants to be hired" in title:
            continue
        candidates.append(h)
    if not candidates:
        return None, None
    if month_str:
        target = month_str  # "2026-05"
        for h in candidates:
            created = (h.get("created_at") or "")[:7]
            if created == target:
                return h.get("objectID"), h.get("title")
        return None, None
    # Newest by created_at
    candidates.sort(key=lambda h: h.get("created_at", ""), reverse=True)
    return candidates[0].get("objectID"), candidates[0].get("title")


def fetch_all_comments(thread_id):
    """Fetch the thread and return list of top-level comment dicts."""
    text = _http_get(HN_ITEM_API.format(id=thread_id))
    data = json.loads(text)
    return data.get("children", []) or []


HREF_RE = re.compile(r'href="([^"]+)"')


def first_real_url(html_text):
    """Pull the first non-news.ycombinator URL out of a comment HTML body."""
    if not html_text:
        return None
    for m in HREF_RE.finditer(html_text):
        url = unescape(m.group(1))
        if "news.ycombinator.com" in url:
            continue
        if not url.startswith(("http://", "https://")):
            continue
        return url
    return None


def parse_header_line(text):
    """Best-effort parse of the first non-empty line of a HN hiring comment.

    Returns dict with keys: company, role, location, work_type (intern/FT),
    raw_header (the line itself for debugging).

    Fills empties on best-effort; downstream unified filter rejects any row
    missing company/role.
    """
    if not text:
        return {}
    # Strip HTML tags, decode entities
    plain = re.sub(r"<[^>]+>", " ", text)
    plain = unescape(plain)
    plain = re.sub(r"\s+", " ", plain).strip()
    # First sentence-ish chunk: until <p> break or first period
    first_chunk = plain.split(". ")[0]
    # Limit to ~250 chars to avoid swallowing whole paragraphs
    first_chunk = first_chunk[:250]

    parts = [p.strip() for p in HEADER_SEP_RE.split(first_chunk) if p.strip()]
    if len(parts) < 2:
        return {}

    out = {
        "company": "",
        "role": "",
        "location": "",
        "work_type": "",
        "raw_header": first_chunk,
    }

    # Slot 0 is almost always the company name.
    out["company"] = META_STRIP_RE.sub("", parts[0]).strip()

    # Identify which slots look like role / location / work_type / comp.
    for slot in parts[1:]:
        sl = slot.strip()
        if not sl:
            continue
        sl_lower = sl.lower()
        if (
            not out["work_type"]
            and re.search(
                r"\b(full[- ]?time|part[- ]?time|contract|intern(ship)?|co-?op|"
                r"apprentice|summer)\b",
                sl_lower,
            )
        ):
            out["work_type"] = sl
            continue
        if not out["location"] and (LOC_HINT_RE.search(sl_lower) or "remote" in sl_lower):
            out["location"] = sl
            continue
        # Pricing tokens: '$XXk', 'salary', 'visa'
        if re.search(r"\$\d|\bvisa\b|\bequity\b|comp:\s*", sl_lower):
            continue
        if not out["role"]:
            out["role"] = sl
            continue
        # Subsequent slots: ignore (extra metadata)
    return out


def normalize_comment(comment):
    """Map a single HN top-level comment to discovery_filters row schema."""
    cid = comment.get("id")
    text_html = comment.get("text") or ""
    parsed = parse_header_line(text_html)
    if not parsed.get("company") or not parsed.get("role"):
        return None
    role = parsed["role"]
    work_type = parsed.get("work_type", "")
    # Combine role + work_type for the title-level intern detection.
    role_for_filter = (role + " " + work_type).strip()
    if not INTERN_TOKEN_RE.search(role_for_filter):
        return None  # skip non-intern HN entries (the bulk of the thread)

    apply_url = first_real_url(text_html)
    permalink = HN_PERMALINK.format(id=cid)
    url = apply_url or permalink

    # Age: HN comment has created_at (ISO); compute days since.
    age_days = None
    created = comment.get("created_at")
    if created:
        try:
            posted = _dt.datetime.fromisoformat(created.replace("Z", "+00:00")).date()
            age_days = (_dt.date.today() - posted).days
            if age_days < 0:
                age_days = 0
        except (ValueError, TypeError):
            age_days = None

    location = parsed.get("location", "")
    is_remote = "remote" in location.lower()

    return {
        "title": role_for_filter,
        "company": parsed["company"],
        "url": url,
        "location": location,
        "is_remote": is_remote,
        "age_days": age_days,
        "_hn_permalink": permalink,
        "_hn_apply_url": apply_url,
        "_raw_header": parsed.get("raw_header", ""),
    }


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument(
        "--month",
        default=None,
        help="YYYY-MM target month thread (default: latest)",
    )
    p.add_argument("--max-age-days", type=int, default=df.MAX_AGE_DAYS_DEFAULT)
    p.add_argument("--no-clean", action="store_true")
    p.add_argument("--no-tracker-dedup", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    today_iso = _dt.date.today().isoformat()
    print(f"# hn-hiring-ingest run {today_iso}", file=sys.stderr)

    if not args.dry_run and df.BATCH_DIR.exists() and not args.no_clean:
        cleared = sum(1 for f in df.BATCH_DIR.glob("*-hnhiring.tsv"))
        for f in df.BATCH_DIR.glob("*-hnhiring.tsv"):
            f.unlink()
        if cleared:
            print(
                f"  cleared {cleared} stale hnhiring TSVs (use --no-clean to keep them)",
                file=sys.stderr,
            )

    thread_id, thread_title = find_latest_thread(args.month)
    if not thread_id:
        print(f"  no thread found for month={args.month or 'latest'}", file=sys.stderr)
        return 0
    print(f"  thread: {thread_id} | {thread_title}", file=sys.stderr)

    try:
        comments = fetch_all_comments(thread_id)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        print(f"  fetch failed: {exc}", file=sys.stderr)
        return 1

    print(f"  top-level comments: {len(comments)}", file=sys.stderr)

    raw_rows = []
    for c in comments:
        row = normalize_comment(c)
        if row:
            raw_rows.append(row)
    print(f"  intern-tagged rows: {len(raw_rows)}", file=sys.stderr)
    if not raw_rows:
        print(
            "  no intern entries in this thread (typical: HN whoishiring is FTE-heavy)",
            file=sys.stderr,
        )
        return 0

    if args.no_tracker_dedup:
        existing_urls, existing_fps = set(), set()
        print("  skipping tracker dedup (--no-tracker-dedup)", file=sys.stderr)
    else:
        existing_urls, existing_fps = df.collect_existing_signatures()
        print(
            f"  tracker baseline: {len(existing_urls)} URLs, {len(existing_fps)} fingerprints",
            file=sys.stderr,
        )

    kept, drops = df.apply_unified_filter(
        raw_rows,
        source_tag="hnhiring",
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
        if row.get("_hn_permalink"):
            extras["hn-permalink"] = row["_hn_permalink"]
        if row.get("_raw_header"):
            extras["hn-header"] = row["_raw_header"][:140]
        path, _line = df.emit_tsv(
            num=num,
            date=today_iso,
            company=row["company"],
            role=row["title"],
            url=row["url"],
            source="hnhiring",
            age_days=row.get("age_days"),
            suffix="hnhiring",
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
