# CLAUDE.md

Context for Claude Code sessions in this workspace. Anmol's full-time / new-grad search ops (Dec 2026 grad, start ~Jan 2027).

## Who

Anmol Sahu. CMU MISM-BIDA (Heinz, Master of Information Systems Management with Business Intelligence and Data Analytics track, expected Dec 2026, CGPA 3.75). F-1 visa, OPT-eligible post-graduation, requires H-1B sponsorship. 2.5 yrs SDE at Byju's. Active projects: Highmark cancer-staging (XGBoost on 6M+ claims), Cloudify (multi-agent OpenAI+Claude cloud migration, TartanHacks 2026), EEG Classification (CMU 11-685, multi-head CNN+Transformer + CLIP retrieval on PSC HPC). 6 hackathon wins (~$22K).

Source-of-truth CV: [cv.md](cv.md). Submission resumes are the user's PDFs in [resumes/](resumes/) (`SDE Anmol's Resume(27-04-26)-LATEST.pdf`, `MLE Anmol's Resume(27-04-26)-LATEST.pdf`).

## Current state

State (what's done, what's pending, decommissioned workstreams, outstanding user actions, phase tables) lives in [STATUS.md](STATUS.md). Update STATUS.md (not this file) when a workstream lands or a stop condition trips. This file stays as conventions only.

## Hard rules (saved in memory; do not violate)

1. **No em-dashes or en-dashes** in any candidate-facing content (resumes, cover letters, form answers, faculty emails, alumni outreach). Use commas, periods, colons, or rephrase.
2. **Do NOT generate CV PDFs.** User submits own resume. Provide evaluations, Block H form answers, and cover letters only.
3. **Do NOT include any visa/OPT/H-1B/sponsorship explainer paragraph** in cover letters, form answers, faculty emails, or alumni outreach. If start date is asked, just say "Available January 2027."
4. **Generate cover letters only on explicit request.** Do NOT auto-draft cover letters during evaluation, even for top-tier (≥4.0) roles. The only trigger is the user explicitly asking ("write a cover letter for X"). (Previous default was auto-draft; reversed because most evaluated roles never get applied to and the auto-drafts piled up unused.)
5. **Target roles**: SDE / Software Engineer (New Grad), AI Engineer, MLE, Data Scientist, Data Engineer, Data Analyst, Forward-Deployed / Solutions Engineer, plus adjacent. US-based (in-person or remote-US) primary; needs H-1B sponsorship (no India-remote for the US FT search).
6. **No cron jobs / no schedules.** Everything is user-triggered. There is no `crontab`, no Claude Code Routines, no daily-*-cron scripts. If a workflow needs to run periodically, the user invokes it manually.
7. **Scan and evaluation can run together OR separately.** `scan.mjs` writes new candidates to `data/scan-results-{YYYY-MM-DD}.tsv`. The skill may either (a) dispatch evaluation agents inline in the same invocation and delete the TSV before returning (auto-pipeline), or (b) stop after scan and leave the TSV on disk so the user can trigger evaluation in a follow-up invocation. Pasting URLs/JD text directly to `/career-ops` always runs the inline auto-pipeline (no scan step). When scan-only mode leaves a TSV on disk, a later evaluation invocation consumes it, dispatches evaluation agents, and deletes it before returning. `data/pipeline.md` is still NOT used as an inbox; the on-disk TSV is the only handoff format between scan and evaluation.

## Tracker schema (do NOT change)

[data/applications.md](data/applications.md) is **9 columns**, parsed by the Go dashboard binary as `fields[5]=Status, fields[6]=PDF, fields[7]=Report, fields[8]=Notes`. Do not add a 10th column — the dashboard breaks.

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |

Embed cover-letter pointer inside Notes column with the `CL:` prefix:
- `CL: [filename](path)` — cover letter exists at this path

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
  scripts/                    # build helpers (CV PDF gen DEPRECATED — see rule 2)
