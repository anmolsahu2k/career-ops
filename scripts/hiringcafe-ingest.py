#!/usr/bin/env python3
"""hiringcafe-ingest.py - Hiring Cafe adapter for the career-ops discovery pipeline.

Hiring Cafe (hiringcafe.com) aggregates 30k+ company career pages and tags
each posting with `visa_sponsorship: True/False`, `commitment: ['Internship']`,
`workplace_states`, etc. - structured fields the GitHub aggregators don't
expose. Pulled via their Next.js getServerSideProps JSON path:

  https://hiring.cafe/_next/data/{buildId}/index.json?searchState={json}&page={N}

  searchState shape: {"searchQuery":"<free-text query>"}
  (Optional `locations: [...]` accepts Google Places-format dicts; we skip it
  and let the downstream unified-filter handle geographic gating against the
  rows' workplace_states / workplace_countries fields.)

The buildId rotates on every deploy so we scrape it from the homepage HTML.

API SHAPE CHANGE (2026-05-15): the previous `/_next/data/{buildId}/jobs/{kw-slug}/locations/{loc-slug}.json`
path was deprecated upstream and now returns `{}` (empty pageProps). The new
canonical path is `index.json` with URL-encoded `searchState` JSON. Slugified
job titles became free-text searchQuery; locations became Google Places dicts.

Cloudflare gate (2026-05+): hiring.cafe is behind Cloudflare Turnstile that
fails plain urllib (HTTP 403) AND headless Playwright + rebrowser-playwright
+ playwright-extra stealth (page stays on "Verifying you are human"). The
working bypass is FlareSolverr (Docker container exposing port 8191): we POST
the homepage to it, FlareSolverr solves the CF challenge with its own Chromium
instance and returns the `cf_clearance` cookie + the matched User-Agent. We
extract those, then make plain urllib requests for the JSON pages using the
issued cookies + UA - the CF edge accepts them and serves real JSON.

Fallback chain (tried in order):
  1. FlareSolverr at HIRINGCAFE_FLARESOLVER_URL (default http://localhost:8191/v1)
  2. Playwright headed mode (HIRINGCAFE_HEADED=1) - manual click-through
  3. Exit code 2 with actionable diagnostic; caller should skip the source.

Setup (one-time):
  docker run -d --name flaresolverr -p 8191:8191 --restart unless-stopped \
    ghcr.io/flaresolverr/flaresolverr:latest
  # then re-run the script normally; no other config needed.

Pipeline (canonical, shared with all discovery sources):
  Playwright fetch (per keyword x location) -> raw rows
    -> apply_unified_filter()
    -> emit TSVs at next_available_nn() w/ visa_sponsorship hint in Notes
    -> standard liveness gate
    -> eval dispatch
    -> merge-tracker.mjs

Pagination: each query returns 47-103 results per page; we walk pages until
ssrIsLastPage or `--max-pages-per-query` is hit (default 4 = ~200-400 rows
per query, ~9 keywords = ~1800-3600 raw before unified filter).

Usage:
  python3 scripts/hiringcafe-ingest.py
      [--keyword "kw1,kw2,..."]    # default 9 intern queries (free-text, not slugified)
      [--max-pages-per-query 4]
      [--max-age-days 21]
      [--no-clean]                 # keep existing hiringcafe TSVs
      [--dry-run]
"""

import argparse
import datetime as _dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

import discovery_filters as df


FLARESOLVERR_URL = os.environ.get("HIRINGCAFE_FLARESOLVER_URL", "http://localhost:8191/v1")
HOMEPAGE = "https://hiring.cafe/"


def _post_json(url, payload, timeout=120):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def flaresolverr_session():
    """Return (cookies_header, user_agent, build_id) or None if FlareSolverr unreachable / failed."""
    try:
        payload = {"cmd": "request.get", "url": HOMEPAGE, "maxTimeout": 90000}
        resp = _post_json(FLARESOLVERR_URL, payload, timeout=120)
    except (urllib.error.URLError, ConnectionRefusedError, TimeoutError, OSError) as exc:
        print(f"  flaresolverr unreachable at {FLARESOLVERR_URL} ({exc.__class__.__name__})", file=sys.stderr)
        return None
    except json.JSONDecodeError as exc:
        print(f"  flaresolverr returned non-JSON: {exc}", file=sys.stderr)
        return None
    if resp.get("status") != "ok":
        print(f"  flaresolverr error: {resp.get('message','?')}", file=sys.stderr)
        return None
    sol = resp.get("solution") or {}
    body = sol.get("response", "")
    m = re.search(r'"buildId":"([^"]+)"', body)
    if not m:
        print("  flaresolverr could not extract buildId from solved page", file=sys.stderr)
        return None
    build_id = m.group(1)
    cookies = sol.get("cookies") or []
    cookie_header = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
    user_agent = sol.get("userAgent") or ""
    return cookie_header, user_agent, build_id


