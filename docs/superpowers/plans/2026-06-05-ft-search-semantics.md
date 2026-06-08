# FT Search-Semantics Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-aim the discovery + evaluation engine from a Summer-2026 internship search to a US-based full-time / new-grad search (start ~Jan 2027) for an F-1 candidate on OPT who needs eventual H-1B sponsorship, swap the GitHub aggregator feeds to new-grad/H-1B repos (capturing their per-row sponsorship emoji), add H1BGrader sponsorship-history enrichment, and pivot all role/visa framing in config + docs.

**Architecture:** Builds on Plan 1 (the `ft/` subtree + `CAREER_OPS_DATA_DIR` resolver are already in place; all engine scripts already write to `ft/`). This plan changes *what the engine surfaces and how it frames the candidate* — the filter gate, the aggregator sources + parser, a new H1BGrader lookup, the eval-stage sponsorship lens, and the config/docs. No path/infra changes.

**Tech Stack:** Python 3 (discovery_filters, aggregator, H1BGrader lookup), YAML (portals/profile), Markdown (modes/docs). Reuses the existing FlareSolverr-on-localhost:8191 pattern.

**Prereqs:** Plan 1 landed (branch `ft-pivot-infra`). FlareSolverr Docker reachable at `http://localhost:8191/v1` (same as the Hiring Cafe flow) for the H1BGrader task; if down, that task degrades to "unknown" signals, not a hard failure.

**Decisions locked with user:** roles = same families at FT level **+ Forward-Deployed/Solutions Engineer**; sponsorship = **flag + deprioritize** (never hard-drop); geography = **US-only, sponsorship-required**; sources = the new-grad/H-1B repo set **+ H1BGrader enrichment in core**; candidate-facing content stays **silent on visa** (answer only when asked; default line "Available January 2027").

**Commit policy:** optional checkpoints only, with explicit user approval. Never `git push`.

---

## Background facts (from the deep-research catalog, fact-checked 2026-06-05)

New-grad repos and their schemas (all actively maintained, daily/hourly):
- **SimplifyJobs/New-Grad-Positions** (branch `dev`) — FT new-grad SWE/DS/AI-ML/Quant/HW/PM, US. Cols: Company \| Role \| Location \| Application \| Age. Sponsorship: `🛂`=no-sponsorship, `🇺🇸`=citizen-required, `🔒`=closed (inline in cells).
- **vanshb03/New-Grad-2027** (`main`) — FT new-grad SWE/Quant/PM, US/Canada/Remote. Same emoji legend.
- **vanshb03/New-Grad-2026** (`main`) — FT new-grad SWE/Quant core. Same emoji.
- **speedyapply/2026-SWE-College-Jobs** — file `NEW_GRAD_USA.md` (FT, US-only). Cols: Company \| Position \| Location \| Salary \| Posting \| Age.
- **speedyapply/2026-AI-College-Jobs** — file `NEW_GRAD_USA.md` (AI/ML+DS new-grad US). Same cols.
- **jobright-ai/2026-Software-Engineer-New-Grad** (`master`) — new-grad SWE, hourly, last-7-days only, some CA/UK rows, `↳` continuation rows, NO sponsorship col.
- **jobright-ai/Daily-H1B-Jobs-In-Tech** (`master`) — US, H-1B-filtered. Cols: Company \| Job Title \| Level \| Location \| **H1B status** \| Link \| Date. `🏅`=explicit sponsor, `🥈`=history. CAVEAT: may be ~1mo stale; verify Date at ingest.

Emoji codepoints: `🛂` = U+1F6C2; `🇺🇸` = U+1F1FA U+1F1F8; `🏅` = U+1F3C5; `🥈` = U+1F948.

H1BGrader: per-company pages at `https://h1bgrader.com/h1b-sponsors/{slug}` (Cloudflare-gated → FlareSolverr); pages carry LCA counts, approve/deny, median salary, "H1B Dependent?" flag. Slug suffix is an opaque id, so company→slug needs a search step. USCIS H-1B Employer Data Hub bulk CSV is the no-auth authoritative alternative (batch).

---

## File Structure

