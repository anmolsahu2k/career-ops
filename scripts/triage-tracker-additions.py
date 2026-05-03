#!/usr/bin/env python3
# requirements: stdlib only

"""
triage-tracker-additions.py

Deterministic, no-API scorer for the 9-col TSVs sitting in
career-ops/batch/tracker-additions/. Scores each row 0-5 against
Anmol's intern-search profile (target roles + priority companies).
Rows scoring >= threshold get rewritten with the new score; the
rest are moved to batch/tracker-additions-rejected/ so merge-tracker
only ingests the high-fit set.

Hard rules respected:
  - No em-dashes or en-dashes in any rewritten text.
  - Score format "X.X/5".
  - Status stays "Evaluated".

Usage:
  python3 scripts/triage-tracker-additions.py            # apply
  python3 scripts/triage-tracker-additions.py --dry-run  # preview only
  python3 scripts/triage-tracker-additions.py --threshold 3.0
"""

import argparse
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

SCRIPT = Path(__file__).resolve()
CO = SCRIPT.parent.parent
ADD_DIR = CO / "batch" / "tracker-additions"
REJ_DIR = CO / "batch" / "tracker-additions-rejected"

PRIORITY = {
    "anthropic", "openai", "cohere", "mistral", "langchain", "pinecone",
    "vercel", "temporal", "glean", "retool", "arize", "arize ai",
    "duolingo", "abridge", "skild ai", "skild", "aurora innovation", "aurora",
    "astrobotic",
}

EXTENDED_BIGTECH = {
    "stripe", "databricks", "notion", "figma", "airbnb", "uber", "lyft",
    "nvidia", "snowflake", "google", "meta", "amazon", "microsoft", "apple",
    "linkedin", "netflix", "tesla", "spacex", "datadog", "mongodb", "atlassian",
    "asana", "instacart", "doordash", "robinhood", "ramp", "plaid", "brex",
    "samsara", "scale ai", "scale", "perplexity", "character ai", "cognition",
    "cognition ai", "sierra", "harvey", "writer", "runway", "pika", "luma",
    "anyscale", "modal", "weights and biases", "weights & biases",
    "huggingface", "hugging face", "groq", "cerebras", "sambanova", "lambda",
    "lambda labs", "cresta", "discord", "reddit", "pinterest", "twitch",
    "block inc", "coinbase", "rippling", "gusto", "checkr",
    "palantir", "two sigma", "jane street", "citadel", "jump trading",
    "hudson river trading", "drw", "jp morgan", "jpmorgan", "goldman sachs",
    "capital one", "morgan stanley", "wellington", "bridgewater",
    "bloomberg", "hubspot", "shopify", "twilio", "okta", "cloudflare",
    "fastly", "vercel", "netlify", "elastic", "splunk", "newrelic",
    "salesforce", "oracle", "ibm", "intel", "amd", "qualcomm",
    "tiktok", "bytedance", "yelp", "zillow", "redfin", "expedia", "booking",
    "intuit", "paypal", "ebay", "walmart", "target", "wayfair", "etsy",
    "applied intuition", "wayve", "waymo", "cruise", "zoox", "nuro",
    "boston dynamics", "anduril", "shield ai", "saronic", "epirus",
    "sourcegraph", "supabase", "neon", "planetscale",
}

STRONG_ROLE_TOKENS = [
    r"\bsoftware engineer", r"\bswe\b", r"\bsde\b",
    r"\bsoftware engineering\b", r"\bsoftware development\b", r"\bsoftware dev\b",
    r"\bmachine learning\b", r"\bml engineer\b", r"\bml infrastructure\b",
    r"\bmle\b", r"\bapplied scientist\b", r"\bapplied ml\b", r"\bai engineer\b",
    r"\bai/ml\b", r"\bai\s*&\s*ml\b", r"\bresearch engineer\b",
    r"\bdata engineer\b", r"\bdata scientist\b", r"\bdata analyst\b",
    r"\bbackend\b", r"\bback-end\b", r"\bback end\b",
    r"\bfull[\s-]?stack\b", r"\bfullstack\b",
    r"\binfrastructure engineer\b", r"\bplatform engineer\b",
    r"\bsre\b", r"\bdevops\b",
    r"\bcomputer science\b", r"\bcomputer scientist\b",
]
STRONG_ROLE_RE = re.compile("|".join(STRONG_ROLE_TOKENS), re.IGNORECASE)

NON_TARGET_TOKENS = [
    r"\bsales\b", r"\baccount executive\b", r"\bsdr\b", r"\bbdr\b",
    r"\bmarketing\b", r"\bbrand\b", r"\bcreative\b", r"\bcontent\b",
    r"\bdesigner?\b", r"\bui/ux\b", r"\bux\b", r"\bgraphic\b",
    r"\bproduct manager\b", r"\bpm\b", r"\bproject manager\b",
    r"\brecruit", r"\bhr\b", r"\bhuman resources\b", r"\bpeople\b",
    r"\bcommunications\b", r"\bpublic relations\b", r"\bpr\b",
    r"\bcustomer success\b", r"\bcustomer support\b",
    r"\bbusiness development\b", r"\bpartnerships\b",
    r"\bfinance\b", r"\baccountant\b", r"\baccounting\b",
    r"\blegal\b", r"\bcounsel\b", r"\bparalegal\b",
    r"\boperations\b", r"\bops\b",
    r"\bmba\b", r"\bsupply chain\b", r"\blogistics\b",
    r"\bmechanical\b", r"\belectrical engineer\b", r"\bcivil\b", r"\bchemical\b",
    r"\bbiology\b", r"\bbiomed", r"\bclinical\b",
]
NON_TARGET_RE = re.compile("|".join(NON_TARGET_TOKENS), re.IGNORECASE)

