# Architecture

End-to-end data flow for Anmol's Summer 2026 internship pipeline.

## High-level

```
                    DISCOVERY                 LIVENESS GATE       EVALUATION               TRACKING
     ┌──────────────────────────────┐    ┌─────────────────┐ ┌──────────────────┐   ┌──────────────────┐
     │  Aggregators (4 GitHub READMEs)│  │ liveness-       │ │ Auto-pipeline    │   │ data/applications.md │
     │  jobspy-ingest (LinkedIn/Indeed)│ │ parallel.mjs    │ │ per-URL agent    │   │ (9-col tracker)      │
     │  scan.mjs (Greenhouse/Ashby/  │──→│ (Playwright,    │→│ A-G scoring      │──→│                      │
     │           Lever APIs)          │   │ parallel,       │ │ Playwright +     │   │ reports/{slug}/      │
     │  WebSearch (39 portal queries) │   │ zero tokens)    │ │ WebSearch        │   │ {NN}-*.md            │
     │  Playwright (no-API careers)   │   │                 │ │ fallback for SPAs│   │                      │
     │  Manual paste (URL or JD)      │   │ prune-by-       │ │ writes report +  │   │                      │
     └──────────────────────────────┘    │ liveness.py     │ │ overwrites TSV   │   │                      │
                       │                  └─────────────────┘ └──────────────────┘   └──────────────────┘
                       │                          │                    ↑                     ↑
                       │  batch/tracker-          │ deletes expired    │  merge-tracker.mjs  │
                       └──────additions/*.tsv ────┴────────────────────┘                     │
                          (placeholder rows from any source)                                 │
                                                                                             │
                                                Go TUI dashboard ────────────────────────────┘
                                                (read + cover-letter trigger)
```

The pipeline has four stages: **discovery** (where do candidates come from), **liveness gate** (which URLs are still alive), **evaluation** (is this worth applying to), and **tracking** (state of the application).

**Unification (2026-05-04):** all Python discovery sources share [scripts/discovery_filters.py](../scripts/discovery_filters.py) for the filter chain, dedup, and NN allocation. All sources write into `batch/tracker-additions/*.tsv` and the downstream (liveness gate, prune, merge) globs `*.tsv` rather than source-specific suffixes - so adding a new discovery source automatically gets the same filtering, liveness, and merge behavior.

## Discovery sources

Nine inputs can produce candidates. None run on a schedule (per CLAUDE.md Rule 6, everything is user-triggered). All Python sources route their raw rows through the unified filter chain in [scripts/discovery_filters.py](../scripts/discovery_filters.py); all sources write `*.tsv` placeholders into `batch/tracker-additions/`.

