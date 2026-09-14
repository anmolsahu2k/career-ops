# Architecture

Current end-to-end architecture for Career-Ops. This document describes the
full-time and new-grad funnel in `ft/`; the repository root also contains a
frozen internship archive. Detailed provider and rollout procedures live in
[RUNTIME.md](RUNTIME.md), and the provider-neutral rules live in
[CAREER_OPS.md](../CAREER_OPS.md).

Updated 2026-09-12.

## System boundary

Career-Ops is a user-triggered, model-agnostic job-search pipeline. Models may
advise on relevance and application prose, but deterministic code owns
validation, policy, persistence, status changes, report numbering, and
recovery.

The live flow is:

```text
  discovery
      |
      v
  normalize, filter, and deduplicate
      |
      +--> scan-history.tsv
      |
      v
  liveness and true-age gates
      |
      +--> expired or stale: log and stop
      |
      v
  evaluation: full A-G report and tracker addition
      |
      +--> provider-free runtime: prepare -> respond -> validate
      |                           -> PolicyEngine -> commit -> recover
      |
      v
  merge or transactional commit
      |
      +--> ft/data/applications.md
      +--> ft/reports/<company>/<report>.md
      |
      v
  optional application attempts
      |
      +--> ft/.career-ops-runtime/applications/
      +--> tracker status Applied only after recognized submission evidence
```

The Go dashboard, `stats.mjs`, source analytics, follow-up tools, and the
optional apply board are readers or separately gated workflows around this
flow. They are not alternate trackers.

## Data roots and path resolution

`CAREER_OPS_DATA_DIR` selects the target data tree. It defaults to `ft` and may
be set to `.` only for an explicitly requested archive operation. JavaScript
uses [lib/paths.mjs](../lib/paths.mjs); Python uses
[scripts/_paths.py](../scripts/_paths.py). Shared configuration always stays at
the repository root.

| Path | Role |
|---|---|
| `ft/data/applications.md` | Live full-time/new-grad 9-column tracker |
| `ft/reports/` | Live evaluation reports and apply-time JD archives |
| `ft/batch/` | Per-worker tracker additions, merged artifacts, and carryover data |
| `ft/data/scan-history.tsv` | Durable URL and discovery-source ledger |
| `ft/data/scan-results-YYYY-MM-DD.tsv` | Transient scan handoff; consumed after evaluation, or retained for scan-only resume |
| `ft/.career-ops-runtime/` | Ignored runtime state, receipts, journals, attempts, checkpoints, and local qualification artifacts |
| `data/`, `reports/`, `batch/` | Frozen internship archive and its historical artifacts |
| `config/`, `cv.md`, `modes/_profile.md`, `portals.yml`, `templates/` | Shared profile, policy inputs, discovery configuration, and templates |

The live tracker is never replaced by a second parallel pipeline. The root
archive is read or written only when the user explicitly selects archive mode.

## Discovery

Discovery is user-triggered. No cron job, recurring scheduler, or background
watcher is part of the active pipeline.

### Configured-company and feed scanners

The main zero-token scanner is [scan.mjs](../scan.mjs). It reads
`portals.yml`, scans enabled tracked-company boards through structured
Greenhouse, Ashby, Lever, and Workday endpoints, and also consumes enabled
structured external feeds. SmartRecruiters and Recruitee remain represented in
the source taxonomy for compatible adapters, but are not currently parsed by
the main scanner. The external feed parser supports JSON and sitemap sources
such as `agentic-engineering-jobs` and `moaijobs`.

[scan-spa.mjs](../scan-spa.mjs) handles enabled Playwright board entries such as
Workable. [scan-freehire.mjs](../scan-freehire.mjs) queries the FreeHire API,
drops re-hosted aggregator URLs by default, and uses the same scan handoff as
the main scanner.

[scan-all.mjs](../scan-all.mjs) (`npm run scan:all`) is the discovery-only
orchestrator: it runs the Node scanners plus the active Python intake adapters
in the order from [modes/scan.md](../modes/scan.md), with zero LLM tokens and
no evaluation or merge. Optional sources soft-skip when credentials or
FlareSolverr are missing. LinkedIn guest scan and deferred YC/Levels/startup.jobs
ingest remain excluded.

