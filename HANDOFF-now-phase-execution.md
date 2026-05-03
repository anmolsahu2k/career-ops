# Career-Ops Now-Phase Execution — Agent Handoff

Self-contained brief for an agent picking up this work cold. Read top to bottom before touching anything.

---

## 1. Mission

Execute 10 parallelizable workstreams that increase Anmol Sahu's Summer 2026 internship-search throughput and quality without breaking existing tracker schema or guardrails. Use parallel subagents and scheduled jobs to keep capacity hot.

Decision record (rationale, alternatives, deferrals): `/Users/anmolsahu2k/.claude/plans/okay-so-now-what-eventual-scone.md` v4 section. This handoff is the executable spec.

## 2. Operating context

**User**: Anmol Sahu. CMU MISM (Heinz, expected Dec 2026, CGPA 3.75). F-1 visa, CPT-eligible (Master's CPT Canvas course code GNYPT8 already enrolled). 2.5 yrs SDE at Byju's. Active projects: Highmark cancer-staging (XGBoost on 6M+ claims), Cloudify (multi-agent OpenAI+Claude cloud migration, TartanHacks 2026), EEG Classification (CMU 11-685, multi-head CNN+Transformer + CLIP retrieval on PSC HPC). 6 hackathon wins (~$22K).

**Working directory**: `/Users/anmolsahu2k/Stuff/Create/Amazon/`

**Project layout** (paths relative to working directory):

```
career-ops/
  config/profile.yml             # Anmol-specific config + internship_constraints
  cv.md                          # source-of-truth CV (DO NOT regenerate PDFs)
  data/
    applications.md              # 9-COL TRACKER — schema is FROZEN
    intern_shortlist.md
    scan-history.tsv             # scanner dedup state
    follow-ups.md
  modes/_profile.md
  portals.yml                    # Greenhouse/Ashby/Lever slugs
  reports/                       # per-app eval + cover letter + form Qs
                                 # 23 reports, 20 cover letters as of 2026-04-27
  templates/
    alumni-outreach.md
    faculty-cold-email.md
    application-tactics.md
  scan.mjs                       # zero-token portal scanner (existing)
  followup-cadence.mjs           # tracker hygiene (existing)
  check-liveness.mjs             # job liveness checker (existing)
  merge-tracker.mjs              # 9-col tracker merger (DO NOT change schema)
  scripts/                       # add new ingesters here
  HANDOFF-pipeline-expansion.md  # 21-change adapter/feed/template roadmap (W11 references this)

faculty_emails/                  # 12 PI cold emails (00-OIE deferred + 01-12 Tier-1)

Anmol's resume PDFs (DO NOT regenerate):
  SDE Anmol's Resume(28-02-26)_v3-FINAL.pdf
  MLE Anmol's Resume(28-02-26)_v3.pdf
```

**Tracker schema** (9 columns, FROZEN — Go TUI dashboard parses `fields[5]=Status, fields[6]=PDF, fields[7]=Report, fields[8]=Notes`):

```
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
```

Embed cover-letter info in Notes column with prefixes: `CL: [...]`, `CL+Q: [...]`, `Form Qs: [...]`.

Eval reports MUST include a `**URL:**` line (NOT `**Apply:**`) — dashboard O-key URL-open regex is `^\*\*URL:\*\*\s*(https?://\S+)`.

**Tracker state as of 2026-04-27**: 21 Applied, 2 SKIP (Pinterest Fall conflict, Applied Intuition PhD-preferred). 20 cover letters in `reports/`.

## 3. Hard rules — DO NOT violate

1. **No em-dashes or en-dashes** (`—`, `–`) in candidate-facing content (resumes, cover letters, form answers, faculty emails, alumni outreach). Use commas, periods, colons, or rephrase.
2. **Do NOT generate CV PDFs.** User submits own resumes. `scripts/build-tailored-cv.mjs` is deprecated.
3. **Do NOT include the F-1/CPT/Heinz/OIE/May 12/June 1 explainer paragraph** in any candidate-facing content. If start date is asked, say "Available June 2026."
4. **Auto-draft cover letter for every top-tier (≥4.0) job** as part of evaluation. Don't ask. Skip only for SKIP-status or hard-blocked roles.
5. **Target roles only**: SDE, AI, MLE, DS, DE, DA Intern + adjacents. US (in-person/remote-US) primary; India remote acceptable but no CPT.
6. **Do NOT change the 9-column tracker schema.**
7. **Do NOT push commits, send emails/messages, or generate CV PDFs without explicit user ask.** Drafts only.

## 3.5 Pipeline integrity contract (from `career-ops/CLAUDE.md`)

These are not optional. Violations break the dashboard and the dedup pipeline.

1. **NEVER edit `career-ops/data/applications.md` to ADD new rows.** Write a TSV file per evaluation to `career-ops/batch/tracker-additions/{NNN}-{company-slug}.tsv` (single line, 9 tab-separated columns: `num\tdate\tcompany\trole\tstatus\tscore/5\tpdf-emoji\t[num](reports/...)\tnote`). Then run `node merge-tracker.mjs` to merge. You MAY edit `applications.md` to UPDATE Status / Notes of existing rows.
2. **Status field must be a canonical state** from `career-ops/templates/states.yml`: `Evaluated`, `Applied`, `Responded`, `Interview`, `Offer`, `Rejected`, `Discarded`, `SKIP`. No markdown bold (`**`), no dates, no extra text.
3. **All eval reports must include a `**URL:**` line in the header** (NOT `**Apply:**`). Dashboard O-key regex: `^\*\*URL:\*\*\s*(https?://\S+)`. Sample report `021-nuro-2026-04-25.md` currently has BOTH `**URL:**` and `**Apply:**` — the `**URL:**` one is the contract; the `**Apply:**` line is an artifact, leave it but don't propagate.
4. **After every batch of evaluations or W11 adapter run**, invoke in order: `node merge-tracker.mjs` → `node dedup-tracker.mjs` → `node normalize-statuses.mjs` → `node verify-pipeline.mjs`. Each is idempotent. Verify-pipeline must exit clean before the workstream is marked done.
5. **Adapters in W11 (B6-B8, F19, A1) MUST write TSVs to `batch/tracker-additions/`**, never direct-write `applications.md` or `intern_shortlist.md` row-by-row. The intake script can write to `intern_shortlist.md` AFTER deduping, in one batch, at end of run.

## 3.6 Inlined context (do NOT skip — required for W2, W4, W11 E16, W12)

### Anmol profile blurb (use verbatim in faculty P2 deep-reads + portfolio + audit framing)

Anmol Sahu, CMU MISM master's student (Heinz, expected Dec 2026, CGPA 3.75). 2.5 yrs SDE at Byju's (200K+ DAU e-commerce, $400K AWS-to-GCP cloud migration, microservice refactor across 10+ verticals, 100% test coverage on Scheduling microservice, DRM platform for 400K+ subscribers). Active projects: (1) **Highmark cancer-staging** XGBoost pipeline on 6M+ longitudinal insurance claims (20,323 members, 3,657 EMR-labeled cases), addressing 40-51% missingness via NCCN clinical-guideline-augmented features (treatment-pathway encoding, biomarker proxies, procedure-code clustering); (2) **Cloudify** multi-agent automation platform on OpenAI + Anthropic Claude APIs via Dedalus SDK, decomposing full-stack cloud migration into agent-callable skills with deterministic guardrails — days to <20 min across 8+ stack configs (TartanHacks 2026); (3) **EEG Classification** (CMU 11-685): multi-head CNN+Transformer for visual-category decoding from 122-channel EEG over 26K trials (13 subjects, 5 sessions); EEGNet 11.5K params beats 127.6M MLP baseline; Task 2 EEG-to-CLIP retrieval pipeline with 6 loss variants (InfoNCE, Debiased InfoNCE, KD Cosine, KD KL, Category CE, Combined); deployed on PSC Bridges-2 HPC (V100-32) via Slurm sbatch. 6 hackathon wins (~$22K, 1st place at Red Hat Hack APAC).

### Target roles (use to filter W1 daily scan + W4 resume bullet rewrites)

Priority: SDE / SWE Intern → AI Engineer Intern (LLM, agents, generative AI) → MLE Intern → Data Science Intern → Data Engineer Intern → Data Analyst Intern.
Adjacent OK: Applied Scientist Intern, Research Engineer Intern, Backend / Full-stack, Infra / Platform, DevOps / SRE, AppSec, QA / SDET, Solutions / Forward Deployed, Research Assistant.
Out of scope: Senior / Staff / Principal / Manager-level. PM / Sales / Marketing / HR / Finance / Operations / Consulting / Strategy. Roles requiring active US clearance or US citizenship.

### Resume routing (W4 + W11 D12-D14 + W10 link targets)

- SDE / SWE / Backend / Infra / Platform / DevOps / SRE / AppSec / QA / Solutions roles → `SDE Anmol's Resume(28-02-26)_v3-FINAL.pdf`
- AI / ML / Applied Scientist / Research Engineer roles → `MLE Anmol's Resume(28-02-26)_v3.pdf`
- Data Engineer / Data Science / Data Analyst → MLE PDF default; SDE if role leans engineering-heavy

### Interview honesty caveat (W11 E16 must surface this in 5Ws output)

Anmol's Byju's bullets are exaggerated (~5/10 self-rated proficiency). Real ground truth in `/Users/anmolsahu2k/Stuff/Create/Amazon/Work experience-Project based 19a056360b5280798943fb0c02aef26c.md`. Specifically: rank prediction was if-else logic from the category team (not ML); content migration was Python extraction/import scripts (didn't architect); cloud migration was monitoring pods + container images + functional tests (didn't architect). The 100% test coverage bullet IS accurate. W11 E16's 5Ws output must include "deep-dive prep" sections with real technical details so Anmol can go 2-3 levels deep when probed without fabricating depth.

### Current `application-tactics.md` table of contents (W12 extends, does not duplicate)

Existing sections: Referral employee name | How did you hear | Authorized to work / sponsorship | Expected salary / hourly rate | Why this role (4-part formula) | Currently employed | Why leaving current job | Applied before | Post-grad salary expectations | Offer conditions | General principles. W12 ADDS 5 NEW sections: AI-lab form patterns, behavioral / values-fit patterns, case-study / take-home handling, portfolio-link expectation handling, Pittsburgh / on-site / relocation + AI-disclosure questions.

### Sample eval-report header structure (W11 D12-D14 must preserve this contract)

```
# {NNN}, {Company} | {Role}

**URL:** {url}

**Score:** X.X/5  **Status:** {canonical state}  **Resume:** {SDE|MLE}
**Legitimacy:** {tier} (e.g., "High Confidence (Greenhouse, active)")

## Block A, Role Summary
| Field | Value | (Archetype, Domain, Location, TL;DR)

## Block B, CV Match
| JD Theme | CV Evidence |

## Block G, Legitimacy
{paragraph}

## Recommendation
{Apply within X / Skip / Verify Y}
```

W11 D12-D14 inserts three new fields into the header block: `**Level strategy:**`, `**Comp research:**`, `**Sponsorship flag:**`. Place AFTER `**Legitimacy:**`, BEFORE Block A. Do not touch `**URL:**`.

## 4. Workstreams (in execution order)

### Phase 1 — 3 sub-phases (W12 depends on W3 output)

Phase 1a (parallel): W3, W4, W5
Phase 1b (after W3 done): W12 (consumes W3 scorecard)
Phase 1c (parallel with all): W10 (longer-running, on main thread)

#### W3. Cover-letter audit (20 letters) — RUN FIRST

**Pre-flight**: `ls career-ops/reports/0*-cover-letter.md` to enumerate exactly. Expect 20 files (per tracker as of 2026-04-27).

**Inputs**: read all `career-ops/reports/0XX-*-cover-letter.md` (20 files) and any `0XX-*-application-questions.md`. Read `career-ops/templates/application-tactics.md`.

**Rubric** (each scored 1-5):
- Specificity (names a product, JD line, blog post, or recent launch?)
- Hook strength (P1 lands one defensible reason for this company?)
- Project anchor (most relevant project surfaced first?)
- No-rules-violated (em-dashes? CPT explainer? "passionate about"/"leveraged"?)
- Length (target 250-350 words; flag >400 or <150)
- Resume-fit (correct PDF: SDE for SDE/backend/infra, MLE for AI/ML/DS)

**Side fix**: rename any `**Apply:**` headers to `**URL:**` in cover-letter files (Hippocratic letter `011-*` confirmed broken; check the rest).

**Output**: `career-ops/data/cover-letter-audit.md` with **machine-readable scorecard table** at top (one row per file with all 6 dimension scores as integers + total) followed by per-letter inline edit suggestions. The machine-readable header lets W12 consume the scores directly without re-reading every cover letter.

**DO NOT**: regenerate already-submitted cover letters silently. Surface findings; user decides whether to resubmit. Per applications.md, the 21 Applied entries (Sierra, Cohere, Lindy, Stripe, Airbnb, plus 16 from this batch) are already submitted — flag these in the scorecard with a "submitted" column so W12 audit and any rewrite suggestions can mark them as advisory-only.

#### W4. Resume gap audit

**Inputs**: read `career-ops/cv.md` (source of truth). Target roles list is inlined in section 3.6 — use that, don't go fetch the memory file. Sample 5 recent eval reports (e.g., `reports/017-021-*.md`) to ground the JD-keyword side.

**Pre-flight**: run `node cv-sync-check.mjs` if it exists (it's in `career-ops/`). It cross-checks `cv.md` against any consumer files. Fix any mismatches it surfaces before scoring.

**Method**: For each target archetype (SDE / AI / MLE / DS / DE / DA Intern), score the bullets in `cv.md` (which is the source of both PDFs per CLAUDE.md) for keyword density vs typical JD, metric strength, recency, role alignment. Use resume-routing rule from section 3.6 to know which archetype each bullet block serves.

**Output**: `career-ops/data/resume-gap-audit.md` with two-column table `current bullet → proposed rewrite` grouped by archetype. Paste-ready text only — DO NOT generate PDF (rule 2). User updates the PDF source files separately.

#### W5. Cloudify + EEG GitHub polish (parallel pair)

**Pre-flight**: `ls /Users/anmolsahu2k/Stuff/Create/cloudify/` and `ls /Users/anmolsahu2k/Stuff/Create/EEG_Classification/`. If either path is missing, stop and ask user — do not invent paths or scaffold new repos.

**Cloudify inputs**: `/Users/anmolsahu2k/Stuff/Create/cloudify/` — read README.md, ARCHITECTURE.md, PROJECT_SUMMARY.md, walk the agents/ directory.

**Cloudify audit targets** (recruiter-facing weak spots): missing demo gif/video in README hero, no one-line quickstart, no test/CI badge, agent eval traces not surfaced, architecture diagram only in ARCHITECTURE.md (not README itself).

**EEG inputs**: `/Users/anmolsahu2k/Stuff/Create/EEG_Classification/` — README was just refreshed (multi-head CNN+Transformer, Task 2 CLIP retrieval, PSC HPC infra). Audit code structure (data loaders, model files, sbatch scripts, configs) for additional polish.

**Output**: `career-ops/data/github-polish-cloudify.md` + `career-ops/data/github-polish-eeg.md`. Each: ordered list of changes, each ≤5-line diff, ready to commit. User commits.

#### W12. Application-tactics playbook extension + audit — RUN AFTER W3

**Dependency**: W3 must be complete. W12 reads W3's machine-readable scorecard at top of `career-ops/data/cover-letter-audit.md` rather than re-scoring from scratch. The dedup mechanism: W12 only flags issues NOT already flagged by W3 (rule violations, principle gaps, missing playbook coverage); it does not re-score the 6 W3 dimensions.

**Inputs**: read `career-ops/templates/application-tactics.md` (current TOC inlined in section 3.6). Cross-reference against the 20 cover-letter files and any form-answer files in `reports/`. Read W3 scorecard.

**Extend playbook** with 5 new sections:
1. AI-lab-specific form patterns (Anthropic / OpenAI / Cohere / Hippocratic-style: "what makes you a good fit?", "tell us about a project you're proud of", "what do you want to learn this summer?")
2. Behavioral / values-fit form patterns (Airbnb core values, Stripe operating principles, Brex production-fintech voice, Cloudflare AI-native energy)
3. Case-study / take-home prompt handling (time-boxing, scope-narrowing, deliverable structure)
4. Portfolio-link expectation handling (ties into W10 — what to put when JD asks for personal site)
5. Pittsburgh / on-site / relocation question patterns + AI-disclosure honest-answer template

**Audit pass**: cross-reference each `reports/0XX-*-cover-letter.md` and `0XX-*-application-questions.md` against extended playbook; flag answers that violate principles (volunteers visa context unsolicited, lowballs salary, claims a referral without consent).

**Outputs**:
- Extended `career-ops/templates/application-tactics.md`
- `career-ops/data/application-tactics-audit.md` (per-file findings list, ONLY items not already in W3 scorecard)

**DO NOT**: rewrite already-submitted form answers silently. Same advisory-only rule as W3 for the 21 Applied entries.

#### W10. Portfolio site — fresh Next.js build

**Context**: anmolsahu2k.github.io currently shows undergrad projects (Classly, Vishleshan, Sahayak, Medbuddy, Healthcare Diagnosis Assistant, Personalized Content Generator). Cloudify, EEG Classification, and Highmark are NOT shown. Single biggest signal-loss vs the resume PDF.

**User decision**: skip the existing site; build a fresh standalone Next.js 14 (App Router) portfolio in this repo at `portfolio/`.

**Stack**: Next.js 14 App Router, Tailwind, shadcn/ui (or hand-rolled), framer-motion for subtle anims. Vercel-deployable. Use the `frontend-design` skill before implementation. **If the skill produces multiple design variants, ship ONE end-to-end (the strongest); save the others as `portfolio/docs/design-alternatives.md` for the user to optionally swap later.** Do not block on variant selection.

**PDF asset hosting decision**: Resume PDFs (SDE + MLE) are local files in the workspace root, not hosted publicly. Two options for the download buttons: (a) drop both PDFs into `portfolio/public/` and ship them with the deploy (the URLs become anmolsahu2k.com/SDE-Resume.pdf etc.); (b) link to the GitHub raw URL in a public anmolsahu2k repo. Default to **option (a)** — it's one less moving piece. Add a `portfolio/public/README.md` reminding the user to swap in fresh PDFs when they update their resume.

**Sections**:
- Hero: name, role (CMU MISM, expected Dec 2026), one-line pitch, contact links
- About: Anmol's narrative (Byju's → CMU → ML/agents). NO CPT/visa explainer (rule 3).
- Featured Projects (top, expanded cards): Cloudify, EEG Classification, Highmark cancer-staging
- Other Projects (compact grid): Personalized Content Generator, Multimodal Sentiment Stock Prediction, Classly (Red Hat winner $10K), Sahayak, Vishleshan, Medbuddy
- Experience: Byju's SDE + intern entries
- Achievements: 6 hackathon wins (~$22K)
- Resume download buttons (SDE PDF / MLE PDF)
- Skills section grouped by category (matches cv.md)
- Footer: GitHub, LinkedIn, email

**Outputs**:
- `portfolio/` — full Next.js 14 scaffold
- `portfolio/README.md` — local dev + Vercel deploy instructions
- `career-ops/data/portfolio-content.md` — single source of all portfolio copy (so user can edit text without touching code)

**User actions after build**: review locally (`npm run dev`), deploy to Vercel, point a domain at it.

### Phase 2 — after Phase 1 (2 workstreams)

#### W2. Faculty paper deep-reads (12 parallel)

**Context**: "P2" = paragraph 2 of each `faculty_emails/0X.md` — the technical hook paragraph. Currently each cites one PI paper. Goal: pull each PI's 2-3 most recent (2025-26) papers, identify the strongest technical thread vs Anmol's Cloudify+Highmark+EEG profile (full blurb in section 3.6 — pass it to each subagent), rewrite P2 to ask one substantive technical question that proves Anmol read the work.

**Inputs**: `faculty_emails/01-12.md` (one per PI). Each file names the PI and current paper reference.

**Method**: For each PI, launch one Explore subagent that:
1. WebFetches the PI's homepage + Google Scholar + named lab page
2. Reads 2-3 most recent (2025-26) papers
3. Identifies one strongest technical thread vs the Anmol profile blurb (section 3.6)
4. Returns a sharpened P2 paragraph (one paper title + one substantive technical question)

**Cap**: 4 concurrent WebFetch (12 PIs in 3 batches of 4) to avoid rate limits.

**Time-box**: 4 hours total. If a deep-read does not produce a clearly sharper P2 for a given PI, the existing P2 stays unchanged (no regression risk to Saturday send batch).

**Stop conditions** (per PI):
- PI has no papers from 2025 or 2026 → keep existing P2; note this in `career-ops/data/faculty-deep-read-log.md`
- PI's homepage 404s or Google Scholar profile is private → keep existing P2
- WebFetch hits rate limit (429) → pause, retry with smaller batch
- Drafted P2 cannot be made meaningfully sharper than existing → keep existing

**Output**: each `faculty_emails/0X.md` updated inline with sharpened P2 (or noted as kept). Per-PI rationale logged to `career-ops/data/faculty-deep-read-log.md`.

**DO NOT SEND**: rule 7. These are drafts. User reviews each updated email before sending Saturday. Patch the file, do not invoke any send mechanism.

#### W11. Execute HANDOFF-pipeline-expansion.md (subset)

**Inputs**: read `career-ops/HANDOFF-pipeline-expansion.md` in full. That file specifies 21 changes; this workstream executes the high-leverage subset (skip items duplicated by other workstreams or marked future-scope by user).

**Subset to execute** (groups must respect parallelism rules below):

**Group 1 — adapters (parallelizable; each writes its OWN TSVs to `batch/tracker-additions/`, never direct-edits applications.md or intern_shortlist.md)**

1. **B6-B8 aggregator intake**
   - `career-ops/scripts/aggregator-intake.py` — fetch 3 README sources + existing SimplifyJobs, parse markdown tables, dedupe by URL.
   - Output: TSV per new candidate to `batch/tracker-additions/{NNN}-{slug}.tsv` per pipeline contract (section 3.5).
   - After group complete: run `node merge-tracker.mjs && node dedup-tracker.mjs && node verify-pipeline.mjs`.

2. **F19 Handshake CSV ingester**
   - `career-ops/scripts/handshake-ingest.py` — user exports saved searches from Handshake UI to `career-ops/data/handshake-{date}.csv`; ingester maps fields → TSVs in `batch/tracker-additions/`.
   - DO NOT scrape Handshake (ToS); manual CSV export only.

3. **A1 JobSpy adapter**
   - `career-ops/scripts/jobspy-ingest.py` — Python lib (no API keys), scrapes LinkedIn/Indeed/Glassdoor/Google/ZipRecruiter with `internship` filter and `hours_old` recency. Run batched, off-hours.
   - Output: TSVs to `batch/tracker-additions/`. Each TSV file is uniquely named so parallel adapters never collide.
   - After this adapter completes (and after the whole Group 1 batch): run `node merge-tracker.mjs && node dedup-tracker.mjs && node verify-pipeline.mjs` per section 3.5 #4.
   - **Stop condition**: if scraper triggers captcha or 429 from any source, stop that source and surface to user.

**Group 2 — single-file edits (MUST run serially, never parallel — each writes to one shared file)**

4. **C9-C11 portal config additions** (`career-ops/portals.yml` — single shared file)
   - SERIAL ORDER: C9 → C10 → C11. Each step reads the file, appends, writes. Never two at once.
   - C9: 6 niche AI/ML boards (moaijobs.com, aijobs.app, aimljobs.fyi, deeplearningjobs.com, aijobs.18offers.com, agentic-engineering-jobs.com)
   - C10: Diff career-copilot's `templates/portals.example.yml`; append new slugs
   - C11: Cross-reference hiring-without-whiteboards (verify Summer 2026 reqs exist before adding)
   - After C11 done: `node verify-pipeline.mjs` to confirm portals.yml still parses.

**Group 3 — template additions (parallelizable; each writes its own new file)**

5. **D12-D14 eval template fields**
   - **Pre-flight**: `cat reports/021-nuro-2026-04-25.md | head -30` to confirm current header shape before mutating.
   - Extend the eval-report header structure (section 3.6). Insert three new fields AFTER `**Legitimacy:**`, BEFORE Block A: `**Level strategy:**`, `**Comp research:**`, `**Sponsorship flag:**`.
   - **Do NOT touch the `**URL:**` header.** The dashboard regex `^\*\*URL:\*\*\s*(https?://\S+)` must continue to match.
   - **Strip the artifact `**Apply:**` line** while you're in there (per section 3.5 #3, it's a stale artifact; only `**URL:**` is the contract). Apply this cleanup ONLY in the representative report being updated; do not bulk-rewrite the other 22 reports without explicit user ask.
   - Update one representative report (e.g., `reports/021-nuro-2026-04-25.md`) as the new template; document the structure in `career-ops/templates/eval-report.md` (new file) so future evals follow it.
   - Verify with `node verify-pipeline.mjs` after.

