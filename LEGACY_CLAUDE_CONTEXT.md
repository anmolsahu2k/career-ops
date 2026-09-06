# Legacy Career-Ops Context

This file preserves the pre-runtime Claude context for historical decisions and compatibility details. Current agents load `CAREER_OPS.md` and a selected mode first, then read this file only when the compact contract points here for missing legacy context.

# Career-Ops Shared Agent Rules

Shared context for Codex and compatibility-agent sessions in this workspace. The filename remains `CLAUDE.md` because existing path resolvers and legacy adapters depend on it. Anmol's full-time / new-grad search ops target a December 2026 graduation and approximately January 2027 start.

## Who

Anmol Sahu. CMU MISM-BIDA (Heinz, Master of Information Systems Management with Business Intelligence and Data Analytics track, expected Dec 2026, CGPA 3.75). F-1 visa, OPT-eligible post-graduation, requires H-1B sponsorship. 2.5 yrs SDE at Byju's, then Tabhi AI Engineer Intern (agentic AI, Summer 2026). Projects: Highmark cancer-staging (XGBoost on 6M+ claims, finished), Cloudify (multi-agent OpenAI+Claude cloud migration, TartanHacks 2026), EEG Classification (CMU 11-685, multi-head CNN+Transformer + CLIP retrieval on PSC HPC). 6 hackathon wins (~$22K).

Source-of-truth CV: [cv.md](cv.md). Submission resumes are the user's PDFs at `/Users/anmolsahu2k/Stuff/Resume/` (`SDE Anmol's Resume(19-07-26) - LATEST.pdf`, `MLE Anmol's Resume(19-07-26) - LATEST.pdf`; the older `resumes/` 27-04-26 PDFs are superseded). An append-only **master resume** lives at `/Users/anmolsahu2k/Stuff/Resume/master-resume-source.md` (superset, never delete a bullet); sync cv.md + portfolio to the active resumes when they change. See memory `feedback_master_resume`.

## Current state

State (what's done, what's pending, decommissioned workstreams, outstanding user actions, phase tables) lives in [STATUS.md](STATUS.md). Update STATUS.md (not this file) when a workstream lands or a stop condition trips. This file stays as conventions only.

## Hard rules (do not violate)

1. **No em-dashes or en-dashes** in any candidate-facing content (resumes, cover letters, form answers, faculty emails, alumni outreach). Use commas, periods, colons, or rephrase.
2. **Do NOT generate CV PDFs.** User submits own resume. Provide evaluations, Block H form answers, and cover letters only.
3. **Do NOT include any visa/OPT/H-1B/sponsorship explainer paragraph** in cover letters, form answers, faculty emails, or alumni outreach. If start date is asked, just say "Available January 2027."
4. **Generate cover letters only on explicit request.** Do NOT auto-draft cover letters during evaluation, even for top-tier (≥4.0) roles. The only trigger is the user explicitly asking ("write a cover letter for X"). (Previous default was auto-draft; reversed because most evaluated roles never get applied to and the auto-drafts piled up unused.)
5. **Target roles**: SDE / Software Engineer (New Grad), AI Engineer, MLE, Data Scientist, Data Engineer, Data Analyst, Forward-Deployed / Solutions Engineer, plus adjacent. US-based (in-person or remote-US) primary; needs H-1B sponsorship (no India-remote for the US FT search).
6. **No cron jobs / no schedules.** Everything is user-triggered. There is no `crontab`, no Claude Code Routines, no daily-*-cron scripts. If a workflow needs to run periodically, the user invokes it manually.
7. **Scan and evaluation can run together OR separately.** `scan.mjs` writes new candidates to `data/scan-results-{YYYY-MM-DD}.tsv`. The skill may either (a) dispatch evaluation agents inline in the same invocation and delete the TSV before returning (auto-pipeline), or (b) stop after scan and leave the TSV on disk so the user can trigger evaluation in a follow-up invocation. Pasting URLs/JD text directly to `/career-ops` always runs the inline auto-pipeline (no scan step). When scan-only mode leaves a TSV on disk, a later evaluation invocation consumes it, dispatches evaluation agents, and deletes it before returning. `data/pipeline.md` is still NOT used as an inbox; the on-disk TSV is the only handoff format between scan and evaluation.
8. **English only, full A-G reports (2026-07-27).** All workspace instruction files, mode docs, prompts, and dashboard UI are English-only (modes renamed `offer`/`offers`/`contact`; Spanish tokens survive only as legacy parse aliases in states.yml and the .mjs/.go parsers). Every eval report, on every path including mass backlog/aggregator waves, uses the full Block A-G format with the canonical header from `templates/eval-report.md`; the compact wave format (Block A + Fit + Recommendation) is retired. The dashboard's report-preview pane was removed; the tracker list is the whole pipeline view.

