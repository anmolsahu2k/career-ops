#!/usr/bin/env python3
"""discovery_filters.py - shared filter chain for all discovery sources.

Every discovery source (aggregator-intake.py, jobspy-ingest.py, future
handshake-ingest.py, future scan.py wrappers, manual paste handlers) MUST
route raw rows through `apply_unified_filter()` before writing TSVs into
`batch/tracker-additions/`. This guarantees that liveness gating, eval
dispatch, and tracker merge see consistent inputs regardless of source.

The canonical pipeline (per CLAUDE.md and modes/scan.md) is:
  raw rows
    -> title allow + deny
    -> season filter (drop Fall 2026, Spring/Summer 2027+)
    -> brand deny (Chinese-parent F-1 friction, defense, PhD-only divisions)
    -> phd-only title filter (drop "PhD" / "Doctoral" titles)
    -> geo filter (US, remote-US, or remote-anywhere)
    -> age filter (<=21d posted; sources without age metadata are kept)
    -> within-run URL dedup
    -> tracker URL dedup (applications.md + reports/ + active batch dir)
    -> tracker fingerprint dedup (company_norm + role_tokens)
  -> emit TSV with dynamic NN allocation
  -> hand off to liveness gate, then eval dispatch

Module is stdlib-only so it can be imported from any context without pip.
"""

import datetime as _dt
import re
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CAREER_OPS = SCRIPT_DIR.parent
APPS_FILE = CAREER_OPS / "data" / "applications.md"
REPORTS_DIR = CAREER_OPS / "reports"
BATCH_DIR = CAREER_OPS / "batch" / "tracker-additions"

MAX_AGE_DAYS_DEFAULT = 21

# ── Title filter ─────────────────────────────────────────────────────────

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
    "program manager", "project manager", "gtm", "go-to-market",
    "industrial engineer", "process engineer", "mechanical engineer",
    "electrical engineer", "civil engineer", "chemical engineer",
    "metallurgical", "manufacturing engineer", "supply chain",
]

# ── Geo filter ───────────────────────────────────────────────────────────

US_STATE_CODES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
    "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
    "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
    "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
    "WI", "WY", "DC",
}

# State full-names (lowercased). Required because Adzuna and LinkedIn often
# return state-only display_names like "California" / "Texas" / "Georgia"
# without a city, which the US_STATE_CODES regex misses (it requires a
# leading comma or space). Confirmed 2026-05-10 to be the cause of Adzuna's
# 255/500 non_us false-drop rate. "New York" and "Washington" are in
# US_CITY_HINTS already; included here too for completeness.
US_STATE_NAMES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
    "maine", "maryland", "massachusetts", "michigan", "minnesota",
    "mississippi", "missouri", "montana", "nebraska", "nevada",
    "new hampshire", "new jersey", "new mexico", "new york", "north carolina",
    "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
    "rhode island", "south carolina", "south dakota", "tennessee", "texas",
    "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin",
    "wyoming", "district of columbia",
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

# ── Season filter ────────────────────────────────────────────────────────

SEASON_DENY_RE = re.compile(
    r"\b(?:fall\s*20(?:2[6-9]|3\d)|winter\s*20(?:2[6-9]|3\d)|"
    r"spring\s*20(?:2[7-9]|3\d)|summer\s*20(?:2[7-9]|3\d)|"
    r"20(?:2[7-9]|3\d)\s*(?:summer|fall|winter|spring)|"
    r"co[\s\-]?op\s*20(?:2[7-9]|3\d))\b",
    re.IGNORECASE,
)

# ── Brand + PhD-only filters ─────────────────────────────────────────────
#
# Codified 2026-05-08 after a tracker audit found 13+ TikTok/ByteDance/XPENG
# placeholders that passed stage-1 but were a stage-2 drop in the skill memory
# (feedback_scan_all_sources.md). Lifting these into stage-1 means every
# Python source picks them up automatically — the architecture rule from
# docs/ARCHITECTURE.md ("adding a deny token propagates to every source").
#
# BRAND_DENY tokens are matched against the company string (case-insensitive,
# substring). Markdown link wrappers like "[TikTok](https://...)" are stripped
# before matching.