6. **E15-E17 interview prep templates**
   - **Pre-flight**: `ls career-ops/interview-prep/` — `story-bank.md` already exists. Read it before writing anything new. E16 must extend or reference, not duplicate.
   - E15: `career-ops/templates/star-plus-r-framework.md` — STAR + Reflection
   - E16: `career-ops/templates/5ws-storytelling.md` — applies What/Why/How/When/Who to Byju's, Highmark, Cloudify, EEG bullets. **Use the interview-honesty caveat from section 3.6** — output must include "deep-dive prep" sections with real technical details (not the inflated bullet text). Cross-reference with existing `career-ops/interview-prep/story-bank.md`.
   - E17: `career-ops/templates/pre-interview-checklist.md` — DSA warm-up topic list

**Subset to skip or defer**:
- A2 Adzuna, A3 Hiring Cafe, A4 startup.jobs, A5 Workday — Phase 2 scrapers; defer
- F18 Gmail ATS watcher, F20 LinkedIn email alerts, F21 CMU Career Center parser — same Gmail OAuth dependency as W7 (deferred this round)

### Phase 3 — scheduled jobs (3 workstreams)

#### W1. Daily candidate scan (scheduled)

**Wraps**: existing `career-ops/scan.mjs` (zero-token Greenhouse/Ashby/Lever scanner).