def fetch_pages_via_urllib(cookie_header, user_agent, build_id, keywords, max_pages_per_query):
    """Iterate (keyword, page) and collect raw hits using cf_clearance cookies.

    Per-query endpoint: /_next/data/{build_id}/index.json?searchState={json}&page={N}
    searchState is a URL-encoded JSON object with key `searchQuery` (free text).
    """
    results = []
    total = len(keywords)
    sweep = 0
    for kw in keywords:
        sweep += 1
        label = f"[{sweep}/{total}] {kw!r}"
        page_rows = 0
        for page in range(max_pages_per_query):
            search_state = urllib.parse.quote(json.dumps({"searchQuery": kw}))
            url = (
                f"https://hiring.cafe/_next/data/{build_id}/index.json"
                f"?searchState={search_state}&page={page}"
            )
            req = urllib.request.Request(url, headers={
                "User-Agent": user_agent,
                "Accept": "*/*",
                "Cookie": cookie_header,
                "Referer": HOMEPAGE,
                "x-nextjs-data": "1",
            })
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    body = r.read().decode("utf-8", errors="replace")
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    break
                print(f"  {label} page {page}: HTTP {exc.code}", file=sys.stderr)
                break
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                print(f"  {label} page {page}: non-JSON response (CF cookie may have expired)", file=sys.stderr)
                break
            pp = data.get("pageProps") or {}
            hits = pp.get("ssrHits") or []
            if not hits:
                break
            results.append({"keyword": kw, "page": page, "hits": hits})
            page_rows += len(hits)
            if pp.get("ssrIsLastPage"):
                break
        print(f"  {label}: {page_rows} raw rows", file=sys.stderr)
    return results


DEFAULT_KEYWORDS = (
    "software engineer intern,"
    "machine learning intern,"
    "data science intern,"
    "ai engineer intern,"
    "data engineer intern,"
    "backend engineer intern,"
    # Broader catch-alls. The post-fetch _is_internship_per_source filter
    # drops non-internship rows, so we can afford generic queries that
    # surface rows missed by the role-specific ones above.
    "intern,"
    "internship,"
    "summer 2026 internship"
)