BRAND_DENY_TOKENS = (
    # Chinese-parent companies — F-1 friction history (per memory + 2024-25 incidents)
    r"tiktok", r"byte\s*dance", r"xpeng", r"futurewei", r"united imaging",
    # Defense / clearance contractors — most reqs gate on US citizenship
    r"leidos", r"raytheon", r"lockheed martin", r"northrop grumman",
    r"booz allen", r"saic", r"general dynamics", r"l3harris", r"mitre",
    r"anduril", r"dev technology group", r"covar applied",
    # 2026-05-10: removed `microsoft research` after #3447 MS Research Post-Training
    # Intern surfaced at 4.0/5 (only escaped the filter because aggregator labeled
    # the company "RemoteHunter"). MSR has Master's-eligible non-PhD intern reqs;
    # rely on title-PhD filter + agent-level review to screen the PhD-only ones.
)

# Word-boundary regex so "saic" doesn't match "Mosaic", "mitre" doesn't match
# "perimeter", etc. Each token may itself be a regex (e.g. byte\s*dance).
_BRAND_DENY_RE = re.compile(
    r"(?:^|[^a-z0-9])(?:" + "|".join(BRAND_DENY_TOKENS) + r")(?:[^a-z0-9]|$)",
    re.IGNORECASE,
)

PHD_ONLY_TITLE_RE = re.compile(
    r"\b(phd|ph\.?d|doctoral|doctorate)\b",
    re.IGNORECASE,
)

_BRAND_LINK_STRIP_RE = re.compile(r"\[([^\]]+)\][^\s]*")


def is_brand_denied(company):
    """True if company string matches a deny token (word-boundary regex).
    Strips markdown link wrappers like '[TikTok](https://...)' first."""
    if not company:
        return False
    c = _BRAND_LINK_STRIP_RE.sub(r"\1", str(company))
    return bool(_BRAND_DENY_RE.search(c))


def is_phd_only_title(title):
    """True if title contains a PhD-only marker."""
    return bool(PHD_ONLY_TITLE_RE.search(title or ""))

# ── Age parsing ──────────────────────────────────────────────────────────

AGE_TOKEN_RE = re.compile(r"\b(\d+)\s*(h|d|w|mo|m|y)\b", re.IGNORECASE)
MONTH_NAMES = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

# ── Misc ─────────────────────────────────────────────────────────────────

URL_RE = re.compile(r"https?://[^\s)\]]+")
EM_DASH_RE = re.compile("[" + chr(0x2013) + chr(0x2014) + "]")


# ─────────────────────────────────────────────────────────────────────────
# Pure helpers
# ─────────────────────────────────────────────────────────────────────────

def clean_text(s):
    if s is None:
        return ""
    s = EM_DASH_RE.sub(",", str(s))
    s = re.sub(r"\s+", " ", s).strip()
    return s


def slugify(name):
    s = (name or "").lower()
    s = EM_DASH_RE.sub("-", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:60] or "company"


_APPLY_SUFFIX_RE = re.compile(r"/(apply|application)/?$")
_WORKDAY_FINGERPRINT_RE = re.compile(
    r"^(?P<tenant>[^/]+\.wd\d+\.myworkdayjobs\.com)/.*_(?P<jobid>[a-z0-9][a-z0-9-]{3,})$"
)


def normalize_url(url):
    """Lowercase, drop scheme, drop www., drop query/fragment, drop trailing /,
    drop trailing `/apply` or `/application` path suffix.

    The apply-form suffix is dropped because some sources (Simplify, vanshb03)
    construct URLs with it appended while others (Hiring Cafe, direct ATS
    boards) return the bare canonical URL. Both refer to the same job
    posting, so they should dedup. Tested on 2026-05-04 by the #1556/#2081
    Socure duplicate that slipped through three dedup layers.

    For Workday URLs (`{tenant}.wd{N}.myworkdayjobs.com/...`), collapses to
    `{tenant}/_{jobid}` so locale prefix (`/en-US/`), site segment, location-
    encoded path, and aggregator-injected query params don't produce false
    negatives. The 2026-05-10 #3534 (Philips, `utm_source=Simplify` redirect)
    vs #3524 (direct Workday URL with `/en-US/` locale) duplicate triggered
    this fix; both URLs share Workday req `582261` but slipped past the
    URL-fingerprint dedup because the path segments differed.
    """
    if not url:
        return ""
    u = url.strip().lower()
    u = u.split("?", 1)[0].split("#", 1)[0]
    u = u.rstrip("/")
    u = re.sub(r"^https?://(www\.)?", "", u)
    u = _APPLY_SUFFIX_RE.sub("", u)
    m = _WORKDAY_FINGERPRINT_RE.match(u)
    if m:
        return f"{m.group('tenant')}/_{m.group('jobid')}"
    return u