**Cron**: daily 7am Pittsburgh. Use `CronCreate` or `/schedule` skill.

**Daily flow**:
1. Run `node scan.mjs`
2. Fetch SimplifyJobs/Summer2026-Internships README, diff vs `career-ops/data/scan-history.tsv`
3. Pull from W11's aggregator-intake (B6-B8) + JobSpy (A1) outputs
4. For each new ≥4.0 candidate, auto-create eval report + cover letter via standard auto-pipeline (rule 4)
5. Cap auto-cover-letter generation at 5/day; queue overflow to triage list
6. Post daily digest to `career-ops/data/daily-digest-{YYYY-MM-DD}.md`

**Output**: `career-ops/scripts/daily-scan-cron.mjs` wrapper + cron entry.

#### W8. Company news monitor (weekly)

**Cron**: weekly Sunday evening.

**Flow**: for each of 23 tracker entries (21 Applied + 2 SKIP), WebSearch + WebFetch for funding / product launch / leadership hire / eng blog in last 7 days.

**Output**: `career-ops/data/news-digest-{YYYY-WW}.md` with one fresh outreach hook per company that has news. Use these for follow-up touches on silent applications (>7d no response).

#### W9. Tracker hygiene cron (daily)

**Wraps**: existing `career-ops/followup-cadence.mjs` AND `career-ops/check-liveness.mjs`.

