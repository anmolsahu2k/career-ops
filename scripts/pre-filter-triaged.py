#!/usr/bin/env python3
# requirements: stdlib only

"""
pre-filter-triaged.py

Cheap deterministic pre-filter for Triaged rows in applications.md.
Goal: kill the 60-80% structural false positives BEFORE spending tokens
on per-JD evaluation agents.

Filter passes (in order):
  1. Visa-block companies (Oracle, Wells Fargo, big-bank, defense ITAR).
  2. Dead URL via Greenhouse-direct API (boards-api.greenhouse.io 404).
  3. Non-target weak fit (Lyft Mobile iOS / Android-only when stack mismatch).
  4. Survivors flagged with Status: Triaged-Verified for downstream eval.

Outputs:
  - Rewrites applications.md in place (Status / Notes columns)
  - Prints survivor count + breakdown of kills

Usage:
  python3 scripts/pre-filter-triaged.py            # apply
  python3 scripts/pre-filter-triaged.py --dry-run  # preview only
"""

import argparse
import re
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

CO = Path(__file__).resolve().parent.parent
APPS = CO / "data" / "applications.md"

# Companies known to bar F-1/CPT sponsorship at intern/early-career level.
# Sourced from #1867 Oracle eval + #1971 Wells Fargo eval (verbatim JD language)
# plus standard big-4-bank + ITAR-coded defense cohort.
VISA_BLOCK_COMPANIES = {
    "oracle",
    "wells fargo",
    "visa", "visa inc",  # verified 2026-05-01 per #1900-1905: "Will not sponsor"
    "earnin",  # verified 2026-05-01 per #1468/#1630: "unable to provide visa sponsorship"
    "sap",  # verified 2026-05-01 per #1897/#1909: SAP iXp policy "no visa sponsorship, requires US permanent work auth"
    "s&p global", "sp global", "s and p global",  # verified 2026-05-01 per #1804/#1805
    "preferred risk", "preferred risk insurance",  # verified 2026-05-01 per #1477: "must be able to work without sponsorship"
    "klaviyo",  # verified 2026-05-02 per #300: explicit no F-1/OPT/TN
    "veeva",  # verified 2026-05-02 per #1475: explicit no H-1B/OPT/TN
    "avride",  # verified 2026-05-02 per #1580/#1581: "not offering sponsorship"
    "realtor.com",  # verified 2026-05-02 per #1661: explicit no-sponsorship clause
    "bank of america",
    "jpmorgan", "jpmorgan chase", "jp morgan", "jp morgan chase",
    "citi", "citigroup", "citibank",
    "us bank", "u.s. bank", "u.s. bancorp",
    "pnc", "pnc financial",
    "truist",
    "northern trust",
    "morgan stanley",
    "goldman sachs",
    "raytheon", "rtx",
    "lockheed martin", "lockheed",
    "northrop grumman",
    "general dynamics", "general dynamics mission systems",
    "boeing",
    "leidos",
    "caci",
    "saic",
    "sandia",
    "lawrence livermore",
    "los alamos",
    "innovative defense technologies", "idt",
    "anduril",  # us-citizen requirement on most reqs
    "shield ai",
    "palantir",  # FDE roles often require US person
    "general motors gm financial", "gm financial",
    "fidelity",
    "vanguard",
    "schwab",
    "ally",
    "discover financial",
    "capital one",  # mixed; many reqs require US persons
    "navy federal", "navy federal credit union",
    "usaa",
    "fannie mae",
    "freddie mac",
    "federal reserve",
    "ssa", "social security administration",
    "irs",
    "veterans affairs",
    "department of",
    "deloitte", "ey", "kpmg", "pwc",  # consulting; visa varies; flag for manual
}

# Roles where Anmol's stack mismatch is hard (he has no native iOS/Android).
WEAK_STACK_KILL = re.compile(
    r"\b(ios|swift|objective-?c|android|kotlin)\b.*\b(intern|engineer)\b|"
    r"\b(intern|engineer)\b.*\b(ios|swift|objective-?c|android|kotlin)\b",
    re.IGNORECASE,
)

