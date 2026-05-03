# CLAUDE.md

Context for Claude Code sessions in this workspace. Anmol's Summer 2026 internship search ops.

## Who

Anmol Sahu. CMU MISM-BIDA (Heinz, Master of Information Systems Management with Business Intelligence and Data Analytics track, expected Dec 2026, CGPA 3.75). F-1 visa, CPT-eligible (Master's CPT Canvas course already enrolled, code GNYPT8). 2.5 yrs SDE at Byju's. Active projects: Highmark cancer-staging (XGBoost on 6M+ claims), Cloudify (multi-agent OpenAI+Claude cloud migration, TartanHacks 2026), EEG Classification (CMU 11-685, multi-head CNN+Transformer + CLIP retrieval on PSC HPC). 6 hackathon wins (~$22K).

Source-of-truth CV: [cv.md](cv.md). Submission resumes are the user's PDFs in [resumes/](resumes/) (`SDE Anmol's Resume(27-04-26)-LATEST.pdf`, `MLE Anmol's Resume(27-04-26)-LATEST.pdf`).

## What's been done

**Live status board:** [STATUS.md](STATUS.md) — phase-by-phase checkboxes with deliverable links. Update STATUS.md and this section together when a workstream lands or trips a stop condition.

- **Amazon SDE Intern Summer 2026** (job 3143461, Payments org): final-round complete Apr 8; received ambiguous AMER-AUTA-RC-admin email Apr 24 — likely admin auto-response, status PENDING per memory. 12-month SDE cooling-off would apply if real reject.
- **Career-Ops installed** at []() — Claude Code-powered job pipeline with Go TUI dashboard (9-col schema).
- **23 roles evaluated** (21 Applied, 2 SKIP) plus **40 raw aggregator candidates surfaced 2026-04-27** by W11 Group 1 aggregator-intake (status `Evaluated`, score `0.0/5`, no eval report yet — pointer is to `reports/pending.md` placeholder). Total tracker rows: 63. Tracker: [data/applications.md](data/applications.md). Eval reports + cover letters (for the original 23) under [reports/](reports/).
- **12 faculty cold emails drafted** at [faculty_emails/](faculty_emails/) (00-OIE deferred per user; 01-12 Tier-1 PIs). W2 will sharpen each P2 with a 2025-26 paper hook before send.
- **EEG_Classification README updated** at `/Users/anmolsahu2k/Stuff/Create/EEG_Classification/README.md` to reflect actual committed work (multi-head CNN+Transformer, Task 2 CLIP retrieval w/ 6 loss variants, PSC Bridges-2 HPC infra). User to push.
- **Master plan** at `/Users/anmolsahu2k/.claude/plans/okay-so-now-what-eventual-scone.md` (v3 status + v2 preserved).
- **Phase 1 of _meta/HANDOFF-now-phase-execution.md done (2026-04-27)**: W3 cover-letter audit ([cover-letter-audit.md](data/cover-letter-audit.md)), W4 resume gap audit ([resume-gap-audit.md](data/resume-gap-audit.md)), W5 GitHub polish ([cloudify](data/github-polish-cloudify.md) + [eeg](data/github-polish-eeg.md)), W12 application-tactics extension + audit ([extended playbook](templates/application-tactics.md), [audit](data/application-tactics-audit.md)), W10 Next.js portfolio at [portfolio/](portfolio/) (build verified). No stop conditions tripped.
- **Phase 2 of _meta/HANDOFF-now-phase-execution.md done (2026-04-27)**: W2 faculty deep-reads (all 12 P2s rewritten with 2025-26 paper hooks, [data/faculty-deep-read-log.md](data/faculty-deep-read-log.md); user should re-skim emails 05/10/11 where P1 first sentence was also touched); W11 Group 1 (3 adapter scripts under `scripts/` + aggregator run = 40 new tracker rows from speedyapply/vanshb03/SimplifyJobs READMEs); W11 Group 2 (`portals.yml` 947→1070 lines: 6 niche AI/ML boards, 9 new slugs from career-copilot diff, Asana from hiring-without-whiteboards verified); W11 Group 3 (eval template + interview-prep templates: [eval-report.md](templates/eval-report.md), [star-plus-r-framework.md](templates/star-plus-r-framework.md), [5ws-storytelling.md](templates/5ws-storytelling.md), [pre-interview-checklist.md](templates/pre-interview-checklist.md)).
- **Phase 3 of _meta/HANDOFF-now-phase-execution.md code done (2026-04-27)**: W1 [scripts/daily-scan-cron.mjs](scripts/daily-scan-cron.mjs), W8 [scripts/weekly-news-cron.mjs](scripts/weekly-news-cron.mjs), W9 [scripts/daily-hygiene-cron.mjs](scripts/daily-hygiene-cron.mjs) (live-tested) all written and verified.
- **Cloud routines decommissioned (2026-05-03)**: All three Claude Code Routines (W1 scan, W8 news, W9 hygiene) disabled and queued for web-UI deletion at https://claude.ai/code/routines. Root cause: cloud sandbox egress proxy blocks Greenhouse/Ashby/Lever portal APIs (W1), and the sandbox Chromium has no trusted CA store so 100% of HTTPS URLs returned `ERR_CERT_AUTHORITY_INVALID` and got false-flagged uncertain (W9). Net useful signal across the routines' entire run history: zero. The remote routine branch `claude/w9-daily-hygiene` was deleted (its valuable infra commits skip-portal-scan flag, AI portal expansion, scan filter widening had already been pulled into the working tree; the rest was stale flat-path reports superseded by the per-company reorg). Going forward: run [scripts/daily-scan-cron.mjs](scripts/daily-scan-cron.mjs) and [scripts/daily-hygiene-cron.mjs](scripts/daily-hygiene-cron.mjs) locally on demand. Routine prompt sources retained in [routines/](routines/) for reference.

## Hard rules (saved in memory; do not violate)

1. **No em-dashes or en-dashes** in any candidate-facing content (resumes, cover letters, form answers, faculty emails, alumni outreach). Use commas, periods, colons, or rephrase.
2. **Do NOT generate CV PDFs.** User submits own resume. Provide evaluations, Block H form answers, and cover letters only.
3. **Do NOT include the F-1/CPT/Heinz/OIE/May 12/June 1 explainer paragraph** in cover letters, form answers, faculty emails, or alumni outreach. If start date is asked, just say "Available June 2026."
4. **Generate cover letters only on explicit request.** Do NOT auto-draft cover letters during evaluation, even for top-tier (≥4.0) roles. The two trigger sources are: (a) the user explicitly asks ("write a cover letter for X"); (b) the user presses `u` on a row in the Go TUI dashboard, which shells out to `claude -p` and writes the letter directly. (Previous default was auto-draft; reversed because most evaluated roles never get applied to and the auto-drafts piled up unused.)
5. **Target roles**: SDE Intern, AI Intern, MLE Intern, Data Science Intern, Data Engineer Intern, Data Analyst Intern, plus adjacent. US-based (in-person or remote-US) primary; India remote acceptable but no CPT for India remote work.

## Tracker schema (do NOT change)

[data/applications.md](data/applications.md) is **9 columns**, parsed by the Go dashboard binary as `fields[5]=Status, fields[6]=PDF, fields[7]=Report, fields[8]=Notes`. Do not add a 10th column — the dashboard breaks.

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |

Embed cover-letter info inside Notes column with prefixes:
- `CL: [filename](path)` — cover letter only
- `CL+Q: [filename](path)` — cover letter + form answers combined
- `Form Qs: [filename](path)` — form answers only (where no separate cover letter is needed)

Eval report files MUST include a `**URL:**` line (not `**Apply:**`) — the dashboard's O-key URL-open regex is `^\*\*URL:\*\*\s*(https?://\S+)`.

## Career-Ops layout

```
career-ops/
  config/profile.yml         # Anmol-specific config + internship_constraints
  cv.md                       # source-of-truth CV
  data/
    applications.md           # 9-col tracker
    intern_shortlist.md       # initial scan top 25
    simplifyjobs_summer2026_picks.md
    alumni_outreach_priorities.md
  modes/_profile.md           # intern-specific archetypes
  portals.yml                 # intern-friendly filters
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

1. Scan via Greenhouse / Ashby / Lever / SimplifyJobs / Workday (Workday mostly blocked).
2. For each candidate: write `reports/{company-slug}/{NN}-{role-slug}-{date}.md` with `**URL:**` header, score (1-5), pros/cons, fit narrative. Reuse the existing `reports/{company-slug}/` folder if the company already has reports; create it if not. `{company-slug}` is the lowercased, hyphenated company name (matches the slugifier in `scripts/reorg-reports-by-company.py`).
3. Do NOT auto-draft a cover letter. Cover letters are generated only when the user asks, or when the user presses `u` in the dashboard (which shells out to `claude -p` and writes the file directly at `reports/{company-slug}/{NN}-{company-slug}-{role-slug}-cover-letter.md`). Application-questions files (`-application-questions.md`) follow the same on-request rule.
4. Append a row to [data/applications.md](data/applications.md). Leave Notes empty for the cover-letter prefix until a letter actually exists; once written, add `CL:` / `CL+Q:` / `Form Qs:` prefix in Notes.
5. Pick correct resume per role: **SDE PDF** for SDE/backend/infra, **MLE PDF** for AI/ML/DS/applied-scientist roles. Note in Notes column.

### Dashboard `u` keybinding (cover letter)

In the Go TUI dashboard at `dashboard/`, pressing `u` (lowercase) on a selected row:
- **If a cover letter already exists** for that row (canonical or legacy filename matching `reports/<company-slug>/<NN>-*-cover-letter.md`): opens it in the in-terminal viewer, same as Enter does for eval reports.
- **If no cover letter exists**: shells out to `claude --permission-mode acceptEdits -p "<prompt>"` from the workspace root. CLAUDE.md auto-loads, so the standing rules apply. The prompt instructs claude to write the letter at the canonical path and exit. After completion the dashboard auto-opens the new file in the viewer; on failure it surfaces the error in the flash bar. While generation is running (~30-60s), additional `u` presses on any row are debounced. Implementation: [dashboard/internal/data/cover_letter.go](dashboard/internal/data/cover_letter.go), key handler in [dashboard/internal/ui/screens/pipeline.go](dashboard/internal/ui/screens/pipeline.go).

## Useful API endpoints (intern-friendly filters)

- Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs` — filter for "intern" / "summer 2026" / "student"
- Ashby: `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
- Lever: `https://api.lever.co/v0/postings/{slug}?mode=json`
- SimplifyJobs/Summer2026-Internships GitHub README is the highest-signal aggregator.

Many slugs 404 (snowflake, doordash, notion, ramp, plaid, openai, huggingface, sierra, etc.) — these don't expose public boards. Check Greenhouse/Ashby first; fall back to scraping the careers page only if needed.

## Memory files (auto-loaded)

`/Users/anmolsahu2k/.claude/projects/-Users-anmolsahu2k-Stuff-Create-Amazon/memory/MEMORY.md` indexes:

- `project_amazon_interview.md` — Amazon status PENDING
- `user_profile.md` — Anmol's background
- `feedback_interview_honesty.md` — Byju's bullets need real-detail prep before phone screens
- `reference_oie_cpt.md` — CPT facts (10-day, no backdating, no independent-study)
- `feedback_no_em_dashes.md` — rule 1
- `feedback_no_cv_pdf.md` — rule 2
- `feedback_no_cpt_explainer.md` — rule 3
- `feedback_default_cover_letter.md` — rule 4
- `project_target_roles.md` — rule 5
- `project_eeg_classification.md` — EEG project portfolio asset details

## Known gotchas

- **Cover-letter scrubbing**: when you regenerate a cover letter, run a final pass for em-dashes (`—`, `–`) and any auto-introduced CPT/Heinz explainer.
- **Job-location verification**: don't trust the company name. Some Cohere, Mistral, Perplexity reqs are EU-only or Toronto-only — pull the JD location field before recommending. (This burned us once.)
- **Bash for-loops**: when iterating slug lists, inline the list in the for-loop. `slugs="..."` then `for s in $slugs` treats the whole string as one token in some shells.
- **Tracker dashboard updates flow back to applications.md**: if user updates status in the dashboard, the .md file changes too. Don't assume my last-known state is current — re-read before mutating.

## Outstanding user actions (as of last interaction)

1. Push EEG_Classification README update (`git -C /Users/anmolsahu2k/Stuff/Create/EEG_Classification/ add README.md && git commit && git push`).
2. Update SDE/MLE PDF resumes per [data/resume-gap-audit.md](data/resume-gap-audit.md) — start with the rank-prediction honesty rewrite.
3. Send 12 faculty cold emails (Saturday batch of 5+4, Sunday batch of 3). W2 sharpened all 12 P2s with 2025-26 paper hooks; re-skim emails 05/10/11 specifically (P1 first sentence was also touched to introduce paper citations).
4. Send 35-40 alumni LinkedIn messages across 21 applied companies.
5. Watch ATS confirmation emails within 48h; flag silent submissions for resubmit.
6. **May 1 decision checkpoint**: ≥2 first-round interviews OR ≥1 faculty positive reply. If miss → expand India track.
7. **May 8 checkpoint**: ≥1 verbal offer OR ≥2 final-rounds. If miss → activate course-credit research fallback.
8. (optional) `pip install python-jobspy` so the daily-scan-cron JobSpy step exits 0 instead of being permanently skipped.
9. Review [data/applications.md](data/applications.md) — 40 raw aggregator candidates from W11 need triage (status `Evaluated`, score `0.0/5`, no eval report yet). Promote interesting ones into standard auto-pipeline; mark others `SKIP`.
10. Review [data/hygiene-2026-05-03.md](data/hygiene-2026-05-03.md) — first real local liveness pass (104 URLs across 303 rows). Distribution: 56 active, 20 expired, 28 uncertain. The 20 expired rows have already been auto-flipped to `Status: Discarded` (2026-05-03). Of the 28 uncertain: 13 are LinkedIn auth-wall artifacts (treat as alive); ~15 non-LinkedIn need spot-check. PsiQuantum confirmed ACTIVE via Greenhouse API; Aurora #712 and Snyk inconclusive without browser session (open in browser to verify before treating as expired).
11. **Run `node scripts/daily-scan-cron.mjs` and `node scripts/daily-hygiene-cron.mjs` locally daily** as the morning routine, since cloud routines are decommissioned. `scan.mjs` adds ~295 candidates/day from direct portals; `aggregator-intake.py` adds ~35; `check-liveness.mjs` flags expired/uncertain URLs (with working CA store locally, unlike the broken cloud sandbox).

## What I am NOT to do without explicit ask

- Generate or rebuild CV PDFs.
- Send the OIE inquiry email (deferred until offer in hand).
- Push commits to any repo.
- Send alumni or faculty messages — drafts only; user sends.
- Change the tracker schema.
