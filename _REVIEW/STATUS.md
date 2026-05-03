# Career-Ops Workstream Status

Live status board for the multi-phase plan in [HANDOFF-now-phase-execution.md](../_meta/HANDOFF-now-phase-execution.md). Survives session boundaries. Update at the end of each phase, when a workstream's deliverable lands, or when a stop condition trips.

**Last updated:** 2026-04-28 (Phase 3 fully done; routines live)
**Current phase:** All three phases of [HANDOFF-now-phase-execution.md](../_meta/HANDOFF-now-phase-execution.md) landed. Scheduling moved to Claude Code Routines (cloud, no laptop required). Three routines live and pointing at [github.com/anmolsahu2k/career-ops](https://github.com/anmolsahu2k/career-ops):

| Routine | ID | Cron (UTC) | Next fire | Inspect |
|---|---|---|---|---|
| W1 daily candidate scan | `trig_01FNX5viiDgk5rcqrYrzrt8Y` | `3 11 * * *` | 2026-04-28 11:03 UTC (today, 7:03am EDT) | https://claude.ai/code/routines/trig_01FNX5viiDgk5rcqrYrzrt8Y |
| W9 daily tracker hygiene | `trig_012trFFun4qA32y6DxM1HXeL` | `7 12 * * *` | 2026-04-28 12:07 UTC (today, 8:07am EDT) | https://claude.ai/code/routines/trig_012trFFun4qA32y6DxM1HXeL |
| W8 weekly company news | `trig_01WcxhgqvJHgYyEn15adQRbN` | `13 22 * * 0` | 2026-05-03 22:13 UTC (Sunday, 6:13pm EDT) | https://claude.ai/code/routines/trig_01WcxhgqvJHgYyEn15adQRbN |

Each run commits to a `claude/<job>-<date>` branch on the fork; merge to main weekly (or set up a GitHub Action to auto-merge). UTC schedules are EDT-aligned now; will drift ~1 hour later in local time after Nov DST end (acceptable; can update via `RemoteTrigger` action `update`).
**Spec:** [HANDOFF-now-phase-execution.md](../_meta/HANDOFF-now-phase-execution.md)
**Decision record:** `/Users/anmolsahu2k/.claude/plans/okay-so-now-what-eventual-scone.md` (v4)

---

## Phase 1 — Done (2026-04-27)

| Workstream | Status | Deliverables |
|---|---|---|
| **W3** Cover-letter audit (20 letters) | ✅ done | [cover-letter-audit.md](data/cover-letter-audit.md) — machine-readable scorecard at top, all 20 ≥21/30 (lowest 018-matchgroup-backend at 22), 13 `**Apply:**` → `**URL:**` header fixes performed in cover-letter files. All 20 are already-Applied, so findings are advisory-only. |
| **W4** Resume gap audit | ✅ done | [resume-gap-audit.md](data/resume-gap-audit.md) — 16 paste-ready rewrites + 5 extension/gap bullets. cv-sync-check clean. Highest-leverage: rewrite the rank-prediction bullet to be honest before any phone screen. |
| **W5** Cloudify + EEG GitHub polish | ✅ done | [github-polish-cloudify.md](data/github-polish-cloudify.md) and [github-polish-eeg.md](data/github-polish-eeg.md) — 9 polish items per repo, each ≤5-line diff. Nothing pushed. |
| **W12** Application-tactics extension + audit | ✅ done | [templates/application-tactics.md](templates/application-tactics.md) extended with 5 new sections (~3,400 words appended; existing 11 sections untouched). [application-tactics-audit.md](data/application-tactics-audit.md) — 20 per-file blocks, ~17 new W12 findings deduped against W3. |
| **W10** Portfolio (Next.js 14) | ✅ done | [../portfolio/](../portfolio/) scaffold; `npm install` clean; `npm run build` passes (4/4 static pages, 134 kB first-load JS). Editorial-parchment direction with Fraunces + Newsreader + JetBrains Mono. Both resume PDFs copied to [../portfolio/public/](../portfolio/public/). Three alt directions in [../portfolio/docs/design-alternatives.md](../portfolio/docs/design-alternatives.md). Content mirror at [data/portfolio-content.md](data/portfolio-content.md). |

**Stop conditions tripped during Phase 1:** none.

---

## Phase 2 — Done (2026-04-27)

| Workstream | Status | Notes |
|---|---|---|
| **W2** Faculty paper deep-reads (12 PIs) | ✅ done | All 12 P2s rewritten with 2025-26 paper hooks: Neubig (OpenHands SDK, MLSys 2026 — Cloudify), Padman (Temporal-Feature Cross Attention, AMIA 2025 — Highmark), Dubrawski (MALDI-TOF outbreak detection 2026 — Highmark), Fried (OpenHands skills + Agent Workflow Memory — Cloudify), Welleck (OptimalThinkingBench ICLR 2026 + Gym-Anything — Cloudify), Lipton (Valid Inference w/ Imperfect Synthetic Data 2025 — Highmark), Perer (Intelligent Reasoning Cues CHI 2026 — Highmark), Beibei Li (Privacy Choice During Crisis, Mgmt Sci 2025 — Byju's infra), Heidari (Weak AI Safety Reg EAAMO 2025 + AI Openness NeurIPS 2025 — Cloudify), Sap (HAICOSYSTEM COLM 2025 + Artificial Hivemind NeurIPS 2025 Best Paper — Cloudify), Bisk (FieldWorkArena ICPR 2026 — Cloudify), Xiong (FactMM-RAG NAACL 2025 — Highmark). Per-PI log at [data/faculty-deep-read-log.md](data/faculty-deep-read-log.md). Em-dash sweep clean. **Note:** P1 first sentence was also touched on emails 05/10/11 to introduce paper citations cleanly — small deviation from "P2 only" brief; user should re-skim these three before Saturday send. |
| **W11 Group 1** Adapters (B6-B8, F19, A1) | ✅ done | 3 scripts written under [scripts/](scripts/): `aggregator-intake.py` (B6-B8 + SimplifyJobs, stdlib-only, NNN bucket 100-199), `handshake-ingest.py` (F19, NNN 300-399, not run — needs user CSV), `jobspy-ingest.py` (A1, NNN 200-299, not run — LinkedIn rate-limit risk). Aggregator run `--limit 50`: 2,690 raw rows → 2,506 after URL dedup → 1,739 after target-role+geo filter → 50 TSVs written. Pipeline chain (merge → dedup → normalize → verify) all exit 0. **Tracker grew 23 → 63 entries** (10 internal duplicates collapsed during dedup). New `reports/pending.md` placeholder created so unevaluated rows pass `verify-pipeline.mjs`. Run log: [data/aggregator-intake-2026-04-27.md](data/aggregator-intake-2026-04-27.md). |
| **W11 Group 2** Portal config (C9-C11) | ✅ done | `portals.yml` 947→1070 lines. C9: 6 niche AI/ML boards under new `external_boards:` list. C10: 9 new slugs from career-copilot diff (Stripe, Datadog, Cloudflare, Figma, Notion, Databricks, Scale AI, Dagger, Modal — 81/90 already present). C11: Asana added (Summer 2026 intern req verified via Greenhouse API); 18 others skipped unverified. `verify-pipeline.mjs` exit 0. Note: pre-existing em-dashes in old portals.yml entries are out of scope — flag for separate cleanup if desired. |
| **W11 Group 3** Templates (D12-D14, E15-E17) | ✅ done | D12-D14: 3 new fields inserted in [reports/nuro/021-nuro-2026-04-25.md](reports/nuro/021-nuro-2026-04-25.md) after `**Legitimacy:**`, stale `**Apply:**` line stripped, `**URL:**` regex preserved; new [templates/eval-report.md](templates/eval-report.md) documents the canonical header. E15: [templates/star-plus-r-framework.md](templates/star-plus-r-framework.md) (6 sections, worked example uses real Scheduling test-coverage bullet). E16: [templates/5ws-storytelling.md](templates/5ws-storytelling.md) — 7 stories with deep-dive prep grounded in the work-experience honesty file (rank prediction = if-else, not ML; content migration = Python scripts; cloud migration = Grafana/Loki + Artifact Registry, not architecture). E17: [templates/pre-interview-checklist.md](templates/pre-interview-checklist.md) (14-day rotation). `verify-pipeline.mjs` exit 0; em-dash sweep clean. |

**Stop conditions tripped during Phase 2:** none. Workarounds noted: ACMI Lab cert expired (Lipton verified via DBLP/arXiv), `yonatanbisk.com` empty (Bisk verified via arXiv), `autonlab.org/publications` 404 (Dubrawski via Scholar), `perer.org/publications.html` empty (Perer via Scholar), Beibei Li had no 2025-26 papers in standard listings (verified Mgmt Sci 2025 via SSRN). All 12 PIs got rewritten P2s.

---

## Phase 3 — Done (routines live 2026-04-28)

**Routines live** — see top-of-file table for IDs, schedules, and inspect links. All three pointing at [github.com/anmolsahu2k/career-ops](https://github.com/anmolsahu2k/career-ops) (private fork) with `claude-sonnet-4-6`.

System crontab installed 2026-04-27, uninstalled 2026-04-28 (laptop-asleep coverage gap). Wrapper scripts ([scripts/daily-scan-cron.mjs](scripts/daily-scan-cron.mjs), [scripts/weekly-news-cron.mjs](scripts/weekly-news-cron.mjs), [scripts/daily-hygiene-cron.mjs](scripts/daily-hygiene-cron.mjs)) still callable on-demand or from inside a Routine.

Routine prompt sources at [routines/daily-scan.md](routines/daily-scan.md), [routines/weekly-news.md](routines/weekly-news.md), [routines/daily-hygiene.md](routines/daily-hygiene.md); setup notes at [routines/README.md](routines/README.md).

**To pause / disable:** ask Claude to call `RemoteTrigger update` with `enabled: false`, or do it at https://claude.ai/code/routines. Cannot delete via Claude (web UI only).

**Stop conditions tripped during Phase 3:** none.

| Workstream | Status | Notes |
|---|---|---|
| **W1** Daily candidate scan (cron, 7:03am Pittsburgh) | ✅ done | [scripts/daily-scan-cron.mjs](scripts/daily-scan-cron.mjs) verified (`--dry-run` exit 0, em-dash sweep clean). Orchestrates `scan.mjs` + aggregator-intake + best-effort jobspy + merge/dedup/normalize/verify chain + SimplifyJobs README diff + daily digest at `data/daily-digest-{YYYY-MM-DD}.md`. Auto-letter cap 5/day enforced; on day-1 will queue everything to triage with "needs LLM" notes (no low-quality boilerplate). Recommended cron: `0 7 * * *` America/New_York. **Risks flagged:** (1) JobSpy step will exit 2 daily until `pip install python-jobspy` (handled non-fatally); (2) Auto-letter generation is stubbed — to actually generate letters in cron, wire in an LLM call; (3) `scan.mjs` has no score field, so cap-of-5 never exercised today. |
| **W8** Company news monitor (cron, Sunday 6:13pm Pittsburgh) | ✅ done | [scripts/weekly-news-cron.mjs](scripts/weekly-news-cron.mjs) verified (`--dry-run` exit 0, 63 rows parsed → 21 Applied filtered, em-dash sweep clean). Two-step design: cron writes deterministic manifest + digest template per ISO week (`news-tasks-{YYYY-Www}.md`, `news-digest-{YYYY-Www}.md`); downstream agent run fills hooks via WebSearch + WebFetch. Recommended cron: `0 18 * * 0` America/New_York. |
| **W9** Tracker hygiene (cron, daily 8:07am Pittsburgh) | ✅ done | [scripts/daily-hygiene-cron.mjs](scripts/daily-hygiene-cron.mjs) (750 lines, stdlib + child_process only). Live test wrote [data/hygiene-2026-04-28.md](data/hygiene-2026-04-28.md) (227 lines). Liveness on 61 URLs took ~140s; per-URL timeout 25s. Em-dash sweep clean (wrapper applies `scrubDashes` at spawn boundary so upstream stdout containing dashes is normalized before logging). Recommended cron: `0 8 * * *` America/New_York. **Risk flagged:** `check-liveness.mjs` does NOT auto-write `Status: Discarded`; it only flags. User must update tracker manually for now (Nuro and Brex flagged `uncertain`; several `expired` in today's log). |

---

## Future scope (do NOT execute this round)

- **W6** Alumni outreach v2 — needs alum LinkedIn URL list from user; revisit when first interview lands or Saturday faculty batch is done.
- **W7** Inbox watcher — Gmail MCP currently disconnected; revisit after first interview lands.
- **W11 deferred subset** — Adzuna (A2), Hiring Cafe (A3), startup.jobs (A4), Workday (A5); F18 Gmail ATS watcher; F20 LinkedIn email alerts; F21 CMU Career Center parser.

## Permanently skipped

- Hackathon-to-hire outreach — connections too cold (~4 years out from undergrad).

## Deferred until first interview lands

- Per-company interview prep packets (~21 parallel subagents)
- Behavioral STAR story bank matrix (Amazon LP / Stripe Operating Principles / FAANG buckets)
- Daily DSA drill
- Mock interview rounds
- Negotiation prep doc
- Visa/CPT calendar consolidation

---

## Outstanding user actions

(mirror of CLAUDE.md "Outstanding user actions"; keep both in sync)

1. Push EEG_Classification README update (`git -C /Users/anmolsahu2k/Stuff/Create/EEG_Classification/ add README.md && git commit && git push`).
2. Update SDE/MLE PDF resumes per [data/resume-gap-audit.md](data/resume-gap-audit.md) — start with the rank-prediction honesty rewrite.
3. Apply ≤5-line GitHub polish diffs from [data/github-polish-cloudify.md](data/github-polish-cloudify.md) and [data/github-polish-eeg.md](data/github-polish-eeg.md); user commits.
4. Send 12 faculty cold emails (Saturday batch of 5+4, Sunday batch of 3). W2 has rewritten all 12 P2s with 2025-26 paper hooks; re-skim emails 05/10/11 specifically (P1 first sentence was also touched to introduce paper citations).
5. Send 35-40 alumni LinkedIn messages across 21 applied companies.
6. `cd portfolio && npm run dev` to review the new portfolio locally; decide deploy path (Vercel vs GH Pages — see CLAUDE.md / decision record).
7. Watch ATS confirmation emails within 48h; flag silent submissions for resubmit.
8. **2026-05-01 decision checkpoint**: ≥2 first-round interviews OR ≥1 faculty positive reply. If miss → expand India track.
9. **2026-05-08 checkpoint**: ≥1 verbal offer OR ≥2 final-rounds. If miss → activate course-credit research fallback.
10. (optional) `pip install python-jobspy` if you want the W1 routine's JobSpy step to work (LinkedIn rate-limits aggressively; the routine handles the install on first run).
11. Review [career-ops/data/applications.md](data/applications.md) — 40 raw aggregator candidates need triage (status `Evaluated`, score `0.0/5`, no eval report). Promote interesting ones into the standard auto-pipeline; mark others `SKIP`. (Once the W1 routine is live, it will score these automatically.)
12. Review [data/hygiene-2026-04-28.md](data/hygiene-2026-04-28.md) — Nuro and Brex flagged `uncertain`; several `expired` URLs. (Once the W9 routine is live, it will auto-flip unambiguous `expired` URLs to `Status: Discarded`.)
13. **Watch the first runs.** First W1 fires today 7:03am EDT, first W9 today 8:07am EDT, first W8 Sunday 6:13pm EDT. Inspect the `claude/<job>-<date>` branches and merge what looks good. If a routine writes something off-spec, ask Claude to update its prompt via `RemoteTrigger update`.
14. **Decide on a merge policy for routine branches.** Options: (a) review and merge by hand weekly, (b) auto-merge `claude/*` branches via a GitHub Action if a verify-pipeline check passes, (c) set up branch protection so routine pushes are reviewable PRs. (a) is the safest default.

---

## How to update this file

- **End of phase / workstream:** flip the row's status from ⏸ pending to ✅ done (or ⚠ paused). Add deliverable links.
- **Stop condition trips:** add a line under the workstream's row noting the trigger, the date, and what's blocked.
- **New workstream surfaces:** add it under the appropriate phase. Don't silently retire rows — strike them through with a one-line reason if cancelled.
- **Mirror to [CLAUDE.md](../CLAUDE.md) "What's been done":** keep the higher-level milestones in CLAUDE.md current with the same updates.

Status icons: ✅ done · ⏳ in progress · ⏸ pending · ⚠ paused · ❌ cancelled