**Cron**: daily 8am.

**Flow**:
1. Run `node check-liveness.mjs` first → flag any tracker entry whose JD URL is now dead (404, "this position has been filled", etc.). Mark `Status: Discarded` for confirmed-dead postings (canonical state per section 3.5). Don't chase follow-ups on dead postings.
2. Run `node followup-cadence.mjs` → flag any `Applied` row with Date >7 days ago and no Status change → append to `career-ops/data/follow-ups.md`.
3. Cross-reference W1's daily digest to detect new postings already in tracker (avoid duplicate evals).
4. Run `node verify-pipeline.mjs` to confirm tracker integrity after all writes.

**Output**: cron entry running the three scripts in sequence.

### Future scope (do NOT execute this round)

- **W6 Alumni outreach v2** — needs alum LinkedIn URL list from user; revisit when first interview lands or Saturday faculty batch is done
- **W7 Inbox watcher** — Gmail MCP currently disconnected; revisit after first interview lands
- **W11 deferred subset** — Adzuna / Hiring Cafe / startup.jobs / Workday scrapers (A2-A5), F18 Gmail ATS watcher, F20 LinkedIn alerts, F21 CMU Career Center parser

### Permanently skipped

- **Hackathon-to-hire outreach** — hackathons were ~4 years ago in undergrad; connection too cold to be useful