def parse_age(text):
    """Parse '5d', '1mo', '3w', '12h' to integer days. None if unparseable."""
    if not text:
        return None
    m = AGE_TOKEN_RE.search(text)
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2).lower()
    if unit == "h":
        days = 0
    elif unit == "d":
        days = n
    elif unit == "w":
        days = n * 7
    elif unit in ("mo", "m"):
        days = n * 30
    elif unit == "y":
        days = n * 365
    else:
        return None
    if days > 730:
        return None
    return days


def parse_date_posted(text, today=None):
    """Parse 'Apr 28' to integer days since posting (year inferred)."""
    if not text:
        return None
    if today is None:
        today = _dt.date.today()
    m = re.match(r"\s*([A-Za-z]+)\s+(\d{1,2})\b", text.strip())
    if not m:
        return None
    mon_token = m.group(1).lower()[:4].rstrip(".")
    day = int(m.group(2))
    mon = MONTH_NAMES.get(mon_token) or MONTH_NAMES.get(mon_token[:3])
    if not mon:
        return None
    year = today.year
    try:
        posted = _dt.date(year, mon, day)
    except ValueError:
        return None
    if posted > today:
        try:
            posted = _dt.date(year - 1, mon, day)
        except ValueError:
            return None
    delta = (today - posted).days
    if delta < 0 or delta > 730:
        return None
    return delta


def role_in_season(role):
    """True if role title does NOT contain an off-season marker."""
    return SEASON_DENY_RE.search(role or "") is None


_INTERN_TOKEN_RE = re.compile(
    r"\b(intern(?:s|ship|ships)?|co-?op|apprentice(?:ship)?|trainee|"
    r"summer\s*20\d{2}|summer\s*(?:analyst|associate)|university\s*hire|"
    r"university\s*recruit)\b",
    re.IGNORECASE,
)


def is_internship(role, type_cell=""):
    return bool(_INTERN_TOKEN_RE.search(role or "") or _INTERN_TOKEN_RE.search(type_cell or ""))


def role_matches_targets(role):
    rl = " " + (role or "").lower() + " "
    # 2026-05-10 fix: was `if "intern" not in rl: return False` (rejects Co-op/
    # Apprentice/Trainee/Summer Analyst variants used by quant funds, Apple
    # Co-op, consulting summer-associate programs). Now matches the
    # portals.yml `must_match` regex contract.
    if not _INTERN_TOKEN_RE.search(role or ""):
        return False
    if not any(tok in rl for tok in TARGET_ROLE_TOKENS):
        return False
    if any(tok in rl for tok in ROLE_DENY_TOKENS):
        return False
    return True


def location_is_us_or_remote(location, is_remote=False):
    """Pass if explicitly remote, or location matches US state/city/USA hint."""
    if is_remote:
        return True
    if not location:
        return False
    loc = location.lower()
    if any(h in loc for h in US_CITY_HINTS):
        return True
    if any(h in loc for h in REMOTE_HINTS):
        return True
    if " usa" in loc or "united states" in loc or loc.endswith(", us"):
        return True
    for code in US_STATE_CODES:
        if re.search(r"[,\s]" + code + r"\b", location):
            return True
    # State full-name fallback: "California", "Texas", "Georgia", etc.
    # Match on word-boundary so "Washingtonville, NY" doesn't match "washington".
    for name in US_STATE_NAMES:
        if re.search(r"\b" + re.escape(name) + r"\b", loc):
            return True
    return False


def _normalize_company(name):
    # Collapse markdown link wrapping `[display](url)` to just `display` first.
    # Without this, a row with `[Sulzer](http://www.sulzer.com)` fingerprints
    # to `sulzerhttpwwwsulzercom` while a clean `Sulzer` row fingerprints to
    # `sulzer`, causing dedup to miss obvious duplicates across sources that
    # disagree on whether to wrap the company in a markdown link (jobright-ai
    # aggregator does, scan.mjs / Workday API does not).
    s = _BRAND_LINK_STRIP_RE.sub(r"\1", name or "")
    # Strip common corporate suffixes from the END only — so "SCAN Health Plan"
    # collapses to "SCAN", "Cambium Learning Group" to "Cambium Learning",
    # "Stride, Inc." to "Stride". End-of-string anchor + iterated to handle
    # "Realty Income Corporation, Inc." style stacked suffixes. Suffix list is
    # conservative on purpose: tokens like "AI" / "Tech" / "Health" are NOT in
    # the list because they're often part of the brand name itself.
    while True:
        new_s = _COMPANY_SUFFIX_RE.sub("", s)
        if new_s == s:
            break
        s = new_s.strip()
    return re.sub(r"[^a-z0-9]+", "", s.lower())