At this update, `portals.yml` contains 194 tracked-company entries, 191 enabled
entries, 11 search queries, and three external-board entries, one of which is
disabled. These are configuration facts, not a second source of truth; the
file itself controls the active set.

### Python intake sources

The Python adapters use the shared filter and path helpers where applicable:

| Adapter | Source surface |
|---|---|
| `scripts/aggregator-intake.py` | Curated GitHub job-list repositories |
| `scripts/jobspy-ingest.py` | LinkedIn, Indeed, and Google Jobs through JobSpy (install from GitHub via `requirements-discovery.txt`) |
| `scripts/hiringcafe-ingest.py` | Hiring Cafe API/pages, with optional FlareSolverr support |
| `scripts/adzuna-ingest.py` | Adzuna API and employer-URL resolution |
| `scripts/hn-hiring-ingest.py` | Monthly Hacker News Who Is Hiring threads |
| `scripts/yc-ingest.py` | YC Work at a Startup listings when the configured FT surface is verified |
| `scripts/levels-ingest.py` | Levels.fyi listings when the configured FT surface is verified |
| `scripts/startupjobs-ingest.py` | startup.jobs, currently deferred until its FT surface is verified |

The adapters may be disabled or deferred independently. Their presence in the
repository does not imply that a source is currently enabled.

### Manual and agent-driven discovery

WebSearch and Playwright may supply candidates during a skill workflow. A user
may also provide one URL or pasted job description. A user-provided URL is
classified as `SRC: manual` in the tracker; scanner provenance uses the
canonical IDs in [lib/sources.mjs](../lib/sources.mjs).