| Source | Mechanism | When | Volume |
|---|---|---|---|
| **Aggregators** | [scripts/aggregator-intake.py](../scripts/aggregator-intake.py) fetches 8 public GitHub READMEs, parses markdown/HTML tables. As of 2026-05-05: speedyapply-swe, speedyapply-ai, vanshb03-summer2027, simplifyjobs-summer2026, jobright-ai-swe, jobright-ai-engineer, jobright-ai-data-analysis, jobright-ai-summary. The jobright-ai org's per-domain repos are added because user-suggested aaronwangj/awesome-ai-internships does not exist; jobright-ai/* is the closest live analog (157+52+35+25 stars, daily-updated, default branch `master`). | `python3 scripts/aggregator-intake.py [--max-age-days N] [--limit N] [--no-clean] [--dry-run]` | ~2,500 raw rows |
| **JobSpy** | [scripts/jobspy-ingest.py](../scripts/jobspy-ingest.py) wraps python-jobspy to scrape LinkedIn / Indeed / Google Jobs (Glassdoor disabled - country-string locations 400; ZipRecruiter disabled - Cloudflare 403) across 6 keyword sweeps x 4 locations. Captcha-resilient (continues on rate-limit). Optional `--inline-jd` flag captures JD body during scrape. | `python3 scripts/jobspy-ingest.py [--keyword K1,K2,..] [--location "loc1\|loc2"] [--hours_old N] [--inline-jd]` | ~900 raw / 24-sweep run; ~70% expired LinkedIn churn at the liveness gate |
| **Hiring Cafe** | [scripts/hiringcafe-ingest.py](../scripts/hiringcafe-ingest.py) hits hiring.cafe's Next.js getServerSideProps JSON path. Rich payload exposes `visa_sponsorship`, `commitment`, comp band, security_clearance, workplace_type. `buildId` scraped dynamically from homepage. | `python3 scripts/hiringcafe-ingest.py [--keyword kw1,kw2..] [--location loc1\|loc2..] [--max-pages-per-query N]` | ~1,400 raw / 30-sweep run; ~25% expired at liveness gate (way better than jobspy) |
| **Adzuna** | [scripts/adzuna-ingest.py](../scripts/adzuna-ingest.py) Adzuna REST API (16 countries, 1000 calls/month free). Requires `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` env vars (free signup at developer.adzuna.com). | `ADZUNA_APP_ID=... ADZUNA_APP_KEY=... python3 scripts/adzuna-ingest.py [--keyword K1,K2,..] [--max-pages N]` | ~250-500 raw / 5-keyword 2-page run |
| **startup.jobs** | [scripts/startupjobs-ingest.py](../scripts/startupjobs-ingest.py) Cloudflare-protected, uses Playwright via subprocess. Hits `/internships?l=United+States` category page. **Low yield** in current state (their /internships category dominated by GTM/sales/marketing/non-US); keep dormant unless they improve tagging. | `python3 scripts/startupjobs-ingest.py [--max-pages-per-query N]` | ~25 raw / page; near-zero kept after filter |
| **scan.mjs** | Direct GET against Greenhouse / Ashby / Lever / **Workday (POST)** public APIs for the 95 companies in `portals.yml` `tracked_companies`. Workday support is the higher-volume slice in current state - approach ported from [kbhujbal/go-get-jobs](https://github.com/kbhujbal/go-get-jobs) (`workday_main/get_workday_jobs.go`), see [scan.mjs:61](../scan.mjs#L61) and [scan.mjs:140](../scan.mjs#L140). The Workday `wday/cxs/{tenant}/{site}/jobs` POST endpoint with `{appliedFacets:{}, limit:20, offset:N}` is what unblocked the previous "Workday mostly blocked" gap; without it 50%+ of large-employer reqs were unreachable via API. To add a new Workday tenant set both `careers_url` (the `myworkdayjobs.com/{site}` URL) and `api` (the `wday/cxs/...` URL) on a `tracked_companies` entry. | `node scan.mjs` (no LLM tokens) | ~7,000 raw rows |
| **scan-spa.mjs** | Playwright-driven scrape for SPA boards without public JSON APIs (Workable Cloudflare-protected, custom careers pages). Set `scan_method: playwright` + `playwright_provider: <workable\|generic>` on a `portals.yml` entry; provider extractors live in [scan-spa.mjs](../scan-spa.mjs). | `node scan-spa.mjs` (no LLM tokens) | tens of rows per run |
| **WebSearch** | `search_queries` in `portals.yml` via the WebSearch tool (`site:greenhouse.io "intern"` etc.). The upstream `portals.yml` queries are tuned for Senior FTE EU roles (Anmol's intern hunt zero-yields against them), so for Anmol's workspace prefer ad-hoc intern-targeted site filters: `site:jobs.ashbyhq.com "Summer 2026" intern`, `site:job-boards.greenhouse.io "Summer 2026" intern`, etc. Google cache is stale-prone; URLs MUST go through liveness gate before agent dispatch. | Skill-dispatched agent or inline | ~30-50 raw per intern-targeted sweep |
| **Playwright (agent-driven)** | Browser-driven scrape of no-API tracked-company careers pages from within an eval agent. **Parallel OK as of 2026-05-04** - either one shared Chromium with N pages (preferred) or N agents each with own Chromium (~150MB each). Old "never 2+ agents" rule retired. | Skill-dispatched agent | ~30-80 |
| **Handshake (manual)** | Anmol applies on Handshake directly via the CMU SSO web UI; per-application confirmation emails arrive in inbox. NOT a programmatic discovery source in this workspace any more (the former snippet+server flow and CSV ingester `scripts/handshake-*` were removed in the 2026-05-20 scripts cleanup). Tracker rows for Handshake-sourced applications get added later from email confirmations, not from a discovery sweep. | User-triggered via Handshake web UI | N/A (ingested post-application from email) |
| **YC Work at a Startup** | [scripts/yc-ingest.py](../scripts/yc-ingest.py) Playwright-driven scrape of `workatastartup.com/internships`. The site's `/jobs?type=intern` filter is auth-gated and ignored unauthenticated; `/internships` returns the full unauth-visible intern set. Cards link to `ycombinator.com/companies/{slug}/jobs/{hash}-{role-slug}`; company name derived from URL slug since the company anchor isn't always inside the job-link card div. Card body exposes comp band ($K/monthly) and posted age ("5 months ago"). | `python3 scripts/yc-ingest.py [--keyword K1,K2,..] [--max-pages N]` | ~14 raw rows / run, ~4 keepers after unified filter; YC W25/W26/F24/S24 batch coverage |
| **HN "Ask HN: Who is hiring?"** | [scripts/hn-hiring-ingest.py](../scripts/hn-hiring-ingest.py) pulls the latest monthly thread via HN Algolia search API, fetches all top-level comments via the items API, parses the conventional `Company \| Role \| Location \| Type \| (comp/visa)` first-line header. Comment permalinks become synthetic URLs when no apply link is embedded. | `python3 scripts/hn-hiring-ingest.py [--month YYYY-MM]` | ~290 top-level comments / month, ~2-8 intern-tagged, typically 0-2 keepers (HN whoishiring is FTE-heavy) |
| **Levels.fyi** | [scripts/levels-ingest.py](../scripts/levels-ingest.py) extracts `__NEXT_DATA__.props.pageProps.initialJobsData.results[].jobs[]` from `levels.fyi/jobs/internships`. Rich payload exposes title, locations, applicationUrl, postingDate, expiryDate, workArrangement, comp band. **Caveat:** the route name is mislabeled — most returned jobs are FTE not intern, so the unified filter drops most. Pagination is server-internal; `?page=N` is a no-op. | `python3 scripts/levels-ingest.py [--keyword K1,K2,..] [--location loc1\|loc2..]` | ~25 raw / run, typically 0 keepers (route name vs content mismatch) |
| **Manual paste** | User pastes JD URL or text to `/career-ops` | Single-URL auto-pipeline | 1 |

Aggregators + Hiring Cafe are the highest-volume Python sources. scan.mjs is zero-token and fast but only covers companies you've explicitly listed; its Workday slice (kbhujbal/go-get-jobs port) is what makes it productive at scale. JobSpy surfaces LinkedIn-direct postings the GitHub aggregators miss but suffers from heavy churn (LinkedIn URLs decay fast); also requires `pip install python-jobspy` (not installed by default in this workspace). Adzuna is a free meta-aggregator (overlaps heavily with jobspy + GitHub aggregators); requires `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` env vars (not set by default in this workspace). startup.jobs has structural low-yield issues (GTM/marketing/non-US dominate their /internships category). WebSearch + agent-Playwright are agent-driven and more expensive. Handshake is no longer a programmatic source: Anmol applies directly via the Handshake web UI (CMU SSO) and tracks via per-application confirmation emails; the snippet/server/CSV scripts were removed in the 2026-05-20 scripts cleanup.

**Visa-sponsorship signal:** Hiring Cafe is currently the only source that exposes a structured `visa_sponsorship` field per posting. The signal lands in the placeholder TSV's Notes column (`VISA-SPONSORSHIP: yes/no (per source).`) so eval agents can pre-weight F-1 viability. Caveat: Hiring Cafe defaults False when unclaimed (not None), so most rows show "no per source"; eval agents are told to verify in JD before treating as a hard block.

## Unified filter chain

All Python discovery sources (aggregator, jobspy, hiringcafe, adzuna, yc, hn-hiring, levels, startupjobs) route raw rows through the same filter chain. The canonical implementation lives in [scripts/discovery_filters.py](../scripts/discovery_filters.py); both `aggregator-intake.py` and `jobspy-ingest.py` import its constants and helpers.

Two entry points:
1. **`apply_unified_filter(rows, source_tag, max_age_days, existing_urls, existing_fps)`** - one-shot pass for sources that don't need per-stage logging (used by jobspy).
2. **Per-stage hand-rolled chain in `aggregator-intake.py:main()`** - same filters, same order, same imports, but with per-source raw/kept counts logged for the markdown run report.

### Stage order

```
raw rows from any source
       │
       ▼  Filter 0: missing company/role/url
       │
       ▼  Filter 1: intra-batch URL dedup (within-run)
       │
       ▼  Filter 2: is_internship()              (aggregator only - it accepts intern signal from a `type` cell)
       ▼  Filter 3: role allow-list              (TARGET_ROLE_TOKENS)
       ▼  Filter 4: role deny-list               (ROLE_DENY_TOKENS, includes gtm/industrial-eng/process-eng/etc.)
       ▼  Filter 5: season filter                (SEASON_DENY_RE: drops Fall 2026, Spring/Summer 2027+, future co-ops)
       ▼  Filter 6: location_is_us_or_remote()   (aggregator: missing-location = OK; jobspy: missing-location = drop)
       │
       ▼  Filter 7: age > max_age_days           (default 21d; rows with no age signal kept by default)
       │
       ▼  Filter 8: tracker URL dedup            (vs applications.md + reports/ + batch/*.tsv)
       ▼  Filter 9: tracker fingerprint dedup    ((normalized_company, normalized_role_tokens))
       │
       ▼  --limit N                              (aggregator only)
       │
       ▼  allocate NN starting from next_available_nn()
       │
       ▼  write batch/tracker-additions/{NN}-{slug}-{source-suffix}.tsv
            suffix = aggregator | jobspy | handshake | ...
```

### Source-specific notes

- **Aggregator** keeps its own `role_matches_targets` (doesn't require "intern" in the title - relies on `is_internship()` which can match an intern signal in a separate `type` column) and `location_is_us_or_remote` (accepts missing location as US-OK because many aggregator rows omit it). These overrides are documented inline.
- **JobSpy** uses the shared module's stricter defaults (intern in title required; missing location rejected).
- **Both sources** share constants, regexes, dedup, NN allocation, and the placeholder TSV writer. Adding a deny token (e.g. `gtm`) propagates to every source automatically.

### Why the order matters

- **Cheap filters first.** Regex/dict membership before tracker I/O before age parsing.
- **Age filter (7) before tracker dedup (8).** Stale rows shouldn't even be checked against the tracker.
- **Tracker dedup (8-9) before --limit.** Otherwise the limit budget gets eaten by URLs already in the tracker.
- **`--limit` last.** Slices the final novel set, not the raw input.

### Freshness signals (Filter 7)

Three sources expose age info; the script handles each:

| Source | Format | Parser |
|---|---|---|
| speedyapply-swe / speedyapply-ai | `5d`, `1mo`, `3w`, `12h` (Age column) | `parse_age()` |
| vanshb03-summer2027 | `Apr 28`, `May 4` (Date Posted column, year implicit) | `parse_date_posted()` |
| simplifyjobs-summer2026 | inline `Xd` / `Xmo` badge in the apply cell | `parse_age()` fallback scan |

`PrepAIJobs` and `summer2026internships` were dropped 2026-05-03 because they don't expose freshness and their tables were stale.

Default `--max-age-days = 21` (tightened from 60 on 2026-05-04 — at this stage of the Summer 2026 cycle most >21d postings are already filled or pulled). Rows with no parseable age signal are KEPT (defensive default so a source schema change doesn't silently nuke the batch).

### Dedup signals (Filter 8-9)

Two indexes are built from `data/applications.md` + `reports/**/*.md` + live `batch/tracker-additions/*.tsv`:

1. **URL set.** `normalize_url()` strips scheme, `www.`, query string, fragment, trailing slash, lowercases. Catches the easy case.
2. **(company, role) fingerprint set.**
   - `_normalize_company`: lowercase, drop non-alphanumerics. `"TikTok Inc."` becomes `"tiktokinc"`.
   - `_normalize_role`: lowercase, strip season tokens, strip degree/cohort/intern/generic-engineer noise, sorted unique tokens >=3 chars. Catches the case where the aggregator uses a `simplify.jobs/p/abc` redirect and the tracker has the direct ATS URL.

Generic role titles can produce empty fingerprints, which means two generic "SWE Intern @ TikTok" rows collapse to the same fingerprint. Specialized roles keep distinguishing tokens (`recsys`, `infrastructure`, etc.) so they stay separate.

## Liveness gate

After ANY discovery source writes placeholder TSVs and BEFORE eval-agent dispatch, run a Playwright-based liveness sweep. **Zero Claude tokens.** Saves substantial agent compute by short-circuiting dead URLs.

Both `liveness-parallel.mjs` and `scripts/prune-by-liveness.py` glob `*.tsv` in `batch/tracker-additions/` (not just one source's suffix), so the gate works identically for aggregator, jobspy, and any future source.

### Pipeline position

```
any discovery source     →  batch/tracker-additions/{NN}-*-{source}.tsv
                                      │
                                      ▼  npm run liveness:batch
                                      │  (liveness-parallel.mjs --from-batch, globs *.tsv)
                                      │
                              /tmp/liveness-results.tsv
                              url \t result \t status \t reason
                                      │
                                      ▼  python3 scripts/prune-by-liveness.py
                                      │
                       ┌──────────────┼──────────────┐
                       │              │              │
                  ACTIVE TSVs   EXPIRED TSVs    UNCERTAIN TSVs
                  (kept)        (deleted        (kept, Notes
                                 if placeholder; flagged
                                 marked          LIVENESS-
                                 Discarded if    UNCERTAIN)
                                 evaluated)
                       │
                       ▼
                  eval-agent dispatch (only on active + uncertain)
```

### Source-specific churn (2026-05-04)

| Source | URLs gated | Active | Expired | Uncertain | Notes |
|---|---|---|---|---|---|
| Aggregator (476 batch TSVs) | 476 | 386 (81%) | 51 (11%) | 39 (8%) | GitHub READMEs are curated; expired rate is the long-tail of stale entries |
| JobSpy (65 fresh) | 65 | 17 (26%) | 45 (69%) | 3 (5%) | LinkedIn URLs decay HARD even within the 168h scrape window; postings get filled fast |

### Classifier ([liveness-core.mjs](../liveness-core.mjs))

Verdicts: `active` | `expired` | `uncertain`. Decision tree:

| Signal | Verdict |
|---|---|
| HTTP 404 / 410 | `expired` (HTTP status) |
| URL contains `?error=true` (Greenhouse closed-job redirect) | `expired` |
| Body matches `HARD_EXPIRED_PATTERNS` ("no longer available", "position has been filled", etc., 15 patterns including DE/FR/ES) | `expired` |
| Body matches `LISTING_PAGE_PATTERNS` ("N jobs found") | `expired` (URL went stale, redirected to search) |
| Body < 300 chars | `expired` (likely nav/footer only) |
| Visible apply control matches `APPLY_PATTERNS` (apply, solicitar, bewerben, postuler, autofill, I'm interested, get started, sign in to apply, etc., 15 patterns) | `active` |
| Otherwise | `uncertain` |

### SPA host handling

The classifier recognizes JS-heavy hosts (`isSpaHost()`): Workday, iCIMS, Lever, Ashby, Greenhouse, Workable, BambooHR, SmartRecruiters, SuccessFactors, Taleo, MetaCareers, Microsoft Careers, lifeattiktok. For these, the parallel scanner waits 5s after navigation (vs 2s for static hosts) so the apply button has time to hydrate.

### Empirical effectiveness (2026-05-04 baseline)

| Run | URLs | Duration (concurrency=20) | Active | Expired | Uncertain |
|---|---|---|---|---|---|
| First sweep | 742 | 130s | 468 (63%) | 192 (26%) | 82 (11%) |
| After classifier improvements | 742 | 212s | 530 (71%) | 157 (21%) | 55 (8%) |

Improved classifier (added apply patterns + SPA host wait) recovered **62 false-expireds → active** and **27 uncertain → active**. Net: 8% more URLs correctly identified as live.

### Cost savings

At ~$0.05–$0.10 per eval agent URL, every 100 dead URLs caught by the liveness gate saves $5–$10 in Claude tokens. The 2026-05-04 sweep on 742 URLs took 212s (zero $) and would have saved ~$10–$25 in eval-agent compute had it been run before the wave A/B dispatch.

## Skill orchestration (`/career-ops`)

The Claude skill at `.claude/skills/career-ops/SKILL.md` is the entry point. When the user runs `/career-ops <args>`, the router:

1. Detects the mode (`scan`, `oferta`, `auto-pipeline`, `tracker`, etc.)
2. Reads `modes/_shared.md` (system rules) + the specific mode file
3. Either executes inline OR dispatches to a subagent

**Mode routing table** (see SKILL.md):

| Input | Mode | Where executed |
|---|---|---|
| `(empty)` | discovery | inline (shows menu) |
| URL or JD text | `auto-pipeline` | inline |
| `scan` | `scan` | subagent (general-purpose) |
| `apply` | `apply` | subagent (with Playwright) |
| `batch` | `batch` | inline |
| `tracker`, `oferta`, `pdf`, etc. | corresponding mode | inline |

`scan` and `apply` go to subagents because they're long-running and produce a lot of intermediate state. The orchestrating Claude doesn't need to hold all 7,000 scanned URLs in context.

## Evaluation pipeline

The expensive stage. Two routes:

### Route A: Single URL (auto-pipeline)

User pastes a URL or JD text. Orchestrator reads `cv.md` + `modes/_profile.md`, fetches the JD, runs A-G evaluation, writes report + tracker line. Single-shot; no parallelism.

### Route B: Bulk dispatch (used for any discovery source's output)

After any source writes N placeholder TSVs (and they survive the liveness gate), the orchestrator:

1. Reads each TSV, extracts URL + NN + company + role
2. Groups into batches of ~10-15 URLs per agent
3. Dispatches N/batch_size general-purpose agents in parallel waves (~10-20 per wave to stay under rate limits)
4. Each agent: WebFetch each URL → on failure (Workday/iCIMS/Lever-403/Ashby SPAs returning empty), fall back to Playwright + `browser_snapshot` (parallel safe as of 2026-05-04) → on second failure, WebSearch `"{Company}" "{Role}" site:linkedin.com OR site:indeed.com` → evaluate against CV → write `reports/{slug}/{NN}-{role-slug}-{date}.md` → OVERWRITE the placeholder TSV with a real evaluated row

The Playwright + WebSearch fallback was added 2026-05-04 after the WebFetch-only first pass produced 87 `JD-fetch-failed` reports. Re-eval pass on the 15 Evaluated-but-fetch-failed flipped 4 to SKIP (visa/eligibility blocks Playwright revealed) and boosted 7 scores (real JD content unmasked stronger fits).

### A-G evaluation (per `modes/oferta.md`)

Each agent scores 1-5 across:

| Block | Dimension |
|---|---|
| A | Role fit (CV proof-point alignment) |
| B | Tech stack alignment |
| C | Location / logistics (US-based ideal; India remote = no CPT) |
| D | Sponsorship / visa (F-1 friendly?) |
| E | Brand / portfolio value |
| F | Application competitiveness (timing, demand) |
| G | Posting legitimacy (active, recent, real apply button) |

Weighted Global score 1-5:
- 4.5+ → Strong, recommend applying
- 4.0-4.4 → Good
- 3.5-3.9 → Decent
- \<3.5 → Recommend against

Resume picker: SDE PDF for SWE/backend/infra/cloud/security; MLE PDF for AI/ML/DS/applied-scientist/research-engineer.

### Output per evaluated URL

```
reports/{company-slug}/{NN}-{role-slug}-{YYYY-MM-DD}.md
  ├─ **URL:** ... (mandatory header for dashboard O-key URL-open)
  ├─ **Score:** N.N/5
  ├─ **Status:** Evaluated | SKIP
  ├─ **Resume:** SDE PDF | MLE PDF
  ├─ **Legitimacy:** High Confidence | Proceed with Caution | Suspicious
  ├─ Block A through G (one paragraph each)
  └─ ## Recommendation: APPLY | APPLY (caveat) | SKIP

batch/tracker-additions/{NN}-{slug}-aggregator.tsv  (placeholder overwritten)
  9-col TSV: NN \t date \t Company \t Role \t Score \t Status \t PDF \t Report \t Notes
```

### Hard rules enforced by every agent (per CLAUDE.md)

1. No em-dashes / en-dashes in candidate-facing content
2. Do NOT generate PDFs (rule 2)
3. Do NOT include F-1/CPT/Heinz explainer (rule 3)
4. Do NOT auto-generate cover letters or application-question files (rule 4)
5. Target roles only (rule 5)

## Tracker integration

### Write path

```
batch/tracker-additions/{NN}-*.tsv
       │
       ▼  node merge-tracker.mjs
       │
       ├─ Layer 4 dedup (final safety net):
       │   1. exact report-number match
       │   2. exact NN match
       │   3. roleFuzzyMatch() on company+role
       │
       ├─ if duplicate found and new score > old → update in place
       ├─ if duplicate found and new score <= old → skip
       └─ else → append new row, NN auto-incremented
       │
       ▼
data/applications.md
       │
       ▼  node verify-pipeline.mjs (health check)
       │   - status canonicalization
       │   - duplicate detection
       │   - link validity (every report file exists)
       │
       ▼
batch/tracker-additions/merged/  (TSVs archived after successful merge)
```

### Tracker schema (DO NOT change)

`data/applications.md` is parsed by the Go dashboard binary as `fields[5]=Status, fields[6]=PDF, fields[7]=Report, fields[8]=Notes`.

```
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
```

9 columns, period. Don't add a 10th. Cover-letter pointer goes inside Notes with `CL:` prefix; eval reports must include a `**URL:**` line for the dashboard's O-key regex.

## Dashboard (Go TUI)

Standalone binary in `dashboard/`. Reads `data/applications.md` directly. Provides:

- Filter tabs (All, Evaluated, Applied, Interview, Top >=4, No Apply)
- Sort modes (Score, Date, Company, Status)
- Inline report preview (Enter on a row)
- URL open (O key, uses `**URL:**` regex from report)
- **Cover-letter trigger (`u` key)**: shells out to `claude --permission-mode acceptEdits -p "<prompt>"` to generate the cover letter on-demand at `reports/{slug}/{NN}-*-cover-letter.md`. CLAUDE.md auto-loads so the standing rules apply.

## File reference

### Source-of-truth files

| File | Role |
|---|---|
| [cv.md](../cv.md) | source-of-truth CV (proof points, metrics) |
| [config/profile.yml](../config/profile.yml) | candidate identity + internship_constraints |
| [modes/_profile.md](../modes/_profile.md) | user archetypes, narrative, writing style |
| [portals.yml](../portals.yml) | scan.mjs companies + WebSearch queries + title filter |
| [data/applications.md](../data/applications.md) | canonical 9-col tracker |

### Discovery + dispatch

| Script | Role |
|---|---|
| [scripts/discovery_filters.py](../scripts/discovery_filters.py) | shared constants + filter chain + dedup + NN allocation, imported by every Python discovery source |
| [scripts/aggregator-intake.py](../scripts/aggregator-intake.py) | 4-source GitHub README aggregator with 9-stage filter (per-stage logging) |
| [scripts/jobspy-ingest.py](../scripts/jobspy-ingest.py) | LinkedIn / Indeed scraper, 6-keyword sweep, `apply_unified_filter()` one-shot |
| [scripts/handshake-ingest.py](../scripts/handshake-ingest.py) | Handshake CSV ingester (NN bucket 300-399). **Legacy / dormant** — Anmol applies directly via Handshake web UI (CMU SSO) and tracks via per-application confirmation emails; this script stays on disk for back-compat with the snippet/server flow but is not part of the active discovery sweep. |
| [scripts/yc-ingest.py](../scripts/yc-ingest.py) | YC Work at a Startup `/internships` scraper (Playwright, Cloudflare bypass). Added 2026-05-05. |
| [scripts/hn-hiring-ingest.py](../scripts/hn-hiring-ingest.py) | HN monthly "Ask HN: Who is hiring?" thread parser (Algolia + items API, HTTP-only). Added 2026-05-05. |
| [scripts/levels-ingest.py](../scripts/levels-ingest.py) | Levels.fyi `__NEXT_DATA__` extractor for `/jobs/internships` (HTTP-only). Added 2026-05-05. |
| [scan.mjs](../scan.mjs) | zero-token API scanner (Greenhouse/Ashby/Lever) |
| [liveness-parallel.mjs](../liveness-parallel.mjs) | Playwright bulk liveness gate, globs all `*.tsv` |
| [scripts/prune-by-liveness.py](../scripts/prune-by-liveness.py) | applies liveness verdicts: deletes expired placeholders, marks expired evals as Discarded, flags uncertain |
| [check-liveness.mjs](../check-liveness.mjs) | single-URL liveness check (legacy, prefer liveness-parallel.mjs) |

### Tracker integrity

| Script | Role |
|---|---|
| [merge-tracker.mjs](../merge-tracker.mjs) | merges batch TSVs into applications.md (Layer 4 dedup) |
| [verify-pipeline.mjs](../verify-pipeline.mjs) | health check (statuses, dups, link validity) |
| [dedup-tracker.mjs](../dedup-tracker.mjs) | removes duplicate tracker entries |
| [normalize-statuses.mjs](../normalize-statuses.mjs) | maps status aliases to canonical values |
| [cv-sync-check.mjs](../cv-sync-check.mjs) | validates setup consistency |

### State / logs

| Path | Contents |
|---|---|
| `batch/tracker-additions/*.tsv` | live un-merged eval rows |
| `batch/tracker-additions/merged/` | archived post-merge TSVs |
| `data/scan-history.tsv` | every URL ever surfaced by scan.mjs (with status: added \| skipped_filter \| skipped_dup \| skipped_expired) |
| `data/scan-results-{date}.tsv` | transient scan output, deleted after inline eval (no triage state) |
| `data/aggregator-intake-{date}.md` | aggregator run log |
| `reports/{slug}/{NN}-*.md` | per-role eval reports |
| `reports/pending.md` | placeholder for unevaluated aggregator rows |

## Operational notes

### Rate limits

The Anthropic API throttles concurrent agent dispatch around 60 in-flight. Wave A's 200-eval batch dispatched 40 agents and completed cleanly. Wave B's 1,277-eval batch tried 60 at once and ~50% returned `Server is temporarily limiting requests`. Practical ceiling: dispatch 15-20 agents per turn, keep 30-40 in flight at any moment.

### Failure modes

| Failure | Where | Recovery |
|---|---|---|
| WebFetch returns empty (Workday/iCIMS JS-only render) | Eval agent | Fall back to Playwright `browser_navigate` + `browser_snapshot` (3-5s SPA wait); on second failure WebSearch `"Company" "Role" site:linkedin.com OR site:indeed.com`; final fallback is SKIP stub with `JD-fetch-failed` flag |
| WebFetch returns 403 (Tesla, Lever) | Eval agent | Same fallback chain (Playwright → WebSearch → SKIP stub) |
| Agent rate-limited mid-batch | Subagent | Dispatched batch's TSVs stay as placeholders, retried in next wave |
| Aggregator fetch fails for one source | Aggregator | Logged, others continue |
| JobSpy hits LinkedIn captcha | jobspy-ingest.py | Stop-on-captcha, exits 1, message "JobSpy hit rate limit / captcha on {site}; stopped" |
| Glassdoor returns 400 ("location not parsed") | jobspy-ingest.py | Glassdoor disabled by default in `--site`; lib doesn't expose city-level location IDs |
| Source URL stale at eval time | Liveness gate (preferred) or Eval agent Block G (fallback) | Liveness gate deletes/marks Discarded BEFORE eval dispatch; if missed, agent flags Suspicious in Legitimacy field |

### Update cadence (recommended, user-triggered)

| Cadence | Action |
|---|---|
| Daily | `/career-ops scan` (zero-token, ~30s) |
| Weekly | `python3 scripts/aggregator-intake.py` AND `python3 scripts/jobspy-ingest.py`, then `npm run liveness:batch` + `python3 scripts/prune-by-liveness.py`, then dispatch eval agents on the survivors in waves of ~10-15 |
| Periodic (recommended weekly) | `npm run liveness:batch` over the whole tracker to keep `applications.md` clean (catches postings closed since they were evaluated) |
| Before any apply | spot-check the URL still resolves (the dashboard `O` key opens it) |
| Before merge | `node verify-pipeline.mjs` |

### Hard rules summary (CLAUDE.md)

1. No em/en-dashes in candidate-facing content
2. No CV PDF generation (user submits own resume)
3. No F-1/CPT/Heinz/OIE explainer in any output
4. Cover letters only on explicit request or dashboard `u` keypress
5. Target roles only: SDE/AI/MLE/DS/DE/DA Intern, US-based primary
6. No cron jobs / no schedules — everything user-triggered
7. Scan and evaluation always run together — no triage state
