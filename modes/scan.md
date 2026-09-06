# Mode: scan — Portal Scanner (Discovery + Inline Evaluation)

Scans configured job portals, filters by title relevance, and **evaluates every new posting immediately** (no triage state).

> **Data-dir note:** All `data/`, `reports/`, and `batch/` paths in this file resolve under `$CAREER_OPS_DATA_DIR`, default `ft/` (the live FT funnel). `data/scan-results-*.tsv` means `ft/data/scan-results-*.tsv`, `reports/{company-slug}/...` means `ft/reports/...`, `batch/tracker-additions/` means `ft/batch/tracker-additions/`. Engines resolve this via `lib/paths.mjs` / `scripts/_paths.py`. This mode loads standalone (without `_shared.md`), so the convention is restated here.

> **HARD OVERRIDE for Anmol's workspace (CLAUDE.md Rule 7):** Scan and evaluation can run together OR separately. There is no `data/pipeline.md` triage inbox. After `scan.mjs` writes `ft/data/scan-results-{YYYY-MM-DD}.tsv`, the skill workflow has two valid completion modes: **(default, inline)** immediately evaluate every row through auto-pipeline (parallel agents) and DELETE the TSV before returning; **(scan-only mode, when invoked as `/career-ops scan scan-only`)** stop after the title-level filter, report counts, and leave the TSV on disk for a later invocation to consume. In split mode, the next `/career-ops` invocation MUST detect any pre-existing `ft/data/scan-results-*.tsv` files and run the inline-evaluation pass against them before doing anything else; that pass is what deletes the TSV. The scan workflow is not complete until every candidate has either an eval report or an explicit drop reason logged in `ft/data/scan-history.tsv`. The Spanish "pipeline.md / Pendientes" steps below are SUPERSEDED. Read them as historical/upstream context only.

> **Note (v1.5+):** The default scanner (`scan.mjs` / `npm run scan`) is **zero-token** and only queries the public Greenhouse, Ashby, and Lever APIs directly. The Playwright/WebSearch levels described below are the **agent** flow (executed by Claude/Codex), not what `scan.mjs` does. If a company has no Greenhouse/Ashby/Lever API, `scan.mjs` will ignore it; for those cases the agent must manually complete Level 1 (Playwright) or Level 3 (WebSearch).

## Sources (FT pivot, 2026-06-08)

A full `/career-ops scan` runs each ACTIVE source below. All write into `$CAREER_OPS_DATA_DIR` (default `ft/`). Run in order; each appends candidates to `ft/data/scan-results-{date}.tsv`.

| Source | Command | Notes |
|--------|---------|-------|
| ATS APIs (Greenhouse/Ashby/Lever/BambooHR/Teamtailor/Workday) | `node scan.mjs` | Zero-token HTTP+JSON |
| SPA / Cloudflare boards (Workable, custom careers) | `node scan-spa.mjs` | Shared-Chromium Playwright |
| freehire.me (~50 ATS platforms, public JSON API) | `node scan-freehire.mjs` | Zero-token HTTP+JSON. Best-effort third party (no SLA); an outage degrades this source only. `FREEHIRE_API_URL` points at a self-hosted instance. |
| GitHub aggregators (8 new-grad / H-1B repos) | `python3 scripts/aggregator-intake.py` | Captures sponsorship emojis: VISA-SPONSORSHIP vs CITIZEN-ONLY |
| JobSpy (Indeed / LinkedIn / ZipRecruiter / Glassdoor) | `python3 scripts/jobspy-ingest.py` | JobSpy 1.1.82 installed |
| Adzuna | `python3 scripts/adzuna-ingest.py` | Keys in gitignored `.env` or process env; writes `jd_snippet:` |
| Hiring Cafe | `python3 scripts/hiringcafe-ingest.py` | Needs FlareSolverr on `localhost:8191` |
| HN "Who is hiring" | `python3 scripts/hn-hiring-ingest.py` | Monthly thread parse |
| H1BGrader (sponsorship lookup) | `python3 scripts/h1bgrader_lookup.py` | Needs FlareSolverr on `localhost:8191` |