## Tracker schema (do NOT change)

[data/applications.md](data/applications.md) is **9 columns**, parsed by the Go dashboard binary as `fields[5]=Status, fields[6]=PDF, fields[7]=Report, fields[8]=Notes`. Do not add a 10th column — the dashboard breaks.

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |

**One number space (reconciled 2026-07-27):** the `#` column equals the report-file number — tracker row numbers, report NNN prefixes, and un-merged batch TSV numbers all draw from a single counter (`reserve-report-num.mjs`; mirrored by `lib/report-numbers.mjs` and `discovery_filters.next_available_nn`). merge-tracker.mjs never renumbers a row; colliding additions are skipped with a warning and must be re-reserved. Rows without a report (gmail-sweep, manual adds) allocate above the space's max.

Embed cover-letter pointer inside Notes column with the `CL:` prefix:
- `CL: [filename](path)` — cover letter exists at this path

**Discovery-source attribution (`SRC:`, landed 2026-07-30).** Every tracker row's Notes must carry exactly one `SRC: {source}` token naming the discovery source that surfaced it. Canonical source ids live in [lib/sources.mjs](lib/sources.mjs) (`greenhouse-api`, `ashby-api`, `jobright-newgrad-swe`, `hn-hiring`, `manual`, ... plus `unknown`); never write a company name or a free-text phrase. All 1,230 live FT rows were backfilled by `node backfill-src.mjs` (idempotent; re-run any time), and `node source-analytics.mjs` reads the token to produce the per-source funnel. Row writers stamp it automatically (`aggregator-intake.py`, `discovery_filters.py`); eval agents must add it per `modes/auto-pipeline.md` Step 5. Resolution confidence per row is recorded in `ft/data/src-provenance.tsv` — `recorded` means real provenance, `inferred` means guessed from the ATS host and should not be read as certain. **The token must be a canonical id, never the feed's own label** (jobspy calls its LinkedIn scrape `linkedin`; the canonical id is `jobspy-linkedin`). A raw label splits one source into two half-empty analytics buckets, which is exactly what happened until 2026-08-07. The taxonomy is mirrored in three runtimes because three of them need it: [lib/sources.mjs](lib/sources.mjs) is the source of truth, `normalize_source()` in [scripts/discovery_filters.py](scripts/discovery_filters.py) is the Python half every ingest writer calls, and the `sourceGroups`/`sourceAliases` maps in [dashboard/internal/data/career.go](dashboard/internal/data/career.go) let the dashboard group them. `tests/sources-parity.test.mjs` fails the suite the moment the three disagree. The dashboard's **Progress screen (`p`) renders a Discovery Sources panel** (rows, apply-tier count, average score, colour-coded by group); `node source-analytics.mjs` remains the full funnel view with scanned counts and yields.

