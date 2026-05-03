# Career-Ops Pipeline Expansion — Agent Handoff

Self-contained brief for an agent picking up this work cold. Read top to bottom before touching anything.

---

## 1. Mission

Expand the career-ops internship-search pipeline by adding 21 concrete changes across new scraping adapters, aggregator feeds, portal config, eval templates, interview prep, and email-driven monitoring. Goal: maximize Summer 2026 internship coverage for an F-1 CMU MISM student (Anmol) without breaking existing tracker schema or guardrails.

## 2. Operating context

**User:** Anmol Sahu. CMU MISM (Heinz, Dec 2026), F-1 visa, CPT-eligible. 2.5 yrs SDE at Byju's. Targeting Summer 2026 internships in SDE / AI / MLE / DS / DE / DA. US-based primary, India remote acceptable (no CPT). Final-round Amazon SDE Intern interview was Apr 8 2026; status pending.

**Project layout** (all paths relative to `/Users/anmolsahu2k/Stuff/Create/Amazon/`):

```
career-ops/
  config/profile.yml            # Anmol-specific config + internship_constraints
  cv.md                         # source-of-truth CV (DO NOT regenerate PDFs)
  data/
    applications.md             # 9-COL TRACKER — schema is FROZEN
    intern_shortlist.md         # initial scan top 25
    simplifyjobs_summer2026_picks.md
    alumni_outreach_priorities.md
  modes/_profile.md             # intern-specific archetypes
  portals.yml                   # portal config (Greenhouse/Ashby/Lever slugs)
  reports/                      # per-app eval + cover letter + form Qs
  templates/
    alumni-outreach.md
    faculty-cold-email.md
    application-tactics.md
  merge-tracker.mjs             # 9-col tracker merger (DO NOT change schema)
  scripts/                      # build helpers — add new ingesters here
```

**Tracker schema (9 columns, frozen):**
```
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
```
The Go TUI dashboard parses `fields[5]=Status, fields[6]=PDF, fields[7]=Report, fields[8]=Notes`. Adding a 10th column breaks the dashboard.

Embed cover-letter info inside Notes column with prefixes:
- `CL: [filename](path)` — cover letter only
- `CL+Q: [filename](path)` — cover letter + form answers
- `Form Qs: [filename](path)` — form answers only

Eval reports MUST include a `**URL:**` line (not `**Apply:**`) — the dashboard's O-key URL-open regex is `^\*\*URL:\*\*\s*(https?://\S+)`.

## 3. Hard rules — DO NOT violate

1. **No em-dashes or en-dashes** (`—`, `–`) in any candidate-facing content. Use commas, periods, colons, or rephrase.
2. **Do NOT generate CV PDFs.** User submits own resumes (`SDE Anmol's Resume(28-02-26)_v3-FINAL.pdf`, `MLE Anmol's Resume(28-02-26)_v3.pdf`).
3. **Do NOT include the F-1/CPT/Heinz/OIE/May 12/June 1 explainer paragraph** in cover letters, form answers, faculty emails, or alumni outreach. If start date is asked, just say "Available June 2026."
4. **Auto-draft cover letter for every top-tier (≥4.0) job** as part of the evaluation. Don't ask. Skip only for SKIP-status or hard-blocked roles.
5. **Target roles only:** SDE, AI, MLE, DS, DE, DA Intern + adjacents. US (in-person/remote) primary; India remote acceptable but no CPT.
6. **Do NOT change the 9-column tracker schema.**
7. **Do NOT push commits, send emails/messages, or generate CV PDFs without explicit ask.**

## 4. The 21 changes

### A. New scraping adapters → `career-ops/scripts/`

**A1. JobSpy adapter**
- Source: https://github.com/speedyapply/JobSpy
- Python lib, no API keys. Scrapes LinkedIn, Indeed, Glassdoor, Google, ZipRecruiter.
- Has built-in `internship` job-type filter and `hours_old` recency filter.
- LinkedIn rate-limits hard — run batched, off-hours, or with proxies.
- Deliverable: `career-ops/scripts/jobspy-ingest.py` — outputs CSV, then merger into `intern_shortlist.md`.

**A2. Adzuna adapter**
- Source pattern: `DaKheera47/job-ops` `/extractors/` directory at https://github.com/DaKheera47/job-ops
- Adzuna has free API key, multi-country, US coverage.
- Deliverable: `career-ops/scripts/adzuna-ingest.py`.