### Deferred until first interview lands

- Per-company interview prep packets (~21 parallel subagents, ~1 hr) — tech stack deep-dive, recent eng blog, top-5 DSA patterns, top-10 behavioral Qs with mapped STAR stories, hiring-manager intel, comp band
- Behavioral STAR story bank matrix (12-15 stories scored against Amazon LP / Stripe Operating Principles / FAANG buckets)
- Daily DSA drill (curated to next-likely interview company)
- Mock interview rounds (subagent-as-interviewer for 45-min loops)
- Negotiation prep doc (comp bands, counter scripts, multi-offer leverage timing)
- Visa/CPT calendar (course reg, I-20, SEVIS, decision dates on one timeline)

## 5. Verification per workstream

Confirm before marking done:

| Workstream | Verify by |
|---|---|
| W3 | Scorecard scores all 20 letters; URL-header bug fixed; any letter scoring <3.5 flagged for rewrite |
| W4 | Audit doc has ≥10 paste-ready bullet rewrites |
| W5 | Each repo polish doc has ≥5 actionable items, each ≤5-line diff |
| W12 | Extended playbook covers all 5 new sections; audit produces per-file fix list deduped against W3 |
| W10 | Next.js portfolio runs locally (`npm run dev`); all sections render with Cloudify+EEG+Highmark prominent; Lighthouse score >90 |
| W2 | Each upgraded P2 cites a 2025-26 paper title + asks one specific technical question (not generic) |
| W11 | Per HANDOFF-pipeline-expansion.md section 6: each adapter returns ≥1 row with title/company/url; intern_shortlist.md grows by ≥50 unique rows; portals.yml parses cleanly; new template fields render; `**URL:**` regex still matches dashboard O-key |
| W1 | Daily digest file appears next morning; ≥1 new candidate surfaced in week-1 |
| W8 | First weekly digest has news hooks for ≥5 of 23 companies |
| W9 | follow-ups.md gets fresh entries on day 8 after Apply |