# Inline Playwright runner. Solves the Cloudflare managed challenge by
# navigating the homepage with a realistic Chromium context, then reuses the
# CF clearance cookies to fetch JSON pages via page.evaluate(fetch).
NODE_SCRAPER = r"""
// rebrowser-playwright = Playwright fork with CDP-detection patches that CF
// Turnstile uses to fingerprint headless Chromium. Drop-in replacement for
// 'playwright'. Skip playwright-extra stealth here because rebrowser's CDP
// patches handle the same surface and stealth's init scripts conflict with
// the patched Runtime.evaluate flow.
import { chromium } from 'rebrowser-playwright';

// Cloudflare's interactive challenge fingerprints headless Chrome reliably,
// so we launch a *persistent context* with a real user-data-dir + headed=false
// only as a last resort: HEADFUL Chrome via channel:'chrome' passes the
// managed challenge ~95% of the time within 8s. The user-data-dir persists
// the cf_clearance cookie across runs so subsequent invocations skip the
// challenge entirely.
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const userDataDir = path.join(os.homedir(), '.cache', 'career-ops', 'hiringcafe-chrome');
fs.mkdirSync(userDataDir, { recursive: true });
const isHeaded = process.env.HIRINGCAFE_HEADED === '1';

const ctxOpts = {
  headless: !isHeaded,
  channel: 'chrome',
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-sandbox',
  ],
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 900 },
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
  extraHTTPHeaders: {
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="126", "Not(A:Brand";v="8", "Google Chrome";v="126"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  },
};
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, ctxOpts);
} catch (e) {
  process.stderr.write(`  chrome channel unavailable (${(e.message || '').split('\n')[0]}), falling back to bundled chromium\n`);
  delete ctxOpts.channel;
  ctx = await chromium.launchPersistentContext(userDataDir, ctxOpts);
}
const browser = ctx.browser();
// rebrowser handles navigator.webdriver et al at the protocol level; no
// addInitScript() needed (and it would conflict with their patched runtime).
const page = ctx.pages()[0] || await ctx.newPage();

const keywords = JSON.parse(process.env.KEYWORDS);
const maxPages = parseInt(process.env.MAX_PAGES_PER_QUERY || '4', 10);

async function waitForChallenge(maxMs = 30000) {
  const start = Date.now();
  let lastTitle = '';
  while (Date.now() - start < maxMs) {
    const title = await page.title().catch(() => '');
    if (title !== lastTitle) {
      process.stderr.write(`  [${Math.round((Date.now()-start)/1000)}s] title=${JSON.stringify(title)}\n`);
      lastTitle = title;
    }
    if (!/just a moment|checking your browser|attention required/i.test(title)) {
      const buildId = await page.evaluate(() => {
        const m = (document.documentElement.outerHTML || '').match(/"buildId":"([^"]+)"/);
        return m ? m[1] : null;
      }).catch(() => null);
      if (buildId) return buildId;
    }
    await page.waitForTimeout(1500);
  }
  return null;
}

process.stderr.write('  navigating homepage...\n');
await page.goto('https://hiring.cafe/', { waitUntil: 'domcontentloaded', timeout: 60000 });
// First wait: short, in case persistent cookie already cleared the challenge.
let buildId = await waitForChallenge(8000);
// Second wait: longer, in case CF resolves managed challenge automatically.
// rebrowser-playwright's CDP patches give us a real shot at headless auto-pass.
if (!buildId) buildId = await waitForChallenge(isHeaded ? 60000 : 45000);
if (!buildId) {
  const snippet = await page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 400)).catch(() => '');
  const ttl = await page.title().catch(() => '');
  const isTurnstile = /verifying you are human|just a moment|checking your browser/i.test(snippet) || /just a moment/i.test(ttl);
  if (isTurnstile) {
    process.stderr.write('  hiring.cafe Cloudflare Turnstile blocked automated access.\n');
    process.stderr.write('  Manual unblock: re-run with HIRINGCAFE_HEADED=1 and click the Turnstile checkbox once.\n');
    process.stderr.write('  Cached clearance cookie at ~/.cache/career-ops/hiringcafe-chrome lasts ~30min.\n');
  } else {
    process.stderr.write(`error: CF challenge not resolved. final title=${JSON.stringify(ttl)} body[:400]=${JSON.stringify(snippet)}\n`);
  }
  await ctx.close();
  if (browser) await browser.close().catch(() => {});
  process.exit(2);
}
process.stderr.write(`  buildId: ${buildId}\n`);

async function fetchJson(url) {
  return await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include', headers: { 'Accept': '*/*' } });
    if (!res.ok) return { _status: res.status };
    const text = await res.text();
    try { return { _status: 200, json: JSON.parse(text) }; } catch (e) { return { _status: 200, _raw: text.slice(0, 200) }; }
  }, url);
}

const results = [];
let sweepIdx = 0;
const total = keywords.length;
for (const kw of keywords) {
  sweepIdx++;
  const label = `[${sweepIdx}/${total}] ${JSON.stringify(kw)}`;
  let pageRows = 0;
  for (let p = 0; p < maxPages; p++) {
    const searchState = encodeURIComponent(JSON.stringify({ searchQuery: kw }));
    const url = `https://hiring.cafe/_next/data/${buildId}/index.json?searchState=${searchState}&page=${p}`;
    let resp;
    try {
      resp = await fetchJson(url);
    } catch (e) {
      process.stderr.write(`  ${label} page ${p}: fetch error ${e.message}\n`);
      break;
    }
    if (!resp || resp._status === 404) break;
    if (resp._status !== 200 || !resp.json) {
      process.stderr.write(`  ${label} page ${p}: http ${resp._status || '?'}\n`);
      break;
    }
    const pp = resp.json.pageProps || {};
    const hits = pp.ssrHits || [];
    if (!hits.length) break;
    results.push({ keyword: kw, page: p, hits });
    pageRows += hits.length;
    if (pp.ssrIsLastPage) break;
  }
  process.stderr.write(`  ${label}: ${pageRows} raw rows\n`);
  await page.waitForTimeout(800);
}

process.stdout.write(JSON.stringify({ build_id: buildId, results }));
await ctx.close();
if (browser) await browser.close().catch(() => {});
"""