Form-answer files and combined letter+answers files: just link them inline in Notes as free text, no special prefix. (Historical rows still use `CL+Q:` and `Form Qs:` — leave them alone, they parse fine as free text. Don't introduce new ones.)

Eval report files MUST include a `**URL:**` line (not `**Apply:**`) — the dashboard's O-key URL-open regex is `^\*\*URL:\*\*\s*(https?://\S+)`.

## Career-Ops layout

```
career-ops/
  config/profile.yml         # Anmol-specific config + job_search_constraints
  cv.md                       # source-of-truth CV
  data/
    applications.md           # 9-col tracker
    intern_shortlist.md       # historical intern scan top 25 (pre-pivot)
    simplifyjobs_summer2026_picks.md
    alumni_outreach_priorities.md
  modes/_profile.md           # role-specific archetypes
  portals.yml                 # new-grad-friendly filters
  reports/
    {company-slug}/           # one folder per company (slug = lowercased, hyphenated company name)
      {NN}-{role-slug}-{YYYY-MM-DD}.md           # eval report
      {NN}-{role-slug}-cover-letter.md           # cover letter (top-tier roles only)
      {NN}-{role-slug}-application-questions.md  # form Qs (when applicable)
    pending.md                # shared SKIP/placeholder sentinel (do NOT move into a company folder)
    _misc/                    # non-numeric files (e.g., shared alumni outreach)
  templates/
    alumni-outreach.md        # 5 LinkedIn DM variants
    faculty-cold-email.md     # per-archetype framing
    application-tactics.md    # recurring app-form questions
  merge-tracker.mjs           # 9-col tracker merger (do not change schema)
  backup.mjs                  # user-triggered off-disk backup (/career-ops backup, npm run backup)
  scripts/                    # build helpers (CV PDF gen DEPRECATED — see rule 2)
```

### ft/ subtree + CAREER_OPS_DATA_DIR (FT pivot, landed 2026-06-08)

The workspace pivoted from the intern search to a full-time / new-grad search, and the data tree split in two:

- **`ft/`** (`ft/data/`, `ft/reports/`, `ft/batch/`) is the **live FT funnel**. This is where new scans, evaluations, and tracker rows land.
- **root `data/` + `reports/`** are the **frozen intern archive** (~2,090 rows). Read-mostly; do not write new FT work here.

One env var, `CAREER_OPS_DATA_DIR`, selects the tree: default **`ft`**; set it to **`.`** for the archive. Two resolvers (`lib/paths.mjs` for Node, `scripts/_paths.py` for Python) read it and are wired into every path-bearing script, so `data/...`, `reports/...`, `batch/...` in this file and in the mode docs all resolve **under `$CAREER_OPS_DATA_DIR`** (default `ft/`). The Go dashboard is launched as `./career-dashboard --path ft` (a bare launch also defaults to `ft` and prints an ARCHIVE banner if it lands on the root archive). Historical intern-archive operations (e.g. the STATUS #4 rejection sweep) must be run with `CAREER_OPS_DATA_DIR=.` prefixed.

### Off-disk backup

All personal data is gitignored and single-copy on disk. `node backup.mjs` (aka `/career-ops backup` / `npm run backup`) tars the gitignored recovery set + auto-memory to a mounted Google Drive folder (keeps the last 5; `--with-secrets` for a separate credential tarball; `--dry-run` to preview). See [docs/RECOVERY.md](docs/RECOVERY.md).

## Workflow when surfacing new candidates

> **Path note:** all `data/`, `reports/`, and `batch/` paths in this section resolve under `$CAREER_OPS_DATA_DIR` (default `ft/`, the live FT funnel), per the resolver described above. So `data/scan-results-*.tsv` means `ft/data/scan-results-*.tsv`, etc.

This is a user-triggered flow. Per Rule 6, there is no scheduled scan. Per Rule 7, scan and evaluation may run inline together (one invocation) or be split across two invocations (scan-only first, evaluation later) — the on-disk TSV is the handoff format.

1. **User triggers** `/career-ops scan` (or pastes URLs/JD text directly to `/career-ops`, which skips the scan step and runs auto-pipeline on the pasted URLs).
2. **Scan** companies with public APIs (Greenhouse / Ashby / Lever) via `scan.mjs` (zero-token HTTP+JSON). For SPA / Cloudflare-protected boards (Workable, custom careers pages with no JSON API), append `node scan-spa.mjs` which uses shared-Chromium Playwright. Both append to the same `data/scan-results-{YYYY-MM-DD}.tsv`. `node scan-freehire.mjs` sweeps the freehire.me public JSON API (~50 ATS platforms, country/recency facets) into the same file. `node scan-linkedin.mjs` (LinkedIn public jobs-guest) is **opt-in and never part of a scan**: it refuses to run unless `linkedin_guest.enabled: true` in `portals.yml`, because automated LinkedIn access is against their ToS; its rows are mirror URLs needing apply-URL resolution at eval time. To add a new SPA target, set its `portals.yml` entry to `scan_method: playwright` + `playwright_provider: <workable|generic>`; new provider extractors live in [scan-spa.mjs](scan-spa.mjs).
3. **Title-level filter** in the same invocation: drop sales/GTM/marketing/HR/legal/finance/senior/staff/principal/non-target geo without writing per-URL reports. Log dropped rows in `data/scan-history.tsv` with status `skipped_filter`.
4. **Decision point — inline or split:**
   - **Inline (default):** continue immediately to step 5 in the same invocation.
   - **Scan-only (split mode):** stop here, leaving `data/scan-results-{YYYY-MM-DD}.tsv` on disk. Report counts (rows scanned, rows that survived the filter) and exit. The user runs `/career-ops` again later to consume the TSV; the next invocation MUST detect any pre-existing `data/scan-results-*.tsv` files and resume from step 5 against them before doing anything else.
5. **Liveness gate (MANDATORY, before any eval agent is dispatched).** Run the zero-token Playwright liveness pass over the survivor URLs and drop the dead ones BEFORE dispatching eval agents. For `scan.mjs` output, extract the survivor URLs into a file and run `npm run liveness:bulk -- /tmp/scan-urls.txt /tmp/scan-liveness.tsv`. For aggregator / JobSpy / HiringCafe placeholders already written into `batch/tracker-additions/`, run `npm run liveness:batch` then `python3 scripts/prune-by-liveness.py`. Drop every URL classified `expired` (log `skipped_expired` in `data/scan-history.tsv`) and never dispatch an eval agent against it; keep `uncertain` URLs but let the `LIVENESS-UNCERTAIN {date}.` Notes prefix ride through. This gate is not optional: no row may reach evaluation without passing it. In split mode the gate runs in the evaluation invocation (the one that resumes here), not the scan-only one.
6. **Evaluation** of the survivors: dispatch parallel agents (typically batches of 5 URLs), each running auto-pipeline per URL — fetch JD, write the **full Block A-G evaluation** (per `modes/offer.md` + the canonical header in `templates/eval-report.md`; the compact wave format of Block A + Fit + Recommendation is retired as of 2026-07-27) to `reports/{company-slug}/{NN}-{role-slug}-{date}.md` with `**URL:**` header, write a 9-column tracker line to `batch/tracker-additions/`. `{company-slug}` is the lowercased, hyphenated company name (matches the slugifier in `scripts/reorg-reports-by-company.py`). This applies to every eval path, including mass backlog/aggregator waves — no compact reports.
7. **Merge** `batch/tracker-additions/*.tsv` into [data/applications.md](data/applications.md). Run `node verify-pipeline.mjs` for schema integrity.
8. **Delete** `data/scan-results-{YYYY-MM-DD}.tsv` — evaluation is not complete until the TSV is gone. (In split mode this delete happens in the follow-up invocation, not the scan-only one.)
9. **Pick correct resume** per role: **SDE PDF** for SDE/backend/infra, **MLE PDF** for AI/ML/DS/applied-scientist. Note in Notes column.
10. Cover letters: do NOT auto-draft. Generated only when the user asks. Application-questions files (`-application-questions.md`) follow the same on-request rule. Tracker Notes column gets the `CL:` prefix only after a letter actually exists.

### Tracker hygiene (user-triggered, decided 2026-08-07)

Two purge passes keep the `Evaluated` backlog honest, both via [hygiene-sweep.mjs](hygiene-sweep.mjs) (dry-run default, Rule 6: user-triggered, never scheduled): **(a) liveness** — `extract` → `npm run liveness:bulk` → `apply --apply` flips rows whose posting died to `Purged` (re-check weak verdicts against the ATS JSON APIs first); **(b) age** — `age --apply` flips rows evaluated more than **21 days ago** and still unapplied to `Purged` (shelf-life on the apply queue; apply-tier ≥4.0 rows exempt). The dashboard runs the same age policy on launch/reload via `--expire-days` (**default 21, on**; apply-tier exempt; disabled outright in archive mode). The age clock is time-in-Evaluated, not posting age; the wave-6 eval-intake posting-age policy (>120d drop, 22-120d `STALE-REQ`) is separate and unchanged.

### Handshake (manual on-website, decided 2026-05-05)

Anmol applies to Handshake postings directly via the Handshake web UI (CMU SSO at `https://app.joinhandshake.com/job-search`). **Not part of the discovery sweep.** The previous snippet/server/CSV discovery flow + its browser extension were fully decommissioned and removed during the 2026-05-20 cleanup pass.

**Tracking model:** Handshake sends a per-application confirmation email to anmolsah@andrew.cmu.edu after every submission. Tracker rows for Handshake-sourced applications get added later from those emails (manually or via a future Gmail watcher), not via a discovery sweep at the start of the funnel. This matches Rule 6 above ("everything is user-triggered") and avoids the auth-walled JD-fetch problem the snippet flow had.

**Implication for `/career-ops scan`:** the scan command does NOT include any Handshake source. If you want to surface a Handshake posting for evaluation, copy the URL/JD into `/career-ops` manually (Rule 7 auto-pipeline path).

## Useful API endpoints (new-grad-friendly filters)

- Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs` — filter for "new grad" / "entry level" / "2026/2027 grad"
- Ashby: `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
- Lever: `https://api.lever.co/v0/postings/{slug}?mode=json`
- Workday (POST): `https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with body `{"appliedFacets":{},"limit":20,"offset":N,"searchText":""}` — returns `{jobPostings:[], total:N}`. scan.mjs paginates parallel, capped at 50 pages = 1000 jobs. To add a Workday tenant, set `careers_url` to `https://{tenant}.{wdN}.myworkdayjobs.com/{site}` and `api:` to the `/wday/cxs/...` URL. Approach ported from kbhujbal/go-get-jobs.
- SimplifyJobs/New-Grad-Positions, speedyapply NEW_GRAD_USA, and jobright Daily-H1B GitHub READMEs are the highest-signal aggregators.

Many slugs 404 (snowflake, doordash, notion, ramp, plaid, openai, huggingface, sierra, etc.) — these don't expose public boards. Check Greenhouse/Ashby first; fall back to scraping the careers page only if needed.

## Legacy memory files

The legacy Claude memory index is the single source of truth for learned workspace preferences: `/Users/anmolsahu2k/.claude/projects/-Users-anmolsahu2k-Stuff-Create-career-ops/memory/MEMORY.md`. Claude Code loaded it automatically. Codex does not, so read the index and only the relevant entries when historical decisions or learned preferences matter. Do NOT duplicate that list here because it drifts.

Hard rules 1-5 live as numbered rules in this file and are not mirrored into the legacy memory store. This file contains user-stated rules; the memory files contain learned details. Duplicating either set creates drift without adding enforcement.

## Known gotchas

- **Cover-letter scrubbing**: when you regenerate a cover letter, run a final pass for em-dashes (`—`, `–`) and any auto-introduced OPT/H-1B/visa explainer.
- **Job-location verification**: don't trust the company name. Some Cohere, Mistral, Perplexity reqs are EU-only or Toronto-only — pull the JD location field before recommending. (This burned us once.)
- **Bash for-loops**: when iterating slug lists, inline the list in the for-loop. `slugs="..."` then `for s in $slugs` treats the whole string as one token in some shells.
- **Tracker dashboard updates flow back to applications.md**: if user updates status in the dashboard, the .md file changes too. Don't assume my last-known state is current — re-read before mutating.

## What I am NOT to do without explicit ask

- Generate or rebuild CV PDFs.
- Send the OIE inquiry email (deferred until offer in hand).
- Push commits to any repo.
- Send alumni or faculty messages — drafts only; user sends.
- Change the tracker schema.