**DISABLED (deferred, FT surface URLs unverified, do NOT run):**
- `scripts/yc-ingest.py`
- `scripts/levels-ingest.py`
- `scripts/startupjobs-ingest.py`

**OPT-IN, NOT part of a full scan (`node scan-linkedin.mjs`):** the LinkedIn public
`jobs-guest` scanner. Automated access to LinkedIn is against their Terms of Service, so
this one is the user's call: it refuses to run until `linkedin_guest.enabled: true` is set
in `portals.yml`, and `/career-ops scan` must NEVER invoke it on its own. Two caveats when
it is enabled: keep `pages` small (volume is the whole risk), and every row it produces is a
`linkedin.com/jobs/view/{id}` **mirror** URL, not the employer's req page — the eval agent
must resolve the real apply URL from the LinkedIn page before scoring and stamp
`LINKEDIN-MIRROR` in Notes. The zero-exposure alternative is `node linkedin-hiring-searches.mjs`,
which only generates search URLs for the user to click.

## Recommended execution

Run as a subagent to avoid consuming main-session context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contents of this file + task-specific data]",
    run_in_background=True
)
```

## Configuration

Read `portals.yml`, which contains:
- `search_queries`: List of WebSearch queries with `site:` filters per portal (broad discovery)
- `tracked_companies`: Specific companies with `careers_url` for direct navigation
- `title_filter`: Positive/negative/seniority_boost keywords for title filtering

## Discovery strategy (3 levels)

### Level 1 — Direct Playwright (PRIMARY)

**For each company in `tracked_companies`:** Navigate to its `careers_url` with Playwright (`browser_navigate` + `browser_snapshot`), read ALL visible job listings, and extract the title + URL of each one. This is the most reliable method because:
- It sees the page in real time (no cached Google results)
- It works with SPAs (Ashby, Lever, Workday)
- It detects new postings instantly
- It does not depend on Google indexing

**Every company MUST have `careers_url` in portals.yml.** If it is missing, look it up once, save it, and use it in future scans.

### Level 2 — ATS APIs / Feeds (COMPLEMENTARY)

For companies with a public API or structured feed, use the JSON/XML response as a fast complement to Level 1. It is faster than Playwright and reduces visual-scraping errors.

**Current support (variables in `{}`):**
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby**: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR**: list `https://{company}.bamboohr.com/careers/list`; single-posting detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever**: `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor**: `https://{company}.teamtailor.com/jobs.rss`
- **Workday**: `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Parsing convention per provider:**
- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` with `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; build the public URL if it is not in the payload)
- `bamboohr`: list `result[]` → `jobOpeningName`, `id`; build the detail URL `https://{company}.bamboohr.com/careers/{id}/detail`; to read the full JD, GET the detail and use `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: root array `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`
- `workday`: `jobPostings[]`/`jobPostings` (depending on tenant) → `title`, `externalPath` or a URL built from the host

### Level 3 — WebSearch queries (BROAD DISCOVERY)

The `search_queries` with `site:` filters cover portals cross-sectionally (all Ashby boards, all Greenhouse boards, etc.). Useful for discovering NEW companies not yet in `tracked_companies`, but the results can be stale.

**Execution priority:**
1. Level 1: Playwright → all `tracked_companies` with `careers_url`
2. Level 2: API → all `tracked_companies` with `api:`
3. Level 3: WebSearch → all `search_queries` with `enabled: true`

The levels are additive — all of them run, and the results are merged and deduplicated.

## Workflow