SENIOR_TOKENS = re.compile(
    r"\b(senior|staff|lead|principal|director|head of|vice president|"
    r"\bvp\b|chief|distinguished)\b", re.IGNORECASE
)

SUMMER26_RE = re.compile(r"summer\s*['’]?\s*2?6|summer\s*2026", re.IGNORECASE)
INTERN_RE = re.compile(r"\bintern\b|\binternship\b", re.IGNORECASE)
RESEARCH_SCI_RE = re.compile(r"research scientist", re.IGNORECASE)
PHD_ONLY_RE = re.compile(r"\bphd\b|\(ph\.?d\.?\)|doctoral|ph\.d\.", re.IGNORECASE)


def score_row(role: str, company: str, notes: str) -> tuple[float, str]:
    """Return (score, reason). Score is 0.0-5.0."""
    score = 0.0
    reasons = []

    if NON_TARGET_RE.search(role):
        return 0.0, "non-target field"

    if SENIOR_TOKENS.search(role):
        return 0.0, "senior/lead level"

    if RESEARCH_SCI_RE.search(role) and not INTERN_RE.search(role):
        return 0.0, "research scientist (PhD-coded)"

    if PHD_ONLY_RE.search(role):
        return 0.0, "PhD-only intern"

    if INTERN_RE.search(role):
        score += 1.0
        reasons.append("intern+1.0")

    if SUMMER26_RE.search(role) or SUMMER26_RE.search(notes):
        score += 1.5
        reasons.append("summer2026+1.5")

    if STRONG_ROLE_RE.search(role):
        score += 1.5
        reasons.append("target-role+1.5")

    company_lc = re.sub(r"[^\w\s&]", " ", company.lower()).strip()
    company_tokens = set(re.findall(r"[\w&]+", company_lc))
    if company_lc in PRIORITY:
        score += 1.0
        reasons.append("priority+1.0")
    elif company_lc in EXTENDED_BIGTECH:
        score += 0.5
        reasons.append("bigtech+0.5")
    else:
        matched = False
        for k in PRIORITY:
            if k == company_lc or k in company_tokens or (
                " " in k and k in company_lc
            ):
                score += 1.0
                reasons.append(f"priority~{k}+1.0")
                matched = True
                break
        if not matched:
            for k in EXTENDED_BIGTECH:
                if k == company_lc or k in company_tokens or (
                    " " in k and k in company_lc
                ):
                    score += 0.5
                    reasons.append(f"bigtech~{k}+0.5")
                    break

    score = min(score, 5.0)
    return score, ",".join(reasons) if reasons else "no-signal"


def parse_tsv(path: Path):
    raw = path.read_text(encoding="utf-8").rstrip("\n")
    fields = raw.split("\t")
    if len(fields) < 9:
        return None
    return fields


def write_tsv(path: Path, fields):
    path.write_text("\t".join(fields) + "\n", encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=3.5)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if not ADD_DIR.exists():
        print(f"no tracker-additions dir at {ADD_DIR}", file=sys.stderr)
        return 1

    REJ_DIR.mkdir(parents=True, exist_ok=True)

    files = sorted(ADD_DIR.glob("*.tsv"))
    print(f"# triage run threshold={args.threshold} dry_run={args.dry_run}")
    print(f"  scanning {len(files)} TSVs in {ADD_DIR}")

    hist = Counter()
    keep = []
    reject = []
    bad = []

    for f in files:
        fields = parse_tsv(f)
        if fields is None:
            bad.append(f)
            continue
        company = fields[2]
        role = fields[3]
        notes = fields[8]
        score, reason = score_row(role, company, notes)
        bucket = round(score * 2) / 2
        hist[bucket] += 1
        if score >= args.threshold:
            new_fields = list(fields)
            new_fields[5] = f"{score:.1f}/5"
            keep.append((f, new_fields, reason))
        else:
            reject.append((f, score, reason))

    print(f"\n# score histogram (rounded to 0.5)")
    for k in sorted(hist):
        print(f"  {k:>3.1f} : {hist[k]}")

    print(f"\n# kept (>= {args.threshold}): {len(keep)}")
    print(f"# rejected (< {args.threshold}): {len(reject)}")
    print(f"# unparseable: {len(bad)}")

    if args.dry_run:
        print("\n# top 25 keep preview")
        for f, fields, reason in keep[:25]:
            print(f"  {fields[5]:>5}  {fields[2][:24]:<24}  {fields[3][:60]:<60}  [{reason}]")
        print("\n# bottom 10 reject preview")
        for f, score, reason in reject[:10]:
            print(f"  {score:>4.1f}  {reason}  -> {f.name}")
        return 0

    for f, fields, reason in keep:
        write_tsv(f, fields)

    moved = 0
    for f, score, reason in reject:
        target = REJ_DIR / f.name
        shutil.move(str(f), str(target))
        moved += 1

    print(f"\nrewrote {len(keep)} kept TSVs with new scores")
    print(f"moved {moved} rejected TSVs to {REJ_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