**A3. Hiring Cafe adapter**
- Same source as A2.
- Hiring Cafe (hiring.cafe) aggregates 30k+ company career pages, tags sponsorship + remote — high signal.
- Deliverable: `career-ops/scripts/hiringcafe-ingest.py`.

**A4. startup.jobs adapter**
- Same source as A2.
- Startup-friendly, often more F-1 receptive than enterprise.
- Deliverable: `career-ops/scripts/startupjobs-ingest.py`.

**A5. Workday adapters from go-get-jobs**
- Source: https://github.com/kbhujbal/go-get-jobs
- Go-based, has dedicated Workday modules. CLAUDE.md flags "Workday mostly blocked" as a known gap.
- Evaluate first — port adapters only if they actually work. Strip the MongoDB layer; output JSON instead.
- Deliverable: `career-ops/scripts/workday-ingest.go` (or .py if porting).

### B. New aggregator feeds → markdown ingest, no scraping

**B6. speedyapply/2026-SWE-College-Jobs**
- Source: https://github.com/speedyapply/2026-SWE-College-Jobs
- ~276 USA SWE intern listings, ~395 USA new-grad. Updated daily, last 120 days.
- README is a markdown table with company / position / location / link.

**B7. speedyapply/2026-AI-College-Jobs**
- Source: https://github.com/speedyapply/2026-AI-College-Jobs
- ~279 USA AI/ML intern listings. Same format. Feeds the MLE PDF track.

**B8. vanshb03/Summer2027-Internships**
- Source: https://github.com/vanshb03/Summer2027-Internships
- Naming is misleading — README says "Collection of Summer 2026 tech internships."

**Combined deliverable:** `career-ops/scripts/aggregator-intake.py` — fetches the 3 READMEs above + the existing SimplifyJobs/Summer2026-Internships, parses tables, dedupes by URL, merges into `career-ops/data/intern_shortlist.md`. Run weekly.

### C. Portal config → `career-ops/portals.yml`

**C9. Add 6 niche AI/ML boards**
- Source: https://github.com/tramcar/awesome-job-boards
- Boards to add:
  - https://www.moaijobs.com/
  - https://aijobs.app
  - https://www.aimljobs.fyi
  - https://www.deeplearningjobs.com/
  - https://aijobs.18offers.com/
  - https://agentic-engineering-jobs.com (relevant to Anmol's Cloudify project)

**C10. Diff career-copilot portals**
- Source: https://github.com/RajjjAryan/career-copilot — file `templates/portals.example.yml`
- Lists 45+ pre-configured companies across Greenhouse, Ashby, Lever, Wellfound.
- Mechanical diff against `career-ops/portals.yml`; append any new slugs.

**C11. Cross-reference hiring-without-whiteboards**
- Source: https://github.com/poteto/hiring-without-whiteboards
- Filter the company list against Anmol's target criteria (must run Summer 2026 interns AND likely sponsor F-1).
- Candidates worth verifying before adding: Airtable, Algolia, Asana, Calendly, Checkr, GitHub, GitLab, HelloFresh, Hinge Health, Kong, Lattice, LaunchDarkly, Loom, Lyft, Mapbox, Miro, NerdWallet, Netlify, New Relic.
- For each: check careers page for a Summer 2026 intern req before adding the slug. Many of these (Automattic, Basecamp) don't run summer interns.

### D. Eval-template additions → `career-ops/reports/` template

**D12. Add "Level strategy" field**
- Source: career-copilot `modes/_shared.md`
- Captures whether the role targets intern-only, new-grad-only, or both.

**D13. Add "Comp research" field**
- Source: career-copilot `modes/_shared.md`
- Known intern stipend ranges if available (Levels.fyi, Glassdoor).

**D14. Add "Sponsorship flag" field**
- Source: https://github.com/DaKheera47/job-ops `/visa-sponsor-providers/` directory
- Read its sponsorship-detection heuristic; adapt into a Y/N/Unknown field on each eval. Stop asking the user every time.

Update the eval template in `career-ops/reports/` (find the existing template via `ls career-ops/reports/` — copy the structure from a recent report). Make sure the `**URL:**` header line is preserved (do not rename to `**Apply:**` — the dashboard regex breaks).

### E. Interview-prep additions → `career-ops/templates/`