def normalize_hit(hit):
    """Convert one Hiring Cafe hit to discovery_filters row schema."""
    v5 = hit.get("v5_processed_job_data") or {}
    ji = hit.get("job_information") or {}
    company = v5.get("company_name") or ji.get("company_name") or ""
    title = v5.get("core_job_title") or ji.get("title") or ji.get("job_title_raw") or ""
    url = hit.get("apply_url") or ""

    # Compose location string for filter compatibility.
    loc = v5.get("formatted_workplace_location") or ""
    if not loc:
        cities = v5.get("workplace_cities") or []
        states = v5.get("workplace_states") or []
        countries = v5.get("workplace_countries") or []
        loc = ", ".join(filter(None, [", ".join(cities), ", ".join(states), ", ".join(countries)]))

    # Workplace type: Remote / Hybrid / Onsite
    workplace_type = v5.get("workplace_type") or ""
    is_remote = "remote" in workplace_type.lower()

    # Age from estimated_publish_date (ISO 8601).
    age_days = None
    pub = v5.get("estimated_publish_date") or ""
    if pub:
        try:
            published = _dt.datetime.fromisoformat(pub.replace("Z", "+00:00")).date()
            age_days = (_dt.date.today() - published).days
            if age_days < 0:
                age_days = 0
        except (ValueError, TypeError):
            age_days = None

    # Compensation summary for Notes extras
    comp = ""
    freq = v5.get("listed_compensation_frequency") or ""
    if freq.lower() == "hourly":
        lo, hi = v5.get("hourly_min_compensation"), v5.get("hourly_max_compensation")
        if lo or hi:
            comp = f"${lo or hi}-${hi or lo}/hr"
    elif freq.lower() == "yearly":
        lo, hi = v5.get("yearly_min_compensation"), v5.get("yearly_max_compensation")
        if lo or hi:
            comp = f"${lo or hi}k-${hi or lo}k/yr"

    sec_clearance = v5.get("security_clearance")  # str or None
    commitment = v5.get("commitment") or []
    is_internship = any("intern" in str(c).lower() for c in commitment) or "intern" in title.lower()

    return {
        "title": title,
        "company": company,
        "url": url,
        "location": loc,
        "is_remote": is_remote,
        "age_days": age_days,
        "site": "hiringcafe",
        # Source-specific extras (passed through emit_tsv `extras`):
        "_sponsorship": v5.get("visa_sponsorship"),  # True/False/None
        "_comp": comp,
        "_workplace_type": workplace_type,
        "_security_clearance": sec_clearance,
        "_commitment": commitment,
        "_is_internship_per_source": is_internship,
    }


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--keyword", default=DEFAULT_KEYWORDS, help="comma-separated free-text search queries")
    p.add_argument("--max-pages-per-query", type=int, default=4, help="paginate up to N pages per keyword (47-103 hits/page)")
    p.add_argument("--max-age-days", type=int, default=df.MAX_AGE_DAYS_DEFAULT)
    p.add_argument("--no-clean", action="store_true")
    p.add_argument("--no-tracker-dedup", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)

    keywords = [k.strip() for k in args.keyword.split(",") if k.strip()]
    today_iso = _dt.date.today().isoformat()

    print(f"# hiringcafe-ingest run {today_iso}", file=sys.stderr)
    print(f"  keywords ({len(keywords)}): {keywords}", file=sys.stderr)
    print(f"  max pages per query: {args.max_pages_per_query}", file=sys.stderr)

    # Clean stale hiringcafe TSVs.
    if not args.dry_run and df.BATCH_DIR.exists() and not args.no_clean:
        cleared = sum(1 for f in df.BATCH_DIR.glob("*-hiringcafe.tsv"))
        for f in df.BATCH_DIR.glob("*-hiringcafe.tsv"):
            f.unlink()
        if cleared:
            print(f"  cleared {cleared} stale hiringcafe TSVs (use --no-clean to keep them)", file=sys.stderr)
    elif args.no_clean:
        print("  --no-clean: preserving existing hiringcafe TSVs", file=sys.stderr)

    # Tracker dedup signatures.
    if args.no_tracker_dedup:
        existing_urls, existing_fps = set(), set()
        print("  skipping tracker dedup (--no-tracker-dedup)", file=sys.stderr)
    else:
        existing_urls, existing_fps = df.collect_existing_signatures()
        print(f"  tracker baseline: {len(existing_urls)} URLs, {len(existing_fps)} fingerprints", file=sys.stderr)

    # ---- Fetch path 1: FlareSolverr (preferred; ~1s/page after CF solve) ----
    session = flaresolverr_session()
    raw_rows = []
    if session is not None:
        cookie_header, user_agent, build_id = session
        print(f"  flaresolverr ok. buildId: {build_id}", file=sys.stderr)
        page_results = fetch_pages_via_urllib(
            cookie_header, user_agent, build_id, keywords, args.max_pages_per_query
        )
        for entry in page_results:
            for h in entry.get("hits", []):
                raw_rows.append(normalize_hit(h))
    else:
        # ---- Fetch path 2: Playwright fallback (headed only - headless never resolves Turnstile) ----
        print("  flaresolverr unavailable; falling back to Playwright (headed mode needed)", file=sys.stderr)
        runner_path = df.CAREER_OPS / "scripts" / "_hiringcafe_runner.mjs"
        runner_path.write_text(NODE_SCRAPER)
        env = os.environ.copy()
        env["KEYWORDS"] = json.dumps(keywords)
        env["MAX_PAGES_PER_QUERY"] = str(args.max_pages_per_query)
        try:
            proc = subprocess.run(
                ["node", str(runner_path)],
                cwd=str(df.CAREER_OPS),
                capture_output=True,
                text=True,
                timeout=600,
                env=env,
            )
        except subprocess.TimeoutExpired:
            print("error: hiringcafe Playwright runner timed out after 600s", file=sys.stderr)
            runner_path.unlink(missing_ok=True)
            return 1
        if proc.stderr:
            sys.stderr.write(proc.stderr)
        runner_path.unlink(missing_ok=True)
        if proc.returncode == 2:
            print(
                "  source unavailable (Cloudflare Turnstile blocked both FlareSolverr and Playwright).\n"
                "  Start FlareSolverr: docker run -d --name flaresolverr -p 8191:8191 --restart unless-stopped ghcr.io/flaresolverr/flaresolverr:latest\n"
                "  OR re-run with HIRINGCAFE_HEADED=1 + manual checkbox click.",
                file=sys.stderr,
            )
            return 2
        if proc.returncode != 0:
            print(f"error: hiringcafe runner exited {proc.returncode}", file=sys.stderr)
            return 1
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            print(f"error: runner returned non-JSON: {exc}", file=sys.stderr)
            return 1
        for entry in payload.get("results", []):
            for h in entry.get("hits", []):
                raw_rows.append(normalize_hit(h))

    if not raw_rows:
        print("  no rows returned", file=sys.stderr)
        return 0
    print(f"  total raw rows: {len(raw_rows)}", file=sys.stderr)

    # Pre-filter: only keep rows the source itself flagged as Internship
    # commitment (Hiring Cafe surfaces both Internship and Full Time even
    # under intern-keyword queries because it's title-level matching).
    pre = len(raw_rows)
    raw_rows = [r for r in raw_rows if r.get("_is_internship_per_source")]
    print(f"  after source-side internship-commitment filter: {len(raw_rows)} (dropped {pre - len(raw_rows)})", file=sys.stderr)

    # Canonical filter chain.
    kept, drops = df.apply_unified_filter(
        raw_rows,
        source_tag="hiringcafe",
        max_age_days=args.max_age_days,
        existing_urls=existing_urls,
        existing_fps=existing_fps,
    )
    print(f"  drops: {drops}", file=sys.stderr)
    print(f"  kept after unified filter: {len(kept)}", file=sys.stderr)

    sponsorship_yes = sum(1 for r in kept if r.get("_sponsorship") is True)
    sponsorship_no = sum(1 for r in kept if r.get("_sponsorship") is False)
    print(f"  visa-sponsorship breakdown: yes={sponsorship_yes}, no={sponsorship_no}, unknown={len(kept) - sponsorship_yes - sponsorship_no}", file=sys.stderr)

    start_nn = df.next_available_nn()
    print(f"  starting NN: {start_nn}", file=sys.stderr)

    written = []
    for offset, row in enumerate(kept):
        num = start_nn + offset
        extras = {}
        if row.get("_comp"):
            extras["comp"] = row["_comp"]
        if row.get("_workplace_type"):
            extras["workplace"] = row["_workplace_type"]
        if row.get("_security_clearance") and "none" not in str(row["_security_clearance"]).lower():
            extras["clearance"] = row["_security_clearance"]
        path, _line = df.emit_tsv(
            num=num,
            date=today_iso,
            company=row["company"],
            role=row["title"],
            url=row["url"],
            source="hiringcafe",
            age_days=row.get("age_days"),
            suffix="hiringcafe",
            sponsorship=row.get("_sponsorship"),
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