# JD locations Anmol cannot work at (no CPT outside US, no India H1B path).
NON_US_LOCATION_HINTS = re.compile(
    r"\b(beijing|shanghai|shenzhen|hong kong|singapore|tokyo|"
    r"london|berlin|paris|munich|barcelona|madrid|amsterdam|"
    r"dublin|edinburgh|zurich|vienna|prague|warsaw|cambridge|"
    r"united.kingdom|cambridgeshire|england|scotland|wales|"
    r"toronto|montreal|vancouver|ottawa|"
    r"sydney|melbourne|brisbane|auckland|"
    r"sao paulo|buenos aires|mexico city|"
    r"tel aviv|dubai|abu dhabi|riyadh|"
    r"bangalore|hyderabad|gurgaon|noida|mumbai|chennai|pune)\b",
    re.IGNORECASE,
)

# Oracle HCM hosts uniformly bar F-1 sponsorship (verified verbatim per #1867).
# Match the Oracle Cloud HCM SPA host pattern in the URL.
ORACLE_HCM_RE = re.compile(
    r"(eeho\.fa\.us2|ejta\.fa\.us6|hcwp\.fa\.us2|hcwc\.fa\.us2|fa\.\w+)"
    r"\.oraclecloud\.com",
    re.IGNORECASE,
)


def parse_row(line):
    """Return (cells, num) for table rows; None for non-rows."""
    if not line.startswith("|"):
        return None
    cells = [c.strip() for c in line.split("|")]
    if len(cells) < 10:
        return None
    try:
        num = int(cells[1])
    except (ValueError, IndexError):
        return None
    return cells, num


def extract_url(notes):
    m = re.search(r"https?://\S+", notes)
    return m.group(0).rstrip(".,;)") if m else None