**E15. STAR+R framework**
- Source: career-copilot `modes/interview-prep.md`
- STAR + Reflection. The Reflection step forces "what I'd do differently" — exactly what behavioral loops ask.
- Deliverable: `career-ops/templates/star-plus-r-framework.md`.

**E16. "5 W's" project-storytelling framework**
- Source: https://github.com/cassidoo/getting-a-gig
- Framework: What / Why / How / When / Who.
- Directly addresses the `feedback_interview_honesty.md` memory note: Byju's bullets need real-detail prep before phone screens.
- Deliverable: `career-ops/templates/5ws-storytelling.md`. Apply each W to each Byju's bullet and each project bullet on both resumes.

**E17. Pre-interview technical checklist**
- Source: same as E16.
- Topics: data types, bitwise operations, strings, arrays, linked lists, queues, stacks, heaps, trees, graph algorithms, hash maps, sorting, time complexity, paradigms (DP, OOP, async, functional).
- Deliverable: `career-ops/templates/pre-interview-checklist.md` — daily 30-min warm-up.

### F. Application monitoring + email-driven feeds (shared Gmail OAuth)

**F18. Gmail ATS-confirmation watcher**
- Source: https://github.com/JustAJobApp/jobseeker-analytics
- Two options:
  1. Self-host the full app (Docker Compose / Python venv).
  2. Steal `applied_email_filter.yaml` + parsing logic; wire into a small custom poller.
- Solves CLAUDE.md outstanding action #5 ("Watch ATS confirmation emails within 48h; flag silent submissions for resubmit").
- Deliverable: `career-ops/scripts/gmail-ats-watcher.py` + filter YAML.

**F19. Handshake CSV ingester**
- Highest single-source signal for F-1 CMU candidate (employers using Handshake have opted into university recruiting → more F-1 friendly).
- Handshake has no public API, behind CMU SSO. Workflow:
  1. User builds saved searches in Handshake UI: "SDE Intern Summer 2026", "MLE Intern", "DS Intern" with US + India remote filters.
  2. User exports each saved search to CSV weekly (5 min), drops into `career-ops/data/handshake-{YYYY-MM-DD}.csv`.
  3. Ingester maps Handshake fields → 9-col tracker rows + creates eval reports for ≥4.0 scores.
- Deliverable: `career-ops/scripts/handshake-ingest.py`.
- DO NOT build a Playwright auto-scraper without explicit user request — it violates Handshake ToS.

**F20. LinkedIn saved-search email alerts**
- Config-only (no code). User-side action.
- Set up 4 saved searches in LinkedIn UI:
  - Software Engineer Intern Summer 2026 USA
  - Machine Learning Intern Summer 2026 USA
  - Data Science Intern Summer 2026 USA
  - SDE Intern Summer 2026 India remote
- Turn on weekly email digests for each.
- These emails feed the F18/F21 Gmail parser — bypasses LinkedIn rate limits because LinkedIn sends data to you.
- Deliverable: written instructions for the user, no code.

**F21. CMU Career Center newsletter parser**
- User receives a weekly newsletter from CMU Career Center with curated job-posting URLs. Pre-curated, F-1-aware.
- Deliverable: `career-ops/scripts/career-center-newsletter.py`.
  - Gmail API auth (shared OAuth with F18).
  - Filter: `from:careers@andrew.cmu.edu OR from:heinzcareerservices@cmu.edu OR subject:"weekly newsletter"`. Verify exact sender by inspecting Anmol's inbox first.
  - Extract URLs via regex; for each URL fetch JD and run through standard eval flow.
  - Output to `career-ops/data/career-center-{week}.md`; promote ≥4.0 to `intern_shortlist.md`.

## 5. Execution order

Bumped F19 (Handshake) and F21 (newsletter) up because they're the highest-signal sources for an F-1 CMU candidate.