After every change touching `career-ops/data/applications.md` or `reports/`: confirm Go TUI dashboard still parses cleanly and O-key opens URLs.

## 6. Out-of-scope / DO NOT touch

- The 9-column tracker schema in `career-ops/data/applications.md`
- The `**URL:**` regex contract in eval reports
- CV/resume PDFs (rule 2)
- Cover letter, form-answer, or outreach text — rules 1, 3, 4 govern; user sends, not the agent
- The OIE inquiry email (deferred until offer in hand)
- Any auto-applier (LinkedIn Easy Apply, etc.) — conflicts with per-role eval-plus-cover-letter workflow
- Pushing commits to any repo
- Sending faculty / alumni / OIE emails — drafts only
- Already-submitted cover letters: surface audit findings; do NOT silently regenerate

## 7. Source repos quick-reference

| Code/feed | URL | Used by |
|---|---|---|
| JobSpy | https://github.com/speedyapply/JobSpy | W11 A1 |
| 2026-SWE-College-Jobs | https://github.com/speedyapply/2026-SWE-College-Jobs | W11 B6 |
| 2026-AI-College-Jobs | https://github.com/speedyapply/2026-AI-College-Jobs | W11 B7 |
| Summer2027-Internships | https://github.com/vanshb03/Summer2027-Internships | W11 B8 (misnamed; covers Summer 2026) |
| SimplifyJobs Summer 2026 | https://github.com/SimplifyJobs/Summer2026-Internships | W1, W11 |
| awesome-job-boards | https://github.com/tramcar/awesome-job-boards | W11 C9 source |
| career-copilot | https://github.com/RajjjAryan/career-copilot | W11 C10 diff source |
| hiring-without-whiteboards | https://github.com/poteto/hiring-without-whiteboards | W11 C11 source |
| job-ops | https://github.com/DaKheera47/job-ops | W11 D14 sponsorship heuristic |
| jobseeker-analytics | https://github.com/JustAJobApp/jobseeker-analytics | W7 (future scope) |
| getting-a-gig | https://github.com/cassidoo/getting-a-gig | W11 E16 / E17 framework source |
| Anmol Cloudify | https://github.com/anmolsahu2k/cloudify | W5, W10 |
| Anmol EEG_Classification | https://github.com/anmolsahu2k/EEG_Classification | W5, W10 |
| Anmol portfolio (current, stale) | https://anmolsahu2k.github.io | W10 (replaced by fresh Next.js) |