For a **manual, no-agent** funnel (discovery + evaluate without chat tokens),
use `npm run scan:all` then `npm run evaluate` as documented in
[SCRIPTS.md](SCRIPTS.md#manual-workflow-no-agent) and
[README.md](../README.md#manual-workflow-no-agent).

## Filtering and handoff

Discovery applies the configured title and geography rules before expensive
evaluation. Depending on the source, the chain includes:

1. required company, role, and URL fields;
2. within-run URL deduplication;
3. target-domain and negative-title filters, including intern/co-op and seniority exclusions for the FT funnel;
4. US or approved remote-location filtering;
5. source-specific age filtering when a reliable posting date exists;
6. tracker URL and company-role fingerprint deduplication;
7. canonical source stamping and report-number allocation.

Python intake shares constants and helpers from
[scripts/discovery_filters.py](../scripts/discovery_filters.py). JavaScript
scanners share [lib/scan-io.mjs](../lib/scan-io.mjs), and all readers use the
header-aware [tracker-parse.mjs](../tracker-parse.mjs) where tracker rows are
read.

The main scan writes new candidates to the dated `ft/data/scan-results-*.tsv`
handoff and appends them to `ft/data/scan-history.tsv`. Python intake adapters
append to the same scan-results triage handoff; they do not write unevaluated
`reports/pending.md` tracker stubs. Only a completed evaluation may emit
mergeable `ft/batch/tracker-additions/` rows (or commit directly via
`career-ops evaluate --apply`). A scan-only / discovery-only run intentionally
leaves its dated TSV on disk; the next evaluation invocation must consume it
before starting fresh discovery. There is no `pipeline.md` triage queue.

## Liveness and age gates

No bulk evaluation agent is dispatched until the candidate URLs pass the
liveness gate.

[liveness-core.mjs](../liveness-core.mjs) returns `active`, `expired`, or
`uncertain`. It considers HTTP 404/410, closed-job redirects, known closed-page
text, listing-page redirects, page-content length, and visible apply controls.
Known SPA hosts receive a longer hydration wait.

[liveness-parallel.mjs](../liveness-parallel.mjs) shares one Chromium instance
and checks URL lists or every `*.tsv` file in
`ft/batch/tracker-additions/`. It writes a bounded TSV result containing the
URL, verdict, HTTP status, and reason. The usual command is:

```bash
npm run liveness:batch
```

Expired URLs are logged as `skipped_expired` and do not consume evaluation
capacity. Uncertain URLs remain available for evaluation with an explicit
uncertainty note. The per-URL auto-pipeline also checks the already-loaded job
page, and the FT workflow applies a true ATS-age cutoff in addition to feed
age.

[hygiene-sweep.mjs](../hygiene-sweep.mjs) performs tracker-wide liveness and
shelf-life cleanup. Mechanical cleanup uses `Purged`; an evaluation decision
against the role uses `Rejected-at-eval`; `Discarded` is reserved for the
candidate's own dashboard decision. The exact status contract is defined in
[templates/states.yml](../templates/states.yml).

## Evaluation

Every completed evaluation produces:

- a full Block A-G report under `ft/reports/<company-slug>/`;
- one 9-column tracker addition under `ft/batch/tracker-additions/`, or a
  validated transactional commit through the runtime;
- a canonical `SRC:` token in Notes;
- a resume recommendation in Notes, never a generated resume PDF.

The active Codex entry point is [AGENTS.md](../AGENTS.md), with the native
workflow router at
[.agents/skills/career-ops/SKILL.md](../.agents/skills/career-ops/SKILL.md).
`CLAUDE.md`, `.claude/`, `.gemini/`, and `.opencode/` remain compatibility
adapters for older clients and scripts.

The workflow routes single evaluations through `modes/_shared.md` and
`modes/offer.md`, scans through `modes/scan.md`, bulk evaluations through
`modes/batch.md`, and application assistance through `modes/apply.md`. The old
`oferta` spelling is a compatibility alias only; the active file is
`modes/offer.md`.

## Provider-free runtime

The runtime makes model output advisory and keeps persistence deterministic:

```text
prepare -> respond -> validate -> PolicyEngine -> commit -> recover
```

The implementation is in `lib/runtime/`, the interchange contracts are in
`schemas/runtime/`, and the CLI is [bin/career-ops.mjs](../bin/career-ops.mjs).

| Stage | Responsibility |
|---|---|
| Prepare | Build a versioned task envelope and hash-bound evidence bundle |
| Respond | Invoke a configured, qualified provider or accept a saved response |
| Validate | Check schema, semantics, evidence boundaries, normalization, and presentation safety |
| PolicyEngine | Apply deterministic tri-state gates and authorize evaluation writes (`lib/runtime/policy-engine.mjs`). Application Submit uses a separate `submissionGate` in `lib/applications/policy.mjs`. |
| Commit | Reserve a report number, write the report and tracker row transactionally, and record a receipt |
| Recover | Complete or roll back interrupted artifacts deterministically without a model call |

Provider adapters cover command-line and HTTP providers, including Codex,
Antigravity, OpenAI-compatible, Gemini HTTP, Anthropic, and loopback-only local
providers when configured. Routing is configuration-driven and may return
`NO_ELIGIBLE_PROVIDER`; it never silently degrades below the task's minimum
capability class.

Qualification, shadow runs, historical evidence packs, local hardware checks,
and canary certification are diagnostic or rollout controls. A model-generated
historical label is not ground truth. Historical recommendation sets remain
non-promotable until their separate deterministic hard-gate and writer-canary
requirements pass.

`gemini-eval.mjs` and `batch/batch-runner.sh` are thin compatibility entrypoints
that delegate to the provider-free runtime by default. Set
`CAREER_OPS_RUNTIME=legacy` only for an explicitly needed historical path.
Native Windows use should call `node bin/career-ops.mjs` directly when Bash is
not available.

## Tracker integration

The tracker schema is fixed:

```text
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
```

Rows are added through `merge-tracker.mjs` or a validated runtime transaction,
not by an evaluation worker editing the live tracker directly. The merge path
deduplicates by report number, tracker number, URL, and normalized company-role
fingerprint before appending or safely updating a row.

Canonical statuses come from `templates/states.yml`:

- `Triaged`: provisional rank only; it is not a final recommendation or write authority.
- `Evaluated`: the role has a report and is awaiting a candidate decision.
- `Applied`: the candidate submitted an application.
- `Responded`, `Interview`, and `Offer`: downstream progress states.
- `Rejected`: the company rejected a submitted application.
- `Rejected-at-eval`: the evaluator rejected the role on its merits.
- `Purged`: mechanical removal because the posting died, aged out, or was stale at intake.
- `Discarded`: the candidate's own manual decision.
- `SKIP`: a legacy-compatible state and alias; current workflow code should use the exact status rules in `templates/states.yml`.

[verify-pipeline.mjs](../verify-pipeline.mjs) checks status vocabulary, exact
row shape, score cells, report links, and duplicate-risk signals.
[stats.mjs](../stats.mjs) produces the lifetime tracker and scanner roll-up,
while [source-analytics.mjs](../source-analytics.mjs) groups funnel results by
canonical discovery source.

## Optional application pipeline

Application attempts are disabled by default and are not scheduled. They use
the existing Job Autofill extension plus the application modules under
`lib/applications/`.

The normal queue accepts only an `Evaluated` row with an explicit `APPLY`
recommendation, a score of at least 4.0, and a valid canonical URL. A separately
audited user-selected override can queue one row outside that gate. Attempts
are keyed by tracker number plus canonical URL and persist under
`ft/.career-ops-runtime/applications/`.

The runner uses a dedicated persistent Chrome profile by default, enforces a
locally configured ATS allowlist, and keeps terminal `SUBMITTED` and
`SUBMISSION_UNKNOWN` attempts from automatic retry. A tracker row changes to
`Applied` only after recognized submission evidence. The optional post-scan
handoff is enabled only by ignored local runtime configuration and processes
only the rows committed by that scan.

Candidate-facing cover letters and application answers remain explicit-request
work. The separately qualified local-prose path can fill the exact Greenhouse
manual cover-letter control when explicitly enabled; it never uploads a PDF or
falls back to a hosted provider. Salary intent, generated-content disclosure,
optional marketing consent, and sensitive or ambiguous questions remain
deterministically gated as described in [RUNTIME.md](RUNTIME.md).

## Dashboard and supporting tools

The optional Go TUI in `dashboard/` reads a selected data root and provides:

- tracker filters and sorting;
- report preview and URL opening;
- progress metrics;
- candidate-controlled status changes, including the manual `d` discard action.

Build and point it at the live tree with:

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ../ft
```

The static or local-server apply board is generated by
[apply-board.mjs](../apply-board.mjs). It is a convenience view over job
discovery output, not the canonical application tracker.

## Recovery, locking, and privacy

Runtime mutations require an explicit local configuration whose `writer_host`
matches the operating host. The writer lease, atomic files, transaction
journals, expected hashes, and receipts prevent concurrent or cross-host
overwrites. Recovery is explicit, deterministic, and never invokes a model.

The user-triggered [backup.mjs](../backup.mjs) is the intended off-disk backup
path. Personal tracker data, reports, profiles, runtime state, credentials, and
local browser data are ignored or external to git; see [RECOVERY.md](RECOVERY.md)
for the inventory. No scheduled backup or cloud routine is part of the active
architecture.

## Source-of-truth map

| Concern | Source |
|---|---|
| Rules and authorization | `CAREER_OPS.md` |
| Codex project entry point | `AGENTS.md` |
| Career-Ops workflow routing | `.agents/skills/career-ops/SKILL.md` and `modes/` |
| Data-root selection | `lib/paths.mjs`, `scripts/_paths.py` |
| Discovery configuration | `portals.yml` |
| Source taxonomy | `lib/sources.mjs` |
| Tracker parsing | `tracker-parse.mjs`, `tracker-aliases.json` |
| Canonical statuses | `templates/states.yml` |
| Liveness classification | `liveness-core.mjs`, `liveness-parallel.mjs` |
| Evaluation/runtime contracts | `schemas/runtime/`, `lib/runtime/`, `docs/RUNTIME.md` |
| Application attempts | `lib/applications/`, `extensions/job-autofill/` |
| Apply Attempts board | `career-ops apply serve` → `lib/applications/board.mjs` |
| Scan checklist board | `node apply-board.mjs` (scan-history; not attempt state) |
| Current funnel state | `ft/data/applications.md`, `ft/reports/`, and `STATUS.md` |
| Historical run narratives | `CHANGELOG.md` |

When paths, status semantics, provider ownership, or application gates change,
update this overview and the more detailed document that owns the behavior.