1. **B (#6-8)** — three aggregator feeds in one intake script. Cheapest, biggest immediate yield.
2. **F19 Handshake ingester** — manual CSV export workflow + parser.
3. **F18 + F21 together** — Gmail OAuth setup once, two consumers (ATS watcher + Career Center parser).
4. **F20** — LinkedIn email alerts. 5-minute config, no code.
5. **A1 JobSpy** — fills LinkedIn / Indeed gap.
6. **C (#9-11)** — portal config additions.
7. **A2-5** — Adzuna / Hiring Cafe / startup.jobs / Workday adapters.
8. **D (#12-14)** — eval template fields.
9. **E (#15-17)** — interview prep templates.

## 6. Verification per change

For each change, confirm before marking done:

| Change | Verification |
|---|---|
| A1 JobSpy | `python career-ops/scripts/jobspy-ingest.py --keyword "software engineer intern" --limit 10` returns ≥1 row with title/company/url |
| A2-A4 | Adapter outputs at least 5 valid US listings with URL field populated |
| A5 Workday | At least 1 Workday-hosted req returned for a known company (e.g., Stripe, Square) |
| B6-B8 | `intern_shortlist.md` grows by ≥50 unique rows after intake script runs; no duplicates by URL |
| C9-C10 | `portals.yml` parses cleanly; new entries follow existing schema; no duplicate slugs |
| C11 | Each added company has a verified Summer 2026 intern req URL in the eval report |
| D12-D14 | New eval template renders correctly; `**URL:**` header still present; dashboard O-key still opens URLs |
| E15-E17 | Files exist in `career-ops/templates/` and link from a top-level index |
| F18 | Watcher detects a known confirmation email in Anmol's inbox and writes a tracker note |
| F19 | Drop a sample Handshake CSV; ingester produces ≥1 valid 9-col tracker row |
| F20 | Anmol confirms 4 alerts arrive in inbox within 7 days |
| F21 | Parser reads one real CMU newsletter email and extracts ≥3 URLs |

After every change: re-open the Go TUI dashboard and confirm it still parses `applications.md` (no schema break, O-key still opens URLs).

## 7. Out-of-scope / DO NOT touch

- The 9-column tracker schema in `career-ops/data/applications.md`.
- The `**URL:**` regex contract in eval reports.
- CV/resume PDFs (rule 2).
- Any cover letter / form-answer / outreach text — rules 1, 3, 4 govern those, and the user sends them, not the agent.
- The OIE inquiry email (deferred until offer in hand).
- Auto-applying via LinkedIn Easy Apply or any auto-applier — conflicts with the per-role eval-plus-cover-letter workflow.
- Pushing commits to any repo.

## 8. Source repos quick-reference

| Code/feed | URL |
|---|---|
| JobSpy | https://github.com/speedyapply/JobSpy |
| go-get-jobs | https://github.com/kbhujbal/go-get-jobs |
| job-ops | https://github.com/DaKheera47/job-ops |
| career-copilot | https://github.com/RajjjAryan/career-copilot |
| jobseeker-analytics | https://github.com/JustAJobApp/jobseeker-analytics |
| 2026-SWE-College-Jobs | https://github.com/speedyapply/2026-SWE-College-Jobs |
| 2026-AI-College-Jobs | https://github.com/speedyapply/2026-AI-College-Jobs |
| Summer2027-Internships | https://github.com/vanshb03/Summer2027-Internships |
| SimplifyJobs Summer 2026 | https://github.com/SimplifyJobs/Summer2026-Internships |
| awesome-job-boards | https://github.com/tramcar/awesome-job-boards |
| hiring-without-whiteboards | https://github.com/poteto/hiring-without-whiteboards |
| getting-a-gig | https://github.com/cassidoo/getting-a-gig |

## 9. Memory files to consult

Auto-loaded from `/Users/anmolsahu2k/.claude/projects/-Users-anmolsahu2k-Stuff-Create-Amazon/memory/`:

- `feedback_interview_honesty.md` — Byju's bullets need real-detail prep (drives E16)
- `feedback_no_em_dashes.md` — rule 1
- `feedback_no_cv_pdf.md` — rule 2
- `feedback_no_cpt_explainer.md` — rule 3
- `feedback_default_cover_letter.md` — rule 4
- `project_target_roles.md` — rule 5
- `reference_oie_cpt.md` — CPT facts (10-day, no backdating, no India remote CPT)
- `project_amazon_interview.md` — Amazon status PENDING
- `project_eeg_classification.md` — strongest MLE portfolio asset

## 10. Stop conditions

Stop and ask the user if:
- Any source repo's license is incompatible with personal-use integration.
- A planned change would require modifying the 9-column tracker schema.
- Handshake or LinkedIn ToS would be violated by the chosen approach.
- An aggregator's data quality is poor enough that bad rows are entering the tracker.
- Anmol's inbox auth blocks Gmail OAuth setup.