## 8. Memory files to consult

Auto-loaded from `/Users/anmolsahu2k/.claude/projects/-Users-anmolsahu2k-Stuff-Create-Amazon/memory/`:

- `feedback_interview_honesty.md` — Byju's bullets need real-detail prep before phone screens (drives W11 E16)
- `feedback_no_em_dashes.md` — rule 1
- `feedback_no_cv_pdf.md` — rule 2
- `feedback_no_cpt_explainer.md` — rule 3
- `feedback_default_cover_letter.md` — rule 4
- `project_target_roles.md` — rule 5; drives W4 archetype mapping
- `reference_oie_cpt.md` — CPT facts (10-day, no backdating, no India remote CPT)
- `project_amazon_interview.md` — Amazon SDE Intern status PENDING (do NOT assume rejected)
- `project_eeg_classification.md` — strongest MLE portfolio asset; drives W5 EEG and W10 portfolio

Also read at session start: `/Users/anmolsahu2k/Stuff/Create/Amazon/CLAUDE.md` and `/Users/anmolsahu2k/Stuff/Create/Amazon/career-ops/CLAUDE.md`.

## 9. Stop conditions

Stop and ask the user if:

- The 9-column tracker schema would need to change to support a workstream
- Any workstream would write rows directly to `applications.md` instead of TSV-via-`batch/tracker-additions/` (section 3.5 contract)
- `verify-pipeline.mjs` exits non-zero after a workstream's writes
- An adapter's data quality is poor enough that bad rows are entering the tracker
- Handshake or LinkedIn ToS would be violated by the chosen approach
- A workstream's output would be sent externally (email, LinkedIn message, commit push) — drafts only without explicit ask
- W3 audit identifies an already-submitted cover letter scoring <3.0 — surface, do not auto-resubmit
- W11 D12-D14 template changes would break the dashboard `**URL:**` regex
- W11 D12-D14 introduces a non-canonical state value into `applications.md` (must match `templates/states.yml`)
- W10 portfolio build encounters a design choice user should make (color scheme, typography, deploy target beyond Vercel default)
- W10 needs to deploy or push — drafts/local-only without explicit ask
- W11 A1 JobSpy hits captcha or HTTP 429 — stop that source, surface to user
- W1's `scan-history.tsv` shows corruption (parse errors)
- W1 detects SimplifyJobs README schema has changed (table parser breaks)
- Faculty deep-reads in W2 hit WebFetch rate limits — pause and batch smaller
- Faculty PI has no 2025-26 papers OR PI homepage 404s OR Google Scholar private — keep existing P2, log, do not invent papers
- W2 wants to send any faculty email — drafts only; user sends Saturday
- Any source repo's license is incompatible with personal-use integration
- Anmol's inbox auth is needed (W7 future scope, but if surfaces earlier)
- Cloudify or EEG_Classification path doesn't exist on disk (W5 pre-flight) — do not invent or scaffold; ask

## 10. Execution order summary

| Phase | Workstreams | Parallelism |
|---|---|---|
| 1a | W3, W4, W5 | 3 parallel subagents |
| 1b | W12 | runs after W3 (depends on W3 scorecard) |
| 1c | W10 | main thread, can overlap with 1a/1b |
| 2 | W2, W11 | W2 = 12 PI subagents in 3 batches of 4; W11 split into Group 1 (parallel adapters), Group 2 (serial portals.yml edits), Group 3 (parallel template files) |
| 3 | W1, W8, W9 | 3 scheduled jobs set up in parallel; W1 depends on W11 Group 1 having shipped at least once |
| Future | W6, W7, deferred W11 subset | Do NOT execute this round |

**Hard sequencing rules**:
- W12 starts only after W3 outputs `cover-letter-audit.md`
- W11 Group 2 (C9-C11) is internally serial (single shared file)
- W11 Groups 1, 2, 3 can overlap each other (different files), but each adapter inside Group 1 must write its own uniquely-named TSVs to avoid collision
- After every W11 Group 1 batch: run `merge-tracker.mjs && dedup-tracker.mjs && verify-pipeline.mjs`
- W1 daily cron should not start until after one manual successful run of the full Group 1 + merge sequence
