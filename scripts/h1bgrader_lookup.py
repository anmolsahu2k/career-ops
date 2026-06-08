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
        pass


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
    has_history=None means 'unknown' (FlareSolverr down / unresolved). Note: the
    bare-slug guess won't resolve every company (h1bgrader slugs have an opaque id
    suffix); unresolved -> unknown. Future: search-resolve or USCIS bulk CSV."""
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