_COMPANY_SUFFIX_RE = re.compile(
    r"\s*[,.]?\s*\b("
    r"inc|incorporated|llc|ltd|limited|corp|corporation|company|"
    r"group|holdings|enterprises|labs|laboratories|"
    r"technologies|systems|services|partners|"
    r"health plan|holding"
    r")\b\s*\.?\s*$",
    re.IGNORECASE,
)


def _normalize_role(role):
    """Token-bag fingerprint that ignores cohort/season/level/filler noise.

    2026-05-10 fix: stopped stripping engineer/engineering/software/swe/sde/
    developer/dev (was erasing discipline distinction at companies with
    multiple intern reqs — Microsoft SDE Intern + ML Engineer Intern + AI
    Frontiers all collapsed to empty fingerprint, causing 2-of-3 to drop as
    fp_dup_tracker). Also lowered min token length 3->2 so `ml` and `ai`
    survive as distinguishing tokens, since those are the most common
    short-form discriminators between intern reqs.
    """
    # Collapse markdown link wrapping `[display](url)` to just `display` first.
    # Same reasoning as _normalize_company: a row with a markdown-linked role
    # otherwise carries URL fragments into the fingerprint and disagrees with
    # the same role posted unwrapped.
    r = _BRAND_LINK_STRIP_RE.sub(r"\1", role or "").lower()
    r = SEASON_DENY_RE.sub(" ", r)
    r = re.sub(
        r"\b(summer|spring|fall|winter|20\d\d|bs|ms|phd|undergrad|grad|"
        r"intern(ship)?|start|cohort|new\s*grad|early\s*career|"
        r"u\.?s\.?|usa|remote|hybrid|onsite)\b",
        " ",
        r,
    )
    r = re.sub(r"[^a-z0-9]+", " ", r)
    return " ".join(sorted(set(t for t in r.split() if len(t) >= 2)))


# ─────────────────────────────────────────────────────────────────────────
# Tracker dedup signatures + NN allocation
# ─────────────────────────────────────────────────────────────────────────

def collect_existing_signatures():
    """Returns (urls_set, fingerprints_set) from applications.md +
    reports/*.md `**URL:**` headers + active batch TSVs.

    Fingerprint = (company_norm, role_tokens) catches the same role posted
    on a different surface (e.g. LinkedIn vs Greenhouse) where URL dedup
    would miss it.
    """
    urls = set()
    fps = set()

    def _ingest_text(text):
        for m in URL_RE.finditer(text):
            urls.add(normalize_url(m.group(0)))

    if APPS_FILE.exists():
        try:
            text = APPS_FILE.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        _ingest_text(text)
        for line in text.splitlines():
            if not line.startswith("|"):
                continue
            parts = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(parts) < 4:
                continue
            try:
                int(parts[0])
            except ValueError:
                continue
            company, role = parts[2], parts[3]
            fp = (_normalize_company(company), _normalize_role(role))
            if fp[0] and fp[1]:
                fps.add(fp)

    if REPORTS_DIR.exists():
        for path in REPORTS_DIR.rglob("*.md"):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            _ingest_text(text)

    if BATCH_DIR.exists():
        for path in BATCH_DIR.glob("*.tsv"):
            try:
                line = path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
            except (OSError, IndexError):
                continue
            parts = line.split("\t")
            if len(parts) < 4:
                continue
            company, role = parts[2], parts[3]
            fp = (_normalize_company(company), _normalize_role(role))
            if fp[0] and fp[1]:
                fps.add(fp)
            for m in URL_RE.finditer(line):
                urls.add(normalize_url(m.group(0)))

    urls.discard("")
    return urls, fps


def next_available_nn():
    """max(applications.md NN, live BATCH_DIR NN, 99) + 1.

    Ignores `BATCH_DIR/merged/` - those NNs were already absorbed into (or
    rejected from) applications.md. Only un-merged TSVs constrain new NNs.
    """
    max_nn = 99
    if APPS_FILE.exists():
        try:
            for line in APPS_FILE.read_text(encoding="utf-8").splitlines():
                m = re.match(r"\|\s*(\d+)\s*\|", line)
                if m:
                    n = int(m.group(1))
                    if n > max_nn:
                        max_nn = n
        except OSError:
            pass
    if BATCH_DIR.exists():
        for f in BATCH_DIR.glob("*.tsv"):
            try:
                n = int(f.name.split("-", 1)[0])
                if n > max_nn:
                    max_nn = n
            except (ValueError, IndexError):
                continue
    return max_nn + 1


# ─────────────────────────────────────────────────────────────────────────
# Unified filter chain
# ─────────────────────────────────────────────────────────────────────────