def check_greenhouse_dead(url):
    """For boards-api.greenhouse.io URLs, return True if 404. Else None (unknown)."""
    # Try to convert a careers URL or job-boards.greenhouse.io URL into the API form
    # that returns 200/404 cleanly.
    m = re.search(r"job-boards\.greenhouse\.io/([^/]+)/jobs/(\d+)", url)
    if m:
        slug, jid = m.group(1), m.group(2)
        api = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{jid}"
    else:
        # Coinbase-style: coinbase.com/careers/positions/NNNNNN?gh_jid=NNNNNN
        m2 = re.search(r"gh_jid=(\d+)", url)
        if not m2:
            return None
        # Need a slug. Pull from common careers domains.
        slug_map = {
            "coinbase.com": "coinbase",
            "doordash.com": "doordashusa",
            "wing.com": "wing",
            "graco.wd501.myworkdayjobs.com": None,  # workday, skip
        }
        host_match = re.search(r"https?://([^/]+)/", url)
        if not host_match:
            return None
        host = host_match.group(1)
        slug = slug_map.get(host)
        if not slug:
            return None
        api = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{m2.group(1)}"

    try:
        req = urllib.request.Request(api, headers={"User-Agent": "career-ops-prefilter/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status >= 400
    except urllib.error.HTTPError as e:
        return e.code == 404
    except Exception:
        return None


def classify_row(cells):
    """Return (new_status, kill_reason) or (None, None) if survivor."""
    company = cells[3].lower().strip()
    role = cells[4]
    notes = cells[9]

    # Strip emoji prefixes from company
    company_clean = re.sub(r"^[^\w]+\s*", "", company)

    # 1. Visa-block company (substring match against canonical names)
    for blocked in VISA_BLOCK_COMPANIES:
        if blocked in company_clean:
            return "SKIP", f"visa-block company ({blocked})"

    # 2. Weak-stack kill (iOS / Android only when Anmol has no native mobile)
    if WEAK_STACK_KILL.search(role):
        return "SKIP", "stack mismatch (mobile native)"

    # 3. Non-US location hint in role title
    if NON_US_LOCATION_HINTS.search(role):
        return "SKIP", "non-US location in title"

    # 4. Non-US location hint in notes/URL (e.g., aggregator embedded location)
    if NON_US_LOCATION_HINTS.search(notes):
        return "SKIP", "non-US location in notes"

    # 5. Oracle HCM hosts (#1867 verbatim "no F-1/CPT/OPT" applies repo-wide)
    if ORACLE_HCM_RE.search(notes):
        return "SKIP", "Oracle HCM platform (no F-1 per #1867 verbatim)"

    return None, None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-network", action="store_true",
                    help="skip Greenhouse liveness checks (offline mode)")
    args = ap.parse_args(argv)

    text = APPS.read_text(encoding="utf-8")
    lines = text.split("\n")

    triaged_rows = []
    for i, line in enumerate(lines):
        parsed = parse_row(line)
        if not parsed:
            continue
        cells, num = parsed
        if cells[6] == "Triaged":
            triaged_rows.append((i, cells, num))

    print(f"# pre-filter run dry_run={args.dry_run} skip_network={args.skip_network}")
    print(f"  total Triaged rows: {len(triaged_rows)}")

    kills_by_reason = {}
    survivors = []
    deadlinks = []

    # Phase 1: cheap classification (no network)
    for i, cells, num in triaged_rows:
        new_status, reason = classify_row(cells)
        if new_status:
            kills_by_reason.setdefault(reason, []).append((i, cells, num, new_status))
        else:
            survivors.append((i, cells, num))

    print(f"\n# phase 1 (deterministic) kills: {sum(len(v) for v in kills_by_reason.values())}")
    for reason, hits in sorted(kills_by_reason.items(), key=lambda x: -len(x[1])):
        print(f"  {len(hits):>4} : {reason}")

    print(f"\n# survivors after phase 1: {len(survivors)}")

    # Phase 2: parallel Greenhouse liveness check on survivors
    if not args.skip_network:
        print(f"\n# phase 2 (Greenhouse liveness) checking {len(survivors)} survivors...")
        with ThreadPoolExecutor(max_workers=10) as ex:
            futures = {}
            for idx, (i, cells, num) in enumerate(survivors):
                url = extract_url(cells[9])
                if not url:
                    continue
                futures[ex.submit(check_greenhouse_dead, url)] = idx

            for fut in as_completed(futures):
                idx = futures[fut]
                try:
                    dead = fut.result()
                except Exception:
                    dead = None
                if dead is True:
                    deadlinks.append(idx)

        print(f"  dead URLs found: {len(deadlinks)}")

    # Build new line content
    new_lines = list(lines)
    applied = {"skip": 0, "discarded": 0}

    for reason, hits in kills_by_reason.items():
        for i, cells, num, new_status in hits:
            cells[6] = new_status
            cells[5] = "1.0/5"
            cells[9] = f"Pre-filter SKIP: {reason}. Original notes: {cells[9][:200]}"
            new_lines[i] = "|".join(cells)
            applied["skip"] += 1

    for idx in deadlinks:
        i, cells, num = survivors[idx]
        cells[6] = "Discarded"
        cells[5] = "0.0/5"
        cells[9] = f"Pre-filter Discarded: Greenhouse-direct 404. Original notes: {cells[9][:200]}"
        new_lines[i] = "|".join(cells)
        applied["discarded"] += 1

    final_survivors = [s for idx, s in enumerate(survivors) if idx not in set(deadlinks)]

    print(f"\n# total kills (will write): SKIP={applied['skip']}, Discarded={applied['discarded']}")
    print(f"# final survivors needing per-JD eval: {len(final_survivors)}")

    if args.dry_run:
        print("\n# preview of first 20 survivors:")
        for i, cells, num in final_survivors[:20]:
            print(f"  #{num:>4} {cells[5]:>5} {cells[3][:24]:<24} {cells[4][:60]}")
        return 0

    APPS.write_text("\n".join(new_lines), encoding="utf-8")
    print(f"\nrewrote {APPS}")

    # Write survivors to a manifest for the eval-dispatch step
    manifest = CO / "data" / f"prefilter-survivors-{__import__('datetime').date.today()}.tsv"
    with manifest.open("w", encoding="utf-8") as f:
        f.write("num\tcompany\trole\turl\n")
        for i, cells, num in final_survivors:
            url = extract_url(cells[9]) or ""
            f.write(f"{num}\t{cells[3]}\t{cells[4]}\t{url}\n")
    print(f"wrote survivor manifest: {manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