**Modified:** `scripts/discovery_filters.py` (gate + geo + sponsorship helper), `scripts/aggregator-intake.py` (SOURCES + filter loop + emoji→sponsorship in harvest + write_tsv), the seven other ingest scripts (`jobspy-ingest.py`, `adzuna-ingest.py`, `hiringcafe-ingest.py`, `hn-hiring-ingest.py`, `yc-ingest.py`, `levels-ingest.py`, `startupjobs-ingest.py`), `config/profile.yml`, `portals.yml`, `modes/_profile.md`, `CLAUDE.md`, `INDEX.md`
**Created:** `scripts/h1bgrader_lookup.py` (+ `scripts/test_h1bgrader_lookup.py`)
**Touched (doc maintenance):** `STATUS.md` (flip #3 done), `CHANGELOG.md`

---

## Task 1: FT gate rewrite in `discovery_filters.py`

**Files:** Modify `scripts/discovery_filters.py` — `role_matches_targets` (313-325), `TARGET_ROLE_TOKENS` (41-50), `role_in_season` (296-298), `location_is_us_or_remote` (328-349)
**Test:** add `scripts/test_ft_filters.py`

The intern search required an intern token and passed any "remote". FT needs: no intern requirement, FDE in scope, no season-deny, and US-only remote (not global remote).

- [ ] **Step 1: Write the failing test** `scripts/test_ft_filters.py`:
```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import discovery_filters as df


def test_newgrad_titles_pass_without_intern_token():
    for t in ["New Grad Software Engineer", "Software Engineer, University Graduate 2026",
              "Associate Data Scientist", "Forward Deployed Engineer", "Solutions Engineer (New Grad)",
              "Member of Technical Staff"]:
        assert df.role_matches_targets(t), f"should be on-target: {t}"


def test_senior_titles_still_denied():
    for t in ["Senior Software Engineer", "Staff Machine Learning Engineer",
              "Principal Engineer", "Engineering Manager", "Product Manager"]:
        assert not df.role_matches_targets(t), f"should be denied: {t}"


def test_season_gate_neutral_for_ft():
    # FT roles routinely contain a year; the old intern season-deny must not kill them.
    for t in ["New Grad Software Engineer 2027 Start", "Software Engineer, Class of 2027"]:
        assert df.role_in_season(t), f"FT season gate should pass: {t}"


def test_us_only_geo_rejects_bare_global_remote():
    assert df.location_is_us_or_remote("San Francisco, CA")
    assert df.location_is_us_or_remote("Remote, US")
    assert df.location_is_us_or_remote("Remote (United States)")
    assert not df.location_is_us_or_remote("Remote, India")
    assert not df.location_is_us_or_remote("Remote - EMEA")
    # bare "Remote" string with no country is ambiguous -> NOT US-qualified
    assert not df.location_is_us_or_remote("Remote")
    # is_remote flag from a US-scoped source w/ no location passes...
    assert df.location_is_us_or_remote("", is_remote=True)
    # ...but an explicit non-US location overrides the remote flag
    assert not df.location_is_us_or_remote("Remote, India", is_remote=True)


if __name__ == "__main__":
    test_newgrad_titles_pass_without_intern_token()
    test_senior_titles_still_denied()
    test_season_gate_neutral_for_ft()
    test_us_only_geo_rejects_bare_global_remote()
    print("ok")
```

- [ ] **Step 2: Run to confirm it fails** — `python3 scripts/test_ft_filters.py` → fails (intern gate rejects new-grad titles; bare global remote currently passes).

- [ ] **Step 3: Rewrite `role_matches_targets` (313-325).** Replace with:
```python
# New-grad / entry-level allow tokens (a positive boost signal, NOT required —
# many on-target FT roles carry no level word in the title).
NEWGRAD_TOKENS = [
    "new grad", "new-grad", "newgrad", "new graduate", "university grad",
    "university graduate", "entry level", "entry-level", "early career",
    "associate", "campus", "class of 20", "2026 grad", "2027 grad",
    "early talent", "rotational",
]
# Titles that are entry-level despite containing a deny-ish word, e.g. AI-lab
# "Member of Technical Staff" must NOT be killed by the " staff " deny token.
_DENY_CARVEOUTS = ("member of technical staff", "technical staff -")

def role_matches_targets(role):
    rl = " " + (role or "").lower() + " "
    # FT pivot: the intern-token requirement is removed. On-target = a target
    # role token present AND no senior/non-tech deny token (unless carved out).
    if not any(tok in rl for tok in TARGET_ROLE_TOKENS):
        return False
    if any(tok in rl for tok in ROLE_DENY_TOKENS):
        if not any(c in rl for c in _DENY_CARVEOUTS):
            return False
    return True
```
(`NEWGRAD_TOKENS` is exported for portals/boost reuse; it is not a hard gate here.)

- [ ] **Step 4: Add FDE + MTS tokens to `TARGET_ROLE_TOKENS` (41-50).** Append: `"forward deployed", "forward-deployed", "fde", "solutions engineer", "field engineer", "member of technical staff", "technical staff"`. (`"solutions"`/`"analyst"` already present.) The MTS tokens are required because `role_matches_targets` checks for a target token FIRST — without them, "Member of Technical Staff" fails the target check before the deny-carveout can save it (Codex catch). The `_DENY_CARVEOUTS` then keeps it past the `" staff "` deny.

- [ ] **Step 5: Neutralize the season gate for FT.** Change `role_in_season` (296-298) to:
```python
def role_in_season(role):
    """FT pivot: no intern-season filtering. Always in-season."""
    return True
```
Leave `SEASON_DENY_RE` defined (it is still imported by `aggregator-intake.py` and used by `_normalize_role` at line 401 to strip season noise from dedup fingerprints — that use is harmless and stays).

- [ ] **Step 6: Tighten geo to US-only in `location_is_us_or_remote` (328-349).** Three rules, in order: an explicit NON-US location always drops (even with `is_remote`); a US signal passes; an `is_remote=True` flag with no contradicting non-US location passes (trusts US-scoped sources like jobspy); everything else (bare `"remote"` string, empty) drops. This balances strict US-only against the over-drop Codex flagged for `apply_unified_filter` (which calls this for jobspy/other sources at [discovery_filters.py:574]):
```python
NON_US_HINTS = [
    "india", "canada", "united kingdom", " uk", "ireland", "germany", "france",
    "spain", "portugal", "poland", "netherlands", "emea", "apac", "latam",
    "europe", "remote - eu", "remote, eu", "bengaluru", "bangalore", "hyderabad",
    "pune", "london", "berlin", "toronto", "dublin", "singapore", "australia",
    "mexico", "brazil", "japan", "israel",
]

def location_is_us_or_remote(location, is_remote=False):
    """US-only FT. Explicit non-US -> drop (even if remote). US signal -> pass.
    is_remote flag w/o a non-US contradiction -> pass (US-scoped source). Bare
    'remote' string or empty -> drop."""
    loc = (location or "").lower()
    if any(n in loc for n in NON_US_HINTS):
        return False
    us_signal = (
        any(h in loc for h in US_CITY_HINTS)
        or " usa" in loc or "united states" in loc or loc.endswith(", us")
        or any(re.search(r"[,\s]" + code + r"\b", location or "") for code in US_STATE_CODES)
        or any(re.search(r"\b" + re.escape(name) + r"\b", loc) for name in US_STATE_NAMES)
    )
    if us_signal:
        return True
    if is_remote and not loc.strip():
        return True   # US-scoped source flagged remote, no location string to contradict
    return False
```
Add `"remote (united states)"`, `"remote (us)"`, `"remote usa"` to `US_CITY_HINTS` (93-103) so those forms pass. **Blast radius (Codex #7):** this function is also called by `apply_unified_filter` (574) for jobspy and other shared-source rows — the US-only tightening intentionally applies there too. Sources that emit a bare `"Remote"` string (not the `is_remote` flag) will now drop; that's the intended US-only behavior, but log the `non_us` drop count so over-dropping is visible.

- [ ] **Step 7: Run the test** — `python3 scripts/test_ft_filters.py` → `ok`. Also `python3 -c "import py_compile; py_compile.compile('scripts/discovery_filters.py', doraise=True); print('compile ok')"`.

- [ ] **Step 8: Checkpoint (optional)** — `git add scripts/discovery_filters.py scripts/test_ft_filters.py`

---

## Task 2: Aggregator source swap + sponsorship-emoji capture

**Files:** Modify `scripts/aggregator-intake.py` — `SOURCES` (the list), `harvest_table` (312-387), the local filter loop (506-522), and the private `write_tsv` writer (390) + its call site (~597)

- [ ] **Step 1: Replace the `SOURCES` list** with the new-grad/H-1B feeds. Each dict keeps the `{name, url}` shape the parser expects:
```python
SOURCES = [
    # speedyapply new-grad tables (US-only FT). Age column ("5d"/"1mo").
    {"name": "speedyapply-swe-newgrad",
     "url": "https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/NEW_GRAD_USA.md"},
    {"name": "speedyapply-ai-newgrad",
     "url": "https://raw.githubusercontent.com/speedyapply/2026-AI-College-Jobs/main/NEW_GRAD_USA.md"},
    # SimplifyJobs new-grad (default branch `dev`). Inline 🛂/🇺🇸 sponsorship emoji.
    {"name": "simplifyjobs-newgrad",
     "url": "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md"},
    # vanshb03 new-grad (US/Canada/Remote). Inline 🛂/🇺🇸 emoji; Date Posted column.
    {"name": "vanshb03-newgrad-2027",
     "url": "https://raw.githubusercontent.com/vanshb03/New-Grad-2027/main/README.md"},
    {"name": "vanshb03-newgrad-2026",
     "url": "https://raw.githubusercontent.com/vanshb03/New-Grad-2026/main/README.md"},
    # jobright-ai new-grad SWE (hourly; last-7-days table; no sponsorship col).
    {"name": "jobright-newgrad-swe",
     "url": "https://raw.githubusercontent.com/jobright-ai/2026-Software-Engineer-New-Grad/master/README.md"},
    # jobright-ai H-1B-filtered (US; dedicated "H1B status" column 🏅/🥈).
    # CAVEAT: may be stale; the freshness guard in Step 4 drops rows older than max_age.
    {"name": "jobright-h1b",
     "url": "https://raw.githubusercontent.com/jobright-ai/Daily-H1B-Jobs-In-Tech/master/README.md"},
]
```

- [ ] **Step 2: Add a sponsorship-signal helper** near the top of `aggregator-intake.py` (after `strip_md`). It returns sponsorship AND a SEPARATE `citizen_only` flag — the eval rule needs them distinct (citizen-only → auto-skip; no-sponsorship → only penalize), so collapsing both to `False` (Codex #5) is wrong:
```python
# Per-row sponsorship signal from the new-grad repos' emoji / H1B-status column.
# Returns (sponsorship_tristate, citizen_only_bool):
#   🏅/🥈 -> (True,  cz)   sponsors / has history
#   🛂    -> (False, cz)   does NOT sponsor
#   🇺🇸   -> (.,     True) citizen-only (also implies no F-1 sponsorship)
#   none  -> (None,  False) unknown
def sponsorship_signal(*cells):
    blob = " ".join(c or "" for c in cells)
    citizen_only = "\U0001F1FA\U0001F1F8" in blob          # 🇺🇸
    if "\U0001F3C5" in blob or "\U0001F948" in blob:       # 🏅 explicit / 🥈 history
        return True, citizen_only
    if "\U0001F6C2" in blob or citizen_only:               # 🛂 no-sponsor / 🇺🇸 citizen
        return False, citizen_only
    return None, False
```

- [ ] **Step 3: Capture sponsorship in `harvest_table` (312-387).** The emoji live in the RAW role and apply/H1B-status cells (before `strip_md` removes nothing emoji-related, but detect on raw to be safe). Add an `h1b` column detector and set a `sponsorship` field on each yielded dict:
```python
    h1b_idx = find_col(header, "h1b", "sponsor")   # jobright H1B repo
```
and in the per-row yield, compute (using the RAW cells, not stripped — emoji survive `strip_md` but raw is safest):
```python
        sponsorship, citizen_only = sponsorship_signal(
            raw[role_idx] if role_idx is not None else "",
            raw[url_idx] if url_idx is not None else "",
            raw[h1b_idx] if (h1b_idx is not None and h1b_idx < len(raw)) else "",
        )
        yield {
            "company": comp_cell, "role": role_cell, "location": loc_cell,
            "url": url.strip(), "type": type_cell, "source": source_name,
            "age_days": age_days, "sponsorship": sponsorship, "citizen_only": citizen_only,
        }
```

- [ ] **Step 4: Rewrite the local filter loop (506-522) for FT.** The REAL code initializes `kept = []` then `dropped_brand = dropped_phd = 0` and the loop calls `is_internship` / `role_matches_targets` / `role_in_season` / `is_brand_denied` / `is_phd_only_title` / `location_is_us_or_remote` (Codex confirmed — there is no `drops` dict). Replace the counter init + loop with:
```python
    kept = []
    dropped_brand = dropped_phd = dropped_offtarget = dropped_nonus = dropped_old = 0
    for entry in deduped:
        # FT pivot: no intern requirement, no season gate. Shared FT role gate.
        if not role_matches_targets(entry["role"]):
            dropped_offtarget += 1
            continue
        if is_brand_denied(entry["company"]):
            dropped_brand += 1
            continue
        if is_phd_only_title(entry["role"]):
            dropped_phd += 1
            continue
        # Freshness guard (covers the possibly-stale jobright H1B feed):
        if entry.get("age_days") is not None and entry["age_days"] > MAX_AGE_DAYS_DEFAULT:
            dropped_old += 1
            continue
        # US-only geo: keep the aggregator's "missing location = keep" behavior
        # (many rows omit it), but a present non-US location drops.
        loc = entry.get("location", "")
        if loc and not location_is_us_or_remote(loc):
            dropped_nonus += 1
            continue
        kept.append(entry)
```
Removed: the `if not is_internship(...)` and `if not role_in_season(...)` lines. **Local overrides:** the extraction noted aggregator-intake defines its OWN `role_matches_targets` / `location_is_us_or_remote` (~186-194) that diverge from the shared module. Delete those local overrides so the loop uses the shared FT versions imported from `discovery_filters` (add them to the import block at 56-68 if not already imported). If `is_internship` becomes unused after this, drop it from the imports. Update any later summary `print(...)` that references the old counters to include the new ones (or leave the new ones unprinted — they're for drop visibility).

- [ ] **Step 5: Render sponsorship in the private `write_tsv` (NOT `emit_tsv`).** Codex confirmed the aggregator writes rows via its own `write_tsv(num, date, company, role, notes_url, source, age_days, dry_run)` at line 390 (called at ~597) — it does NOT call `discovery_filters.emit_tsv`. Extend `write_tsv`'s signature and Notes-building:
```python
def write_tsv(num, date, company, role, notes_url, source, age_days, dry_run,
              sponsorship=None, citizen_only=False, extras=None):
    ...
    age_blurb = f"Posted {age_days}d ago. " if age_days is not None else "Age unknown. "
    sponsor_blurb = ""
    if sponsorship is True:
        sponsor_blurb = "VISA-SPONSORSHIP: yes. "
    elif sponsorship is False:
        sponsor_blurb = "VISA-SPONSORSHIP: no (per source). "
    if citizen_only:
        sponsor_blurb += "CITIZEN-ONLY: yes (per source). "
    extras_blurb = ""
    if extras:
        parts = [f"{k}: {v}" for k, v in extras.items() if v not in (None, "")]
        if parts:
            extras_blurb = "; ".join(parts) + ". "
    notes = (
        f"Aggregator discovery via {source}. {age_blurb}{sponsor_blurb}{extras_blurb}URL: {notes_url}. "
        "Not yet evaluated; promote to per-role eval before applying."
    )
    notes = EM_DASH_RE.sub(",", notes)
    ...
```
Then at the call site (~597), pass `sponsorship=entry.get("sponsorship"), citizen_only=entry.get("citizen_only", False), extras=entry.get("extras")`. The eval agent reads the `VISA-SPONSORSHIP` / `CITIZEN-ONLY` Notes tokens (Task 4 rule).

- [ ] **Step 6: Verify (offline, no live fetch needed for the parser logic)** with a fixture:
```bash
python3 - <<'PY'
import sys; sys.path.insert(0,'scripts'); import importlib
ai = importlib.import_module('aggregator-intake')
md = """| Company | Role | Location | Application | Age |
|---|---|---|---|---|
| Acme | Software Engineer, New Grad \U0001F6C2 | Remote, India | [Apply](https://x) | 2d |
| Beta | New Grad ML Engineer | New York, NY | [Apply](https://y) | 1d |
"""
rows = list(ai.parse_all_tables(md)); 
for tbl in [rows[0]]:
    for r in ai.harvest_table(tbl, "fixture"):
        print(r["company"], "| sponsorship=", r["sponsorship"], "| loc=", r["location"])
PY
```
Expected: Acme row has `sponsorship=False` (🛂) and an India location; Beta has `sponsorship=None`, US location. (The India row will later drop at the geo filter; the US row survives.) Then `python3 -c "import py_compile; py_compile.compile('scripts/aggregator-intake.py', doraise=True); print('ok')"`.

- [ ] **Step 7: Checkpoint (optional)** — `git add scripts/aggregator-intake.py`

---

## Task 3: H1BGrader sponsorship-history enrichment

**Files:** Create `scripts/h1bgrader_lookup.py` + `scripts/test_h1bgrader_lookup.py`

A best-effort company→sponsorship-history signal via FlareSolverr, cached under `ft/data/` (resolver-aware). Degrades to `unknown` if FlareSolverr is down or the company can't be resolved — never blocks the pipeline.

- [ ] **Step 1: Write the test** `scripts/test_h1bgrader_lookup.py` (pure-function tests only — no network):
```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import h1bgrader_lookup as h


def test_company_slug_guess():
    assert h.slug_guess("Google LLC") == "google-llc"
    assert h.slug_guess("Acme, Inc.") == "acme-inc"
    assert h.slug_guess("AT&T") == "at-t"


def test_parse_sponsor_page_extracts_signal():
    html = '<h1>Google LLC H1B</h1> ... 8,779 LCA ... 8,685 Certified ... NOT a H1B Dependent Employer ... $184,000 median'
    sig = h.parse_sponsor_page(html)
    assert sig["has_history"] is True
    assert sig["lca_recent"] == 8779
    assert sig["dependent"] is False


def test_parse_sponsor_page_zero_history():
    sig = h.parse_sponsor_page("<h1>Acme</h1> profile loaded, 0 LCA records on file")
    assert sig["has_history"] is False   # loaded but zero


def test_parse_sponsor_page_404_is_unknown():
    sig = h.parse_sponsor_page("<h1>Page Not Found</h1> we couldn't find that sponsor")
    assert sig["has_history"] is None     # unresolved, NOT a real zero (Codex #6)
    assert h.parse_sponsor_page("")["has_history"] is None


if __name__ == "__main__":
    test_company_slug_guess(); test_parse_sponsor_page_extracts_signal()
    test_parse_sponsor_page_zero_history(); test_parse_sponsor_page_404_is_unknown()
    print("ok")
```

- [ ] **Step 2: Run to confirm it fails** — `python3 scripts/test_h1bgrader_lookup.py` → ModuleNotFoundError.

- [ ] **Step 3: Implement `scripts/h1bgrader_lookup.py`.** Reuse the FlareSolverr request shape from `scripts/hiringcafe-ingest.py` (POST `{"cmd":"request.get","url":...,"maxTimeout":90000}` to `http://localhost:8191/v1`, read `solution.response` HTML). Cache to `{target}/data/h1bgrader-cache.json` via the Plan-1 resolver:
```python
"""Best-effort H1BGrader sponsorship-history enrichment (via FlareSolverr).
Never raises into the pipeline: on any failure returns {"has_history": None}."""
import json, re, sys, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths

FLARESOLVERR_URL = "http://localhost:8191/v1"
_P = _paths.resolve_paths(__file__)
CACHE = _P["data_dir"] / "h1bgrader-cache.json"


def slug_guess(company):
    s = re.sub(r"[^a-z0-9]+", "-", (company or "").lower()).strip("-")
    return s


def parse_sponsor_page(html):
    """Coarse sponsorship signal from an H1BGrader company page.
    has_history: True=has LCAs, False=loaded-but-zero, None=unresolved (404/empty)."""
    if not html:
        return {"has_history": None, "lca_recent": 0, "dependent": None}
    # A FlareSolverr "ok" solution can still be H1BGrader's 404/not-found page;
    # treat that as UNKNOWN (None), not a real zero-history (Codex #6).
    if re.search(r"(page not found|404|we could.?n.?t find|no results found)", html, re.I) \
       and not re.search(r"LCA", html):
        return {"has_history": None, "lca_recent": 0, "dependent": None}
    m_lca = re.search(r"([\d,]+)\s*LCA", html)
    lca = int(m_lca.group(1).replace(",", "")) if m_lca else 0
    dependent = None
    if re.search(r"NOT a H1B Dependent", html, re.I):
        dependent = False
    elif re.search(r"is a H1B Dependent", html, re.I):
        dependent = True
    return {"has_history": lca > 0, "lca_recent": lca, "dependent": dependent}


def _load_cache():
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text())
        except Exception:
            return {}
    return {}


def _save_cache(c):
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(c, indent=2, sort_keys=True))
    except Exception:
        pass   # cache write must never raise into the pipeline (Codex #6)


def _flaresolverr_get(url, timeout=120):
    payload = {"cmd": "request.get", "url": url, "maxTimeout": 90000}
    req = urllib.request.Request(
        FLARESOLVERR_URL, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.loads(r.read().decode("utf-8", "replace"))
    if resp.get("status") != "ok":
        return None
    return (resp.get("solution") or {}).get("response", "")


def lookup(company, use_cache=True):
    """Return {"has_history": bool|None, "lca_recent": int, "dependent": bool|None}.
    has_history=None means 'unknown' (FlareSolverr down / unresolved)."""
    key = slug_guess(company)
    if not key:
        return {"has_history": None}
    cache = _load_cache() if use_cache else {}
    if key in cache:
        return cache[key]
    try:
        html = _flaresolverr_get(f"https://h1bgrader.com/h1b-sponsors/{key}")
    except Exception:
        return {"has_history": None}
    sig = parse_sponsor_page(html) if html else {"has_history": None}
    if use_cache and sig.get("has_history") is not None:
        cache[key] = sig
        _save_cache(cache)
    return sig
```
Note the slug-suffix limitation in a docstring comment: `https://h1bgrader.com/h1b-sponsors/{slug}` often needs an opaque id suffix; the bare-slug guess resolves the common cases and otherwise returns `unknown`. (Future: add a search-resolve step or fall back to the USCIS Employer Data Hub bulk CSV for authoritative batch coverage — recorded as an open item, not built here.)

- [ ] **Step 4: Run the test** — `python3 scripts/test_h1bgrader_lookup.py` → `ok`.

- [ ] **Step 5: Wire it as an OPTIONAL enrichment in the aggregator** — in `aggregator-intake.py`, after a row passes all filters and BEFORE the `write_tsv` call (~597), if the row's `sponsorship` is still `None`, try `h1bgrader_lookup.lookup(company)` and, if `has_history` is True, set `sponsorship=True` and add an `extras={"H1B-HISTORY": f"{lca_recent} recent LCAs"}`. Guard the import so a missing module / FlareSolverr never breaks the run:
```python
    try:
        import h1bgrader_lookup as _h1b
    except Exception:
        _h1b = None
    ...
    if entry.get("sponsorship") is None and _h1b is not None:
        try:
            sig = _h1b.lookup(entry["company"])
        except Exception:
            sig = {"has_history": None}   # belt-and-suspenders: lookup must never break the run (Codex #6)
        if sig.get("has_history") is True:
            entry["sponsorship"] = True
            entry.setdefault("extras", {})["H1B-HISTORY"] = f"{sig.get('lca_recent','?')} recent LCAs"
```
Add a `--no-h1b` CLI flag to skip enrichment for fast/offline runs.

- [ ] **Step 6: Checkpoint (optional)** — `git add scripts/h1bgrader_lookup.py scripts/test_h1bgrader_lookup.py scripts/aggregator-intake.py`

---

## Task 4: Eval-stage sponsorship lens + archetype reframe (`modes/_profile.md`)

**Files:** Modify `modes/_profile.md` (heading L1; archetype tables 13-34; exit narrative 37-48; comp 55-64; negotiation 67-76; location 80-93; F-1/CPT constraints 94-103)

The eval agent reads `_profile.md` for archetypes + the visa gate. Reframe intern→FT/OPT/H-1B. KEY per the locked decision: **"cannot sponsor" is a flag+penalty, NOT an auto-skip** (OPT/STEM-OPT buys ~3 years), while **citizen-only / clearance stay auto-skip** (F-1 can't satisfy).

- [ ] **Step 1: Heading (L1)** → `# User Profile Context — career-ops (Anmol Sahu, Full-Time / New-Grad Search, start ~Jan 2027)`.

- [ ] **Step 2: Archetype table (13-22)** → retitle "Your Target Roles (Full-Time / New Grad)" and drop "Intern" from each archetype name: "Software Engineer (New Grad)", "ML / Applied Scientist (New Grad)", "AI Engineer / Agent", "Data Engineer", "Data Scientist", "Forward-Deployed / Solutions Engineer" (NEW row — FDE per the user), "DevOps / SRE / Security". Keep the "what they buy" framing but in full-time terms (own features/systems, not "as an intern").

- [ ] **Step 3: Exit narrative (37-48)** — remove the intern-only line "Available June 1, 2026 (May 12 stretch), CPT-eligible, no employer sponsorship needed for internship". Replace the availability bullet with: "If start date is asked: Available January 2027." Do NOT add any proactive visa statement (per the no-availability-phrases rule).

- [ ] **Step 4: Comp (55-64)** → "Your Comp Targets (Full-Time New Grad)" with FT base bands instead of hourly (see Task 6 profile.yml for the canonical numbers; mirror them here).

- [ ] **Step 5: Negotiation (67-76)** — replace the CPT-processing script with FT-appropriate framing (start date, sign-on, base); remove the CPT/OIE sentence.

- [ ] **Step 6: Location (80-93)** — drop the "Remote (India for summer) … CPT covers it" row and the F-1-summer-return scoring note. Geography is US-only; score non-US-only roles low.

- [ ] **Step 7: F-1/CPT Hard Constraints (94-103)** → retitle "Your F-1 / OPT / H-1B Constraints" and rewrite:
```markdown
## Your F-1 / OPT / H-1B Constraints

You are on F-1, OPT-eligible (12 months + 24-month STEM extension), and will need
H-1B sponsorship for the long term. Apply these in evaluations:

Discovery rows carry machine-readable Notes tokens you must key off:
`CITIZEN-ONLY: yes` (🇺🇸), `VISA-SPONSORSHIP: no` (🛂), `VISA-SPONSORSHIP: yes` / `H1B-HISTORY: ...` (🏅/🥈 or H1BGrader). These are DISTINCT signals — do not conflate them.

**Auto-skip (F-1 cannot satisfy):**
- `CITIZEN-ONLY: yes` in Notes, or "US Citizen / Green Card holder only"
- "Active Security Clearance required" / defense-cleared work
- "US Person" / ITAR-restricted roles

**Flag + score-penalty (NOT auto-skip) — OPT/STEM-OPT buys ~3 years, but these dead-end:**
- `VISA-SPONSORSHIP: no` in Notes, or "we do not / cannot sponsor": viable on OPT now,
  no long-term path. Note in Red Flags; cap the Global score (e.g. <= 3.5).
- "Sponsorship not guaranteed" / "case-by-case": flag, do not penalize as hard.

**Positive signal:** `VISA-SPONSORSHIP: yes` / `H1B-HISTORY` in Notes (or H1BGrader history) —
known sponsor; treat as a comp/stability plus.
```

- [ ] **Step 8: Verify** — `grep -ni "intern\|cpt\|summer 2026\|june 2026" modes/_profile.md` → only intentional/historical mentions remain (ideally none in active framing). Re-read the file top-to-bottom for coherence.

- [ ] **Step 9: Checkpoint (optional)** — `git add modes/_profile.md`

---

## Task 5: `portals.yml` — title filter + new-grad queries

**Files:** Modify `portals.yml` — `must_match` (37), `seniority_boost` (160-166), `search_queries` (172-344)

- [ ] **Step 0: Confirm how `must_match` is consumed** before editing — `grep -n "must_match" scan.mjs scan-spa.mjs scripts/discovery_filters.py portals.yml`. `scan.mjs`/`scan-spa.mjs` build a JS `RegExp` from it ([scan.mjs] title-filter region ~263). So the value must be valid in BOTH JS and Python regex.

- [ ] **Step 1: Rewrite `must_match` (line 37).** The intern gate `\b(intern...|co-?op|...|summer\s*20\d{2})\b` becomes a permissive *target-domain* gate (the `negative:` list already drops senior/staff/manager). **No nested `\b`** inside the alternation (Codex #8 — `\bml\b` inside `\b(...)\b` is malformed/redundant and risks JS issues). Use word-boundaried alternation cleanly:
```yaml
  must_match: '\b(engineer|developer|swe|sde|software|data|machine learning|ml|ai|mle|applied scientist|research|analyst|analytics|forward deployed|solutions engineer|new grad|entry level|university|associate)\b'
```
The outer `\b...\b` already gives word boundaries to each alternative, so bare `ml`/`ai` match only as whole words (e.g. not inside "html"/"email").

- [ ] **Step 2: Update `seniority_boost` (160-166)** — replace intern tokens with new-grad/entry: `"New Grad"`, `"New Graduate"`, `"Entry Level"`, `"University"`, `"Early Career"`, `"Associate"`, `"Class of 2026"`, `"Class of 2027"`, `"2026 Grad"`, `"2027 Grad"`.

- [ ] **Step 3: Add new-grad search queries (in `search_queries`, 172-344).** Append a handful of FT new-grad dorks alongside the existing ones, e.g.:
```yaml
  - name: Greenhouse — New Grad SWE
    query: 'site:boards.greenhouse.io ("New Grad" OR "University Graduate" OR "Entry Level") ("Software Engineer" OR "Data Engineer") United States'
    enabled: true
  - name: Ashby — New Grad ML/Data
    query: 'site:jobs.ashbyhq.com ("New Grad" OR "Early Career") ("Machine Learning" OR "Data Scientist" OR "AI Engineer") remote US'
    enabled: true
  - name: Lever — New Grad / FDE
    query: 'site:jobs.lever.co ("New Grad" OR "Associate") ("Software Engineer" OR "Forward Deployed" OR "Solutions Engineer") United States'
    enabled: true
```
Leave the existing FTE/AI queries; they already skew full-time. Disable or trim any that are explicitly intern-only (scan the 34 for "intern"/"summer 20XX" — none observed, but verify with `grep -ni intern portals.yml`).

- [ ] **Step 4: Verify in BOTH engines.** YAML parses: `python3 -c "import yaml; yaml.safe_load(open('portals.yml')); print('yaml ok')"`. Python regex: load `must_match`, assert it matches "New Grad Software Engineer" and "Machine Learning Engineer", and that the `negative` list still rejects "Senior Software Engineer". JS regex (since scan.mjs compiles it): `node -e "const re=new RegExp(require('js-yaml').load(require('fs').readFileSync('portals.yml','utf8')).title_filter.must_match,'i'); console.log(re.test('New Grad Data Engineer'), re.test('html parser'))"` → expect `true false` (no crash = the regex is JS-valid; the malformed nested-\\b version would behave differently).

- [ ] **Step 5: Checkpoint (optional)** — `git add portals.yml`

---

## Task 6: `config/profile.yml` — full-time reframe

**Files:** Modify `config/profile.yml` — `target_roles` (14-36), `compensation` (65-70), `location`/`visa_status` (72-78), `internship_constraints` (80-86), `internship_priority_companies` (88-115)

- [ ] **Step 1: `target_roles` (14-36)** — comment → "North Star roles for full-time / new-grad search (start ~Jan 2027)"; `primary` → "Software Engineer (New Grad)", "Machine Learning Engineer (New Grad)", "Applied Scientist", "AI Engineer", "Forward-Deployed / Solutions Engineer"; archetype `level:` fields → "New Grad / Entry-Level (2026/2027)"; drop "Intern" everywhere; add the FDE archetype (`fit: "primary"`).

- [ ] **Step 2: `compensation` (65-70)** — replace hourly intern bands with FT new-grad base bands:
```yaml
compensation:
  # Full-time new-grad base bands (US, 2026/2027 cycle)
  target_range: "$120-160k base (SWE/MLE at scaled tech) | $100-130k (data/analyst, mid-market)"
  currency: "USD"
  minimum: "$95k base (floor for US new-grad SWE/data)"
  location_flexibility: "In-person any US metro, or remote-US; relocation OK"
```

- [ ] **Step 3: `location`/`visa_status` (72-78)** — `visa_status:` → `"F-1; OPT-eligible (12mo + 24mo STEM extension); needs H-1B sponsorship for long term"`; drop CPT/Heinz wording; `onsite_availability:` → "Any US metro or remote-US; will relocate."

- [ ] **Step 4: Rename `internship_constraints` → `ft_constraints` (80-86)**:
```yaml
ft_constraints:
  availability: "January 2027 (post-Dec-2026 graduation)"
  work_auth: "OPT at start; H-1B sponsorship required for long-term retention"
  geography: "US-only (in-person or remote-US); non-US roles out of scope"
  amazon_sde_cooling_off: "If Amazon SDE was rejected Apr 2026, 12-month cooling-off until ~2027-04-08; non-SDE Amazon roles open"
```

- [ ] **Step 5: Rename `internship_priority_companies` → `ft_priority_companies` (88-115)** — keep the lists but retitle the comment to full-time and add a short note to prefer known H-1B sponsors (the lists themselves can stay; Anthropic/OpenAI/Duolingo/etc. are all sponsors). Drop the "hackathon_sponsors_to_pursue" intern-outreach sub-block if it's intern-specific, or retitle to "warm_intros".

- [ ] **Step 6: Verify** — `python3 -c "import yaml; yaml.safe_load(open('config/profile.yml')); print('yaml ok')"`; `grep -ni "intern\|cpt\|summer 2026\|45-55/hr" config/profile.yml` → no active intern framing remains.

- [ ] **Step 7: Checkpoint (optional)** — `git add config/profile.yml`

---

## Task 7: `CLAUDE.md` — rules + framing pivot

**Files:** Modify `CLAUDE.md` — Rule 3 (visa framing), Rule 5 (target roles), the "Who" line, "Useful API endpoints" intern framing, the workflow intern phrasing

- [ ] **Step 1: Rule 3** — currently forbids the CPT/Heinz/OIE explainer and says 'If start date is asked, just say "Available June 2026."' Rewrite for FT: forbid any OPT/H-1B/visa explainer in candidate-facing content (same spirit), and 'If start date is asked, just say "Available January 2027."' Keep the no-explainer discipline.

- [ ] **Step 2: Rule 5 (target roles)** — replace the intern list with: "SDE / Software Engineer (New Grad), AI Engineer, MLE, Data Scientist, Data Engineer, Data Analyst, Forward-Deployed / Solutions Engineer, plus adjacent. US-based (in-person or remote-US) primary; **needs H-1B sponsorship** (no India-remote for the US FT search)."

- [ ] **Step 3: "Who" line (top of file)** — change "Summer 2026 internship search ops" → "Full-time / new-grad search ops (Dec 2026 grad, start ~Jan 2027)". Keep the rest of the bio.

- [ ] **Step 4: "Useful API endpoints (intern-friendly filters)"** heading and its "filter for 'intern' / 'summer 2026' / 'student'" guidance → "filter for 'new grad' / 'entry level' / '2026/2027 grad'". Update the SimplifyJobs/aggregator line to reference the new-grad repos.

- [ ] **Step 5: Scan the workflow section + layout** for residual "intern" framing (`grep -ni intern CLAUDE.md`) and reword the candidate-surfacing workflow language to full-time where it describes intent (do not touch the tracker schema, the `ft/`/resolver mechanics from Plan 1, or hard rules 1/2/4/6/7 except where they say intern).

- [ ] **Step 6: Verify** — `grep -ni "intern\|cpt\|summer 2026\|june 2026" CLAUDE.md` → only deliberate/historical references remain (e.g. the Handshake-history note); no active intern targeting.

- [ ] **Step 7: Checkpoint (optional)** — `git add CLAUDE.md`

---

## Task 8: `INDEX.md` header

**Files:** Modify `INDEX.md` (lines 1-9)

- [ ] **Step 1:** Change line 3 "Anmol Sahu — Summer 2026 internship search ops (Tabhi accepted; FT pivot scoped in STATUS.md)." → "Anmol Sahu — Full-time / new-grad search ops (Dec 2026 grad; Tabhi summer internship done; FT pivot Plans 1-2 landed). Index refreshed 2026-06-05." Leave the rest of the index structure; deeper INDEX refresh is out of scope for this plan.

- [ ] **Step 2: Checkpoint (optional)** — `git add INDEX.md`

---

## Task 9: Pivot (or deprecate) the other discovery-source ingest scripts

**Files:** Modify `scripts/jobspy-ingest.py`, `scripts/adzuna-ingest.py`, `scripts/hiringcafe-ingest.py`, `scripts/hn-hiring-ingest.py`, `scripts/yc-ingest.py`, `scripts/levels-ingest.py`, `scripts/startupjobs-ingest.py`

Codex #4: the shared `discovery_filters` changes are necessary but NOT sufficient — these seven sources each carry their OWN intern keyword list or intern hard-filter, so without this task they would still pull internships (or, where they gate on intern tokens, surface nothing). Pivot the keyword/URL surfaces; **deprecate (disable) any source whose FT surface is unclear rather than guess a wrong URL.**

- [ ] **Step 1: Define a shared FT keyword string** to reuse across the keyword-based sources. The new-grad/FT equivalent of the intern list:
```
software engineer new grad,machine learning engineer new grad,data scientist new grad,data engineer new grad,ai engineer new grad,forward deployed engineer,solutions engineer new grad,new grad software engineer,entry level software engineer,university graduate software engineer
```

- [ ] **Step 2: `jobspy-ingest.py` (`DEFAULT_KEYWORDS` ~59)** — replace the intern keyword tuple with the FT keywords from Step 1. JobSpy already scopes to US; confirm its country/location params stay US.

- [ ] **Step 2b: `adzuna-ingest.py` (`DEFAULT_KEYWORDS` ~50)** — replace its intern keyword tuple with the Step-1 FT keywords. Adzuna routes through `df.apply_unified_filter` (~236), so the shared FT gate + US-only geo now apply automatically; only the query keywords need pivoting. (Codex #1 — Adzuna was missed in the first revision.)

- [ ] **Step 3: `yc-ingest.py` — keywords AND the hardcoded internship URL.** Replace `DEFAULT_KEYWORDS` (~42) with the Step-1 FT keywords, AND repoint the Playwright navigation at ~152 — it hardcodes `https://www.workatastartup.com/internships${kwParam}`. Change `/internships` → `/jobs` (the workatastartup full-time surface) and update the adjacent comment ("?q= supported on /internships"). Then verify `?q=` filtering still works on `/jobs`; if it does not, **disable yc-ingest** (same defer pattern as levels/startupjobs) and log "yc-ingest deferred: FT surface query unverified" — do not leave it scraping `/internships`. (Codex #2.)

- [ ] **Step 4: `hiringcafe-ingest.py`** — (a) `DEFAULT_KEYWORDS` (~170) → FT keywords. (b) Find the source-side internship hard-filter Codex flagged at ~170/~501 (`grep -n "intern\|commitment\|internship" scripts/hiringcafe-ingest.py`) and switch the commitment/type filter from internship to full-time (or remove it so the shared FT gate decides). Verify the Hiring Cafe `searchState`/commitment param now requests full-time.

- [ ] **Step 5: `hn-hiring-ingest.py` (intern hard-filter ~214)** — currently `if not INTERN_TOKEN_RE.search(role_for_filter): return None`. Replace the intern gate with the shared FT role gate: `import discovery_filters as df` and `if not df.role_matches_targets(role_for_filter): return None`. This makes HN entries gated by the FT role gate instead of intern tokens. Drop the now-unused `INTERN_TOKEN_RE` if nothing else uses it.

- [ ] **Step 6: `levels-ingest.py` (HOMEPAGE ~45 = `https://www.levels.fyi/jobs/internships`)** — Levels.fyi's new-grad surface URL is not confirmed by the research. **Disable this source** in this pass (comment out its entry in the runner / set an `ENABLED = False` guard at the top that early-returns), and log it in the CHANGELOG as "levels-ingest deferred: new-grad URL unverified." Do NOT guess a URL.

- [ ] **Step 7: `startupjobs-ingest.py` (`/internships` category + `c=internship` param ~42)** — if a clear full-time/new-grad category param exists (`grep -n "internship\|category\|c=" scripts/startupjobs-ingest.py` and check the site), repoint to it; otherwise **disable** it the same way as levels and log "startupjobs-ingest deferred." (Memory notes startup.jobs was already low-yield.)

- [ ] **Step 8: Verify** — `python3 -c "import py_compile; [py_compile.compile(f, doraise=True) for f in ['scripts/jobspy-ingest.py','scripts/adzuna-ingest.py','scripts/hiringcafe-ingest.py','scripts/hn-hiring-ingest.py','scripts/yc-ingest.py','scripts/levels-ingest.py','scripts/startupjobs-ingest.py']]; print('all compile ok')"`. Then `grep -rni "intern" scripts/jobspy-ingest.py scripts/adzuna-ingest.py scripts/yc-ingest.py scripts/hiringcafe-ingest.py scripts/hn-hiring-ingest.py` → only deliberate/historical mentions remain (no active intern keyword/gate/URL).

- [ ] **Step 9: Checkpoint (optional)** — `git add scripts/jobspy-ingest.py scripts/adzuna-ingest.py scripts/yc-ingest.py scripts/hiringcafe-ingest.py scripts/hn-hiring-ingest.py scripts/levels-ingest.py scripts/startupjobs-ingest.py`

---

## Task 10: cv-sync-check, STATUS, CHANGELOG

**Files:** run `cv-sync-check`; modify `STATUS.md`, `CHANGELOG.md`

- [ ] **Step 1: Run cv-sync-check** to confirm the CV/profile still align after the profile.yml edits:
```bash
node cv-sync-check.mjs 2>&1 | tail -15   # or: ls cv-sync-check* to find the entrypoint
```
Record the result. If it flags genuine drift introduced by the profile edits, fix the profile (not the CV PDFs — Rule 2). If the checker itself is intern-coupled, note it as an open item rather than forcing a change.

- [ ] **Step 2: Full filter sanity** — run the aggregator in dry-run against one live new-grad repo to confirm end-to-end: rows parse, FT gate admits new-grad titles, US-only geo holds, sponsorship blurbs appear, and everything lands in `ft/`:
```bash
node verify-pipeline.mjs   # ft tracker still clean
# Optional live smoke (network): a single-source aggregator dry-run if it supports one; else skip.
```

- [ ] **Step 3: Flip STATUS #3 → done.** In STATUS.md: move outstanding action #3 (the FT pivot) to done/landed, referencing Plans 1 + 2; update the "Last updated" line; note remaining outstanding actions (#1 Handshake, #2 LinkedIn, #4 rejection sweep, #5 letter length) unchanged.

- [ ] **Step 4: CHANGELOG entry** under `## 2026-06-05` summarizing Plan 2: FT gate rewrite, aggregator source swap to the 7 new-grad/H-1B repos + sponsorship-emoji capture, H1BGrader enrichment, eval-stage OPT/H-1B lens, and the config/docs pivot (profile.yml, portals.yml, modes/_profile.md, CLAUDE.md, INDEX.md).

- [ ] **Step 5: Checkpoint (optional)** — `git add STATUS.md CHANGELOG.md`

---

## Self-review notes (for the implementer)

- **The gate change is the highest-risk item:** removing the intern requirement widens the funnel a lot. The `ROLE_DENY_TOKENS` list is now the primary level filter — verify it still drops senior/staff/principal/manager while admitting new-grad + unlevelled SWE. The `_DENY_CARVEOUTS` exist so "Member of Technical Staff" survives the `" staff "` deny.
- **Geo is now strict US-only** in the shared module; the aggregator keeps "missing location = keep" (ATS rows often omit it) but drops any present non-US location. Confirm this asymmetry is intended (it is: aggregator rows usually carry a location; ATS-API rows may not).
- **Sponsorship is never a hard gate** anywhere — it only flags/penalizes at eval. The emoji/H1BGrader signal feeds Notes, not a drop.
- **H1BGrader is best-effort:** the bare-slug guess won't resolve every company; FlareSolverr may be down. It must never raise into the pipeline (the import + lookup are guarded). USCIS bulk CSV is the noted more-robust future alternative.
- Shared config (`portals.yml`, `cv.md`, `templates/`) is still read from repo root per Plan 1 — these edits don't change that.