1. **Read configuration**: `portals.yml`
2. **Read history**: `ft/data/scan-history.tsv` → URLs already seen
3. **Read dedup source**: `ft/data/applications.md` (no pipeline.md; triage state eliminated per Anmol's no-triage-state rule)

4. **Level 1 — Playwright scan** (parallel in batches of 3-5):
   For each company in `tracked_companies` with `enabled: true` and a defined `careers_url`:
   a. `browser_navigate` to the `careers_url`
   b. `browser_snapshot` to read all job listings
   c. If the page has filters/departments, navigate the relevant sections
   d. For each job listing extract: `{title, url, company}`
   e. If the page paginates results, navigate additional pages
   f. Accumulate into the candidate list
   g. If `careers_url` fails (404, redirect), try `scan_query` as a fallback and note it so the URL gets updated

5. **Level 2 — ATS APIs / feeds** (parallel):
   For each company in `tracked_companies` with `api:` defined and `enabled: true`:
   a. WebFetch the API/feed URL
   b. If `api_provider` is defined, use its parser; if not defined, infer from the domain (`boards-api.greenhouse.io`, `jobs.ashbyhq.com`, `api.lever.co`, `*.bamboohr.com`, `*.teamtailor.com`, `*.myworkdayjobs.com`)
   c. For **Ashby**, send a POST with:
      - `operationName: ApiJobBoardWithTeams`
      - `variables.organizationHostedJobsPageName: {company}`
      - GraphQL query for `jobBoardWithTeams` + `jobPostings { id title locationName employmentType compensationTierSummary }`
   d. For **BambooHR**, the list only carries basic metadata. For each relevant item, read `id`, GET `https://{company}.bamboohr.com/careers/{id}/detail`, and extract the full JD from `result.jobOpening`. Use `jobOpeningShareUrl` as the public URL if present; otherwise use the detail URL.
   e. For **Workday**, send a JSON POST with at least `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` and paginate by `offset` until results are exhausted
   f. For each job extract and normalize: `{title, url, company}`
   g. Accumulate into the candidate list (dedup against Level 1)

6. **Level 3 — WebSearch queries** (parallel if possible):
   For each query in `search_queries` with `enabled: true`:
   a. Run WebSearch with the defined `query`
   b. From each result extract: `{title, url, company}`
      - **title**: from the result title (before the " @ " or " | ")
      - **url**: the result URL
      - **company**: after the " @ " in the title, or extract from the domain/path
   c. Accumulate into the candidate list (dedup against Levels 1+2)

6. **Filter by title** using `title_filter` from `portals.yml`:
   - At least 1 `positive` keyword must appear in the title (case-insensitive)
   - 0 `negative` keywords may appear
   - `seniority_boost` keywords give priority but are not required

7. **Deduplicate** against 2 sources:
   - `scan-history.tsv` → exact URL already seen
   - `applications.md` → normalized company + role already evaluated

7.5. **Verify liveness of WebSearch results (Level 3)** — BEFORE adding to the pipeline:

   WebSearch results can be stale (Google caches results for weeks or months). To avoid evaluating expired postings, verify every new URL coming from Level 3 with Playwright. Levels 1 and 2 are inherently real-time and do not require this verification.

   For each new Level 3 URL (parallel OK — see [_shared.md](_shared.md) Playwright entry; preferred pattern is one shared Chromium with N concurrent pages, e.g. [liveness-parallel.mjs](../liveness-parallel.mjs) at CONCURRENCY=20):
   a. `browser_navigate` to the URL
   b. `browser_snapshot` to read the content
   c. Classify:
      - **Active**: visible job title + role description + visible Apply/Submit/Solicitar control within the main content. Do not count generic header/navbar/footer text.
      - **Expired** (any of these signals):
        - Final URL contains `?error=true` (Greenhouse redirects like this when the posting is closed)
        - Page contains: "job no longer available" / "no longer open" / "position has been filled" / "this job has expired" / "page not found"
        - Only navbar and footer visible, no JD content (content < ~300 chars)
   d. If expired: log in `scan-history.tsv` with status `skipped_expired` and discard
   e. If active: continue to step 8

   **Do not interrupt the whole scan if one URL fails.** If `browser_navigate` errors (timeout, 403, etc.), mark it `skipped_expired` and continue with the next one.

8. **For each verified new posting that passes filters (Anmol's workspace — no-triage rule):**
   a. Log in `ft/data/scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`
   b. Accumulate into `ft/data/scan-results-{date}.tsv` (transient; consumed in step 12)
   c. **DO NOT write to `data/pipeline.md`** — it does not exist as a triage queue.

12. **Evaluation pass — REQUIRED in default mode, SKIPPED in `scan-only` mode:**
    > **Mode check.** If invoked as `/career-ops scan scan-only` (or any equivalent split-mode flag the user passed), STOP here: report `{date}.tsv` row count + which company/role buckets, surface the TSV path, and exit. Do NOT dispatch eval agents and do NOT delete the TSV. Otherwise continue with steps a-h below to complete inline evaluation.
    a. Read `ft/data/scan-results-{date}.tsv`, the list of N new candidates with title-level filter applied. (In split-mode resume, also pick up any older `ft/data/scan-results-*.tsv` files left from prior scan-only invocations and process them in the same pass.)
    b. Apply a second title-level filter to drop obvious non-targets (intern/co-op/apprentice — the FT search targets new-grad full-time only — plus sales/GTM/marketing/HR/legal/finance/senior/staff/principal/non-target geo) without writing per-URL eval reports. Log dropped rows in `scan-history.tsv` with status `skipped_filter` and a one-line reason.
    c. **Liveness gate (MANDATORY HARD GATE, no eval agent may be dispatched until this has run and every expired URL is dropped).** Run `npm run liveness:bulk -- /tmp/scan-urls.txt /tmp/scan-liveness.tsv` over the surviving URLs (zero Claude tokens, ~2-5 min for hundreds of URLs at CONCURRENCY=20). For results classified `expired` (HTTP 404/410, "no longer available", nav-error, JS-only empty page): drop the URL with `scan-history.tsv` status `skipped_expired` and **do NOT dispatch an eval agent**. For results `uncertain` (typically iCIMS/Workday SPAs whose apply iframe didn't render): keep the URL but flag the resulting tracker row with `LIVENESS-UNCERTAIN {date}.` prefix in the Notes column. This typically saves 25-35% of agent compute by short-circuiting dead URLs before WebFetch retries blow time on them. Empirical baseline (2026-05-04): 742 URLs → 530 active, 157 expired, 55 uncertain in 212s wall time.
    d. For surviving candidates, dispatch parallel evaluation agents (one batch per ~5 URLs). Each agent runs the full auto-pipeline per URL: fetch the JD → write the full Block A-G report to `ft/reports/{company-slug}/{NN}-{role-slug}-{date}.md` with a `**URL:**` header → write a 9-column tracker line to `ft/batch/tracker-additions/{NN}.tsv`. **Pass each URL's `source` value (from the scan-results TSV) into its agent's prompt, and require the agent to end the row's Notes with `SRC: {source}` using the CANONICAL id, not the feed's raw label** (`linkedin` must be written as `jobspy-linkedin`; see `lib/sources.mjs`) — see Step 5 of `modes/auto-pipeline.md`. Without it the row lands unattributed and `source-analytics.mjs` counts it as `unknown`.

       **JD-snippet shortcut (Adzuna and other API-aggregator sources).** If the candidate row's Notes column carries a `jd_snippet:` field (the source API's ~500-char description, written at ingest time by `scripts/adzuna-ingest.py` and other adapters), use the snippet as the primary JD source for scoring. Adzuna in particular rate-limits the detail-page URL (`adzuna.com/details/{id}`) when N parallel eval agents WebFetch it simultaneously → HTTP 429 → eval falls back to title-only and flags `JD-FETCH-UNCERTAIN`. The snippet is sufficient for A-F scoring; WebFetch only if the snippet is empty or the role looks borderline and you want fuller context. Never fail the eval on 429: the snippet is the authoritative summary.
    e. Pre-allocate sequential `NN` numbers from `max(ft/data/applications.md ID, ft/reports/ NN prefix) + 1`. Read the FT tracker and `ft/reports/`, NOT the frozen intern archive at the repo root.
    f. After all agents complete, merge `ft/batch/tracker-additions/*.tsv` into `ft/data/applications.md` and run `node verify-pipeline.mjs` for schema integrity.
    g. Delete `ft/data/scan-results-{date}.tsv` (transient, consumed).
    h. The scan is complete only when every row in the original TSV has either an eval report (Evaluated/SKIP), a `skipped_filter` log line, or a `skipped_expired` log line.

### Liveness gate cheat sheet (post-aggregator and post-merge)

```bash
# After aggregator-intake.py writes placeholder TSVs, before dispatching evals:
npm run liveness:batch /tmp/liveness-results.tsv
python3 scripts/prune-by-liveness.py

# Periodically (recommended weekly) to keep applications.md clean:
npm run liveness:batch /tmp/liveness-results.tsv
python3 scripts/prune-by-liveness.py    # marks dead evaluated rows as Purged
```

9. **Postings filtered out by title**: log in `scan-history.tsv` with status `skipped_title`
10. **Duplicate postings**: log with status `skipped_dup`
11. **Expired postings (Level 3)**: log with status `skipped_expired`

## Title and company extraction from WebSearch results

WebSearch results come in the format: `"Job Title @ Company"` or `"Job Title | Company"` or `"Job Title — Company"`.

Extraction patterns per portal:
- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title: `Senior AI PM`, company: `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title: `AI Engineer`, company: `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title: `Product Manager - AI`, company: `Temporal`

Generic regex: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## Private URLs

If a URL is found that is not publicly accessible:
1. Save the JD to `jds/{company}-{role-slug}.md`
2. Anmol's workspace: add a row to `ft/data/scan-results-{date}.tsv` with `url=local:jds/{company}-{role-slug}.md` so the inline evaluation reads it from disk. Do NOT write to `pipeline.md` (it does not exist).

## Scan History

`data/scan-history.tsv` tracks ALL seen URLs:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Output summary

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Queries executed: N
Postings found: N total
Title-filtered: N relevant
Duplicates: N (already evaluated or in pipeline)
Expired discarded: N (dead links, Level 3)
New candidates: N written to ft/data/scan-results-{date}.tsv

  + {company} | {title} | {query_name}
  ...

→ Anmol's workspace: in default mode, continue to step 12 (evaluation pass) — every row in scan-results-{date}.tsv must be evaluated and the TSV deleted before the scan is complete. In `scan-only` mode, stop here and leave the TSV on disk for a follow-up `/career-ops` invocation to consume.
```

## careers_url management

Every company in `tracked_companies` must have `careers_url` — the direct URL to its jobs page. This avoids looking it up every time.

**RULE: Always use the company's corporate URL; fall back to the ATS endpoint only if no dedicated corporate careers page exists.**

The `careers_url` should point to the company's own careers page whenever one is available. Many companies use Workday, Greenhouse, or Lever underneath, but expose the job IDs only through their corporate domain. Using the direct ATS URL when a corporate page exists can cause false 410 errors because the job IDs do not match.

| ✅ Correct (corporate) | ❌ Wrong as first choice (direct ATS) |
|---|---|
| `https://careers.mastercard.com` | `https://mastercard.wd1.myworkdayjobs.com` |
| `https://openai.com/careers` | `https://job-boards.greenhouse.io/openai` |
| `https://stripe.com/jobs` | `https://jobs.lever.co/stripe` |

Fallback: if you only have the direct ATS URL, navigate to the company's website first and locate its corporate careers page. Use the direct ATS URL only if the company has no dedicated corporate careers page.

**Known patterns per platform:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` or `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** The company's own URL (e.g. `https://openai.com/careers`)

**API/feed patterns per platform:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**If `careers_url` does not exist** for a company:
1. Try its known platform pattern
2. If that fails, do a quick WebSearch: `"{company}" careers jobs`
3. Navigate with Playwright to confirm it works
4. **Save the found URL to portals.yml** for future scans

**If `careers_url` returns a 404 or redirect:**
1. Note it in the output summary
2. Try scan_query as a fallback
3. Flag for manual update

## portals.yml maintenance

- **ALWAYS save `careers_url`** when adding a new company
- Add new queries as interesting portals or roles are discovered
- Disable queries with `enabled: false` if they generate too much noise
- Adjust filter keywords as target roles evolve
- Add companies to `tracked_companies` when they are worth following closely
- Verify `careers_url` periodically — companies change ATS platforms