```

## Workflow when surfacing new candidates

This is a user-triggered flow. Per Rule 6, there is no scheduled scan. Per Rule 7, scan and evaluation may run inline together (one invocation) or be split across two invocations (scan-only first, evaluation later) — the on-disk TSV is the handoff format.

1. **User triggers** `/career-ops scan` (or pastes URLs/JD text directly to `/career-ops`, which skips the scan step and runs auto-pipeline on the pasted URLs).
2. **Scan** companies with public APIs (Greenhouse / Ashby / Lever) via `scan.mjs` (zero-token HTTP+JSON). For SPA / Cloudflare-protected boards (Workable, custom careers pages with no JSON API), append `node scan-spa.mjs` which uses shared-Chromium Playwright. Both append to the same `data/scan-results-{YYYY-MM-DD}.tsv`. To add a new SPA target, set its `portals.yml` entry to `scan_method: playwright` + `playwright_provider: <workable|generic>`; new provider extractors live in [scan-spa.mjs](scan-spa.mjs).
3. **Title-level filter** in the same invocation: drop sales/GTM/marketing/HR/legal/finance/senior/staff/principal/non-target geo without writing per-URL reports. Log dropped rows in `data/scan-history.tsv` with status `skipped_filter`.
4. **Decision point — inline or split:**
   - **Inline (default):** continue immediately to step 5 in the same invocation.
   - **Scan-only (split mode):** stop here, leaving `data/scan-results-{YYYY-MM-DD}.tsv` on disk. Report counts (rows scanned, rows that survived the filter) and exit. The user runs `/career-ops` again later to consume the TSV; the next invocation MUST detect any pre-existing `data/scan-results-*.tsv` files and resume from step 5 against them before doing anything else.
5. **Evaluation** of the survivors: dispatch parallel agents (typically batches of 5 URLs), each running auto-pipeline per URL — fetch JD, score A-F, write `reports/{company-slug}/{NN}-{role-slug}-{date}.md` with `**URL:**` header, write a 9-column tracker line to `batch/tracker-additions/`. `{company-slug}` is the lowercased, hyphenated company name (matches the slugifier in `scripts/reorg-reports-by-company.py`).
6. **Merge** `batch/tracker-additions/*.tsv` into [data/applications.md](data/applications.md). Run `node verify-pipeline.mjs` for schema integrity.
7. **Delete** `data/scan-results-{YYYY-MM-DD}.tsv` — evaluation is not complete until the TSV is gone. (In split mode this delete happens in the follow-up invocation, not the scan-only one.)
8. **Pick correct resume** per role: **SDE PDF** for SDE/backend/infra, **MLE PDF** for AI/ML/DS/applied-scientist. Note in Notes column.
9. Cover letters: do NOT auto-draft. Generated only when the user asks. Application-questions files (`-application-questions.md`) follow the same on-request rule. Tracker Notes column gets the `CL:` prefix only after a letter actually exists.

### Handshake (manual on-website, decided 2026-05-05)

Anmol applies to Handshake postings directly via the Handshake web UI (CMU SSO at `https://app.joinhandshake.com/job-search`). **Not part of the discovery sweep.** The previous snippet/server/CSV discovery flow + its browser extension were fully decommissioned and removed during the 2026-05-20 cleanup pass.

**Tracking model:** Handshake sends a per-application confirmation email to anmolsah@andrew.cmu.edu after every submission. Tracker rows for Handshake-sourced applications get added later from those emails (manually or via a future Gmail watcher), not via a discovery sweep at the start of the funnel. This matches CLAUDE.md Rule 6 ("everything is user-triggered") and avoids the auth-walled JD-fetch problem the snippet flow had.

**Implication for `/career-ops scan`:** the scan command does NOT include any Handshake source. If you want to surface a Handshake posting for evaluation, copy the URL/JD into `/career-ops` manually (Rule 7 auto-pipeline path).

## Useful API endpoints (new-grad-friendly filters)

- Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs` — filter for "new grad" / "entry level" / "2026/2027 grad"
- Ashby: `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
- Lever: `https://api.lever.co/v0/postings/{slug}?mode=json`
- Workday (POST): `https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with body `{"appliedFacets":{},"limit":20,"offset":N,"searchText":""}` — returns `{jobPostings:[], total:N}`. scan.mjs paginates parallel, capped at 50 pages = 1000 jobs. To add a Workday tenant, set `careers_url` to `https://{tenant}.{wdN}.myworkdayjobs.com/{site}` and `api:` to the `/wday/cxs/...` URL. Approach ported from kbhujbal/go-get-jobs.
- SimplifyJobs/New-Grad-Positions, speedyapply NEW_GRAD_USA, and jobright Daily-H1B GitHub READMEs are the highest-signal aggregators.

Many slugs 404 (snowflake, doordash, notion, ramp, plaid, openai, huggingface, sierra, etc.) — these don't expose public boards. Check Greenhouse/Ashby first; fall back to scraping the careers page only if needed.

## Memory files (auto-loaded)

`/Users/anmolsahu2k/.claude/projects/-Users-anmolsahu2k-Stuff-Create-career-ops/memory/MEMORY.md` indexes:

- `project_amazon_interview.md` — Amazon status PENDING
- `user_profile.md` — Anmol's background
- `feedback_interview_honesty.md` — Byju's bullets need real-detail prep before phone screens
- `reference_oie_cpt.md` — CPT facts (10-day, no backdating, no independent-study)
- `project_eeg_classification.md` — EEG project portfolio asset details
- `feedback_changelog_per_turn.md` — append CHANGELOG entry every workspace-changing turn
- `feedback_status_doc_maintenance.md` — state lives in STATUS.md only; CLAUDE.md is conventions-only

Hard rules 1-5 live as numbered rules in this file (above) and are NOT mirrored into auto memory. Per the official Claude Code memory doc, CLAUDE.md is for user-stated rules and auto memory is for Claude-discovered learnings — mirroring user-stated rules into memory creates drift risk without adding enforcement.

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