def apply_unified_filter(
    rows,
    source_tag,
    max_age_days=MAX_AGE_DAYS_DEFAULT,
    existing_urls=None,
    existing_fps=None,
):
    """Run the canonical filter chain on a list of normalized rows.

    Each row is a dict with at least: title, company, url. Optional fields:
    location (str), is_remote (bool), age_days (int or None).

    Returns (kept_rows, drop_counter_dict).

    Sources without age metadata pass the age filter (None means "unknown,
    keep"). Within-run URL dedup is computed inside this function. Tracker
    dedup uses the provided sets; pass empty sets to skip tracker dedup.
    """
    if existing_urls is None:
        existing_urls = set()
    if existing_fps is None:
        existing_fps = set()

    drops = {
        "missing_field": 0,
        "off_target": 0,
        "off_season": 0,
        "brand_deny": 0,
        "phd_only": 0,
        "non_us": 0,
        "too_old": 0,
        "url_dup_run": 0,
        "url_dup_tracker": 0,
        "fp_dup_tracker": 0,
    }
    kept = []
    seen_urls = set()

    for r in rows:
        title = clean_text(r.get("title") or r.get("role") or "")
        company = clean_text(r.get("company") or "")
        url = clean_text(r.get("url") or r.get("job_url") or "")
        location = clean_text(r.get("location") or "")
        is_remote = bool(r.get("is_remote") or False)
        age_days = r.get("age_days")

        if not title or not company or not url:
            drops["missing_field"] += 1
            continue
        if not role_matches_targets(title):
            drops["off_target"] += 1
            continue
        if not role_in_season(title):
            drops["off_season"] += 1
            continue
        if is_brand_denied(company):
            drops["brand_deny"] += 1
            continue
        if is_phd_only_title(title):
            drops["phd_only"] += 1
            continue
        if not location_is_us_or_remote(location, is_remote):
            drops["non_us"] += 1
            continue
        if age_days is not None and age_days > max_age_days:
            drops["too_old"] += 1
            continue

        url_norm = normalize_url(url)
        if url_norm in seen_urls:
            drops["url_dup_run"] += 1
            continue
        if url_norm in existing_urls:
            drops["url_dup_tracker"] += 1
            continue

        fp = (_normalize_company(company), _normalize_role(title))
        if fp in existing_fps:
            drops["fp_dup_tracker"] += 1
            continue

        seen_urls.add(url_norm)
        existing_urls.add(url_norm)
        existing_fps.add(fp)
        r["_source_tag"] = source_tag
        r["_url_norm"] = url_norm
        r["_age_days"] = age_days
        kept.append(r)

    return kept, drops


# ─────────────────────────────────────────────────────────────────────────
# Placeholder TSV writer
# ─────────────────────────────────────────────────────────────────────────

def emit_tsv(num, date, company, role, url, source, age_days=None, suffix="aggregator", sponsorship=None, extras=None, dry_run=False):
    """Write a single placeholder TSV in the canonical 9-col format.

    The Notes column embeds `URL: <url>` so liveness/dedup tooling can
    re-extract it without parsing the report file. `suffix` controls the
    filename suffix - aggregator-intake.py uses "aggregator", jobspy uses
    "jobspy", handshake uses "handshake", hiringcafe uses "hiringcafe", etc.

    `sponsorship` is a tri-state visa-sponsorship hint from the source
    (True/False/None for unknown) - sources that expose it (Hiring Cafe,
    Adzuna sometimes) should pass it so downstream eval agents can pre-weight
    the F-1 viability dimension and skip obvious citizen-only roles.

    `extras` is a dict of source-specific notes to append to Notes (e.g.
    comp band, work-mode tag, security-clearance flag).
    """
    slug = slugify(company)
    path = BATCH_DIR / f"{num:03d}-{slug}-{suffix}.tsv"

    age_blurb = ""
    if age_days is not None:
        age_blurb = f"Posted {age_days}d ago. "

    sponsor_blurb = ""
    if sponsorship is True:
        sponsor_blurb = "VISA-SPONSORSHIP: yes. "
    elif sponsorship is False:
        sponsor_blurb = "VISA-SPONSORSHIP: no (per source). "
    # sponsorship=None -> no blurb (unknown)

    extras_blurb = ""
    if extras:
        parts = [f"{k}: {v}" for k, v in extras.items() if v not in (None, "")]
        if parts:
            extras_blurb = "; ".join(parts) + ". "

    notes = (
        f"Discovery via {source}. {age_blurb}{sponsor_blurb}{extras_blurb}URL: {url}. "
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
