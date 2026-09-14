# Scripts Reference

Career-Ops keeps its executable pipeline in root `.mjs` files, the provider-
free runtime in `bin/` and `lib/runtime/`, and source-specific Python intake
under `scripts/`. Pipeline data paths resolve through `CAREER_OPS_DATA_DIR`:
the default is `ft/`; `.` selects the frozen root archive only for an explicit
archive operation. Shared configuration stays at the repository root.

## Quick reference

| Command | Purpose |
|---|---|
| `npm run doctor` | Check Node, dependencies, Chromium, profile inputs, portals, and legacy setup directories |
| `npm test` | Run the quick repository test suite |
| `npm run verify` | Validate tracker rows, statuses, scores, report links, and pending additions |
| `npm run normalize` | Normalize tracker status formatting and aliases |
| `npm run dedup` | Detect and remove duplicate tracker rows |
| `npm run merge` | Merge tracker-addition TSVs into the selected tracker |
| `npm run liveness -- <urls>` | Check one or more URLs with the shared liveness classifier |
| `npm run liveness:bulk -- <file>` | Run liveness over a URL list |
| `npm run liveness:batch` | Check TSV additions under the selected `batch/` tree |
| `npm run scan` | Run the structured, zero-token scanner |
| `npm run scan:spa` | Run the Playwright career-page scanner |
| `npm run scan:all` | Run every active discovery source in scan order (no eval) |
| `npm run evaluate` | Evaluate `scan-results` triage: liveness → fetch JD → prepare/respond/commit |
| `npm run evaluate:plan` | Dry run 25 rows, prune rejects, save eval queue + `plan.json` |
| `npm run evaluate:sweep` | Score **only** the saved eval queue through Cerebras |
| `npm run evaluate:overflow` | Score **only** the saved eval queue through Groq |
| `npm run evaluate:judge` | Score **only** the saved eval queue through Gemini Flash High |
| `npm run evaluate:ladder` | Score **only** the saved eval queue through `career-ops-windows-v1` |
| `npm run ui` | Localhost Career-Ops Web App (discovery → evaluate → tracker → apply → hygiene) |
| `npm run runtime:test` | Run runtime-focused tests |
| `npm run runtime:doctor` | Read-only runtime configuration and environment check |

## Manual workflow (no agent)

Use these commands when you want the FT funnel without an agent chat session.
This is the token-saving path: discovery and liveness cost no LLM tokens; only
`evaluate --apply` calls a provider (one A-G judgment per live or uncertain URL).

```text
scan:all  →  scan-results triage  →  evaluate [--apply]  →  verify / normalize / dedup
```

### Prerequisites

1. Copy or maintain ignored `config/runtime.local.yml` (from
   `config/runtime.example.yml`).
2. Set `writer_host` to this machine's hostname.
3. Enable a consequential provider. For Antigravity Gemini 3.8 Flash High:

```yaml
providers:
  antigravity-gemini-flash-high:
    enabled: true
    # ... remainder already defined in the example config
```

4. Ensure Antigravity CLI (`agy`) is installed and signed in when using that provider.
5. For the Cerebras sweep provider, set the key in the shell that runs the
   command. It is read from the environment and never stored in the repo:

```powershell
# Current session only
$env:CEREBRAS_API_KEY = '<key>'
# Persist for future sessions
[Environment]::SetEnvironmentVariable('CEREBRAS_API_KEY', '<key>', 'User')
```

See [MODEL_ROUTING.md](MODEL_ROUTING.md#windows-workstation-configuration) for
which provider to use when.

### Day-to-day loop

```powershell
# Discovery (0 LLM tokens). Writes/appends ft/data/scan-results-YYYY-MM-DD.tsv
npm run scan:all
# Optional: npm run scan:all -- --dry-run
# Optional: npm run scan:all -- --skip adzuna,hiringcafe

# Preview what evaluate would do (0 LLM tokens for plan; liveness uses Playwright)
npm run evaluate
npm run evaluate -- --file ft/data/scan-results-2026-09-12.tsv --max 25

# Commit survivors through the runtime (provider quota only)
npm run evaluate:judge

# Windows workstation aliases
#   evaluate / evaluate:plan   prune rejects, save ft/data/evaluate-queue.tsv
#   evaluate:judge             score ONLY that queue (Flash High)
#   evaluate:sweep             score ONLY that queue (Cerebras)
#   evaluate:overflow          score ONLY that queue (Groq)

# Integrity after commits
npm run verify
```

### Local web app (day-to-day operator surface)

```powershell
npm run ui
# node bin/career-ops.mjs ui --config config/runtime.local.yml --port 8790
# Opens http://127.0.0.1:8790/
```

Covers Discovery (`scan:all`), Evaluate (plan / judge / sweep / overflow), Tracker
(read-only), Apply (composed Apply Board; enqueue / run use submit=true;
`submissionGate` still gates the Submit click), and Hygiene (verify / normalize /
dedup / merge with dry-run default).
Binds `127.0.0.1` only. Writer-host mismatch → read-only banner. Go TUI dashboard
remains available; qualification / shadow / canary stay CLI-only.

Optional hygiene (preview first on personal data):

```powershell
npm run normalize -- --dry-run
npm run dedup -- --dry-run
npm run merge -- --dry-run   # only if you still have agent-written tracker-additions TSVs
```

### Token and authorization notes

| Step | LLM tokens | Writes tracker? |
|---|---|---|
| `npm run scan:all` | 0 | No (triage TSV only) |
| `npm run evaluate` (no `--apply`) | 0 | No |
| Liveness inside evaluate | 0 | No (drops expired from triage on `--apply`) |
| `npm run evaluate -- ... --apply` | 1 call per live/uncertain URL | Yes (report + row via transactional commit) |
| `npm run verify` / `normalize` / `dedup` | 0 | Hygiene only |

- Do not merge `reports/pending.md` placeholders. Discovery stays in
  `data/scan-results-*.tsv` until evaluate commits a real A-G report.
- `--apply` requires `--config`, `--provider` (or `--profile`), and
  `--acknowledge-quota`.
- Application submit remains separately gated (`career-ops apply ...`); evaluate
  never clicks Submit.
- Prefer the agent (`$career-ops scan` / paste-a-JD) only when you want
  interactive review, not for bulk unattended scoring.

### Related docs

- [RUNTIME.md](RUNTIME.md) — prepare/respond/commit contracts and provider setup
- [MODEL_ROUTING.md](MODEL_ROUTING.md) — Flash High evaluate vs Luna profile ladder
- [modes/scan.md](../modes/scan.md) — discovery sources and agent vs manual split

## Path-aware tracker commands

`verify-pipeline.mjs`, `normalize-statuses.mjs`, `dedup-tracker.mjs`, and
`merge-tracker.mjs` all use the shared path resolver. With the default
configuration they read or write:

```text
ft/data/applications.md
ft/reports/
ft/batch/tracker-additions/
```

Use `CAREER_OPS_DATA_DIR=.` only when the user explicitly asks to operate on
the frozen internship archive. All mutating commands create a local rollback
copy or transaction artifact where their contract requires one; inspect the
dry run before applying a broad cleanup.

### verify

Checks the selected tracker against `templates/states.yml`, the fixed
9-column row shape, score formatting, report links, pending tracker additions,
and duplicate-risk signals. Warnings do not make the command fail.

```bash
npm run verify
```

### normalize

Maps recognized aliases to canonical state labels, removes markdown formatting
and dates from status cells, and preserves duplicate information in Notes.
Preview first when working on personal data:

```bash
npm run normalize -- --dry-run
npm run normalize
```

### dedup

Groups rows by normalized company and fuzzy role identity, then keeps the best
record while preserving more advanced state and useful Notes from duplicates.

```bash
npm run dedup -- --dry-run
npm run dedup
```

### merge

Consumes one-line tracker additions from the selected
`batch/tracker-additions/` directory. It accepts the current 9-column TSV
contract, older compatible forms, and pipe-delimited rows; it deduplicates by
report number, tracker number, URL, and company-role identity before merging.

```bash
npm run merge -- --dry-run
npm run merge
npm run merge -- --verify
```

Successfully processed additions move to
`batch/tracker-additions/merged/` under the selected data root. Workers must
never edit `applications.md` directly. Merge refuses unevaluated placeholders
(`reports/pending.md`, status `Triaged`, "not yet evaluated" Notes). Those
candidates belong in `data/scan-results-*.tsv` triage until a real A-G report
exists. To demote legacy placeholder tracker rows:

```bash
node backfill-unevaluated-to-triage.mjs --dry-run
node backfill-unevaluated-to-triage.mjs --apply
```

## Setup and diagnostics

### doctor

Checks Node.js 18+, installed dependencies, Playwright Chromium, `cv.md`,
`config/profile.yml`, `portals.yml`, and the legacy font/setup directories.
The current implementation also creates root `data/`, `output/`, and
`reports/` directories for compatibility; it does not evaluate roles or alter
the selected live tracker.

```bash
npm run doctor
```

### sync-check

Checks profile/CV consistency and stale setup assumptions. It is read-only
except for diagnostics.

```bash
npm run sync-check
```

### update and rollback

`update:check`, `update`, and `rollback` are the upstream system-file updater
commands. Review the data contract and the proposed diff before applying an
update to a personalized workspace.

```bash
npm run update:check
npm run update
npm run rollback
```

### backup

There is no `npm run backup` script. The user-triggered off-disk backup is:

```bash
node backup.mjs --dry-run
node backup.mjs --dest <off-disk-folder>
```

Secrets are excluded from the main archive by default. See
[RECOVERY.md](RECOVERY.md) for the recovery set and credential re-auth rules.

## Discovery and liveness

### liveness

`check-liveness.mjs` and `liveness-core.mjs` classify a posting as `active`,
`expired`, or `uncertain` using HTTP state, closed-page signals, redirects,
content length, and visible application controls.

```bash
npm run liveness -- https://example.com/job/123
npm run liveness -- --file urls.txt
npm run liveness:bulk -- urls.txt
npm run liveness:batch
```

The batch command reads pending `*.tsv` files under the selected
`batch/tracker-additions/` tree and writes bounded verdict output. Expired
roles are skipped before evaluation; uncertain roles remain visible with an
explicit reason.

### scan

`scan.mjs` reads `portals.yml`, applies the shared title, geography, age, and
deduplication filters, and writes the dated handoff under
`ft/data/scan-results-YYYY-MM-DD.tsv` by default. It supports the structured
Greenhouse, Ashby, Lever, and Workday paths implemented in the scanner plus
configured JSON or sitemap feeds.

```bash
npm run scan
npm run scan:spa
node scan-freehire.mjs
npm run scan:all
npm run scan:all -- --dry-run
npm run scan:all -- --skip adzuna,hiringcafe
```

`scan:all` runs the active Node scanners plus Python intake adapters in the
order from `modes/scan.md`. It prints a step progress board and a heartbeat
while a quiet source is still running, then a final status summary with
candidate counts (added this run, by step, by source token, and current
backlog). It does not evaluate, merge, or apply. Optional sources (Adzuna
without credentials, Hiring Cafe without FlareSolverr) are skipped instead of
failing the whole run. LinkedIn guest scan and deferred YC/Levels/startup.jobs
ingest stay excluded.

The scan is user-triggered. The normal skill flow evaluates survivors inline;
an explicit `scan-only` run may leave the dated TSV for a later resume pass.
There is no `pipeline.md` triage queue and no scheduled scanner.

### Python intake

These adapters are also user-triggered and route raw rows through
`scripts/discovery_filters.py` before appending to
`data/scan-results-{date}.tsv` triage. They do not write unevaluated
`reports/pending.md` placeholders into the tracker. Only a completed A-G
eval may emit mergeable `batch/tracker-additions/` rows.

| Script | Source | Current disposition |
|---|---|---|
| `aggregator-intake.py` | Curated GitHub job-list repositories | Active |
| `jobspy-ingest.py` | LinkedIn, Indeed, Google Jobs via JobSpy | Active; install JobSpy from GitHub with `python -m pip install -U -r requirements-discovery.txt` |
| `hiringcafe-ingest.py` | Hiring Cafe | Active when configured |
| `adzuna-ingest.py` | Adzuna API | Active when credentials exist |
| `hn-hiring-ingest.py` | Hacker News Who Is Hiring | Active |
| `yc-ingest.py` | YC Work at a Startup | Deferred until FT surface is verified |
| `levels-ingest.py` | Levels.fyi jobs | Deferred until FT surface is verified |
| `startupjobs-ingest.py` | startup.jobs | Deferred until FT surface is verified |

The Python `prune-by-liveness.py` and report-reorganization utilities remain
compatibility helpers. Prefer the shared JavaScript liveness/runtime paths for
new FT workflow work.

## Provider-free runtime

The runtime CLI is [bin/career-ops.mjs](../bin/career-ops.mjs). The normal
sequence is:

```text
prepare -> respond -> validate -> PolicyEngine -> commit -> recover
```

Useful commands include:

```bash
node bin/career-ops.mjs prepare --input seed.json --out task.json
node bin/career-ops.mjs validate --task task.json --response response.json
node bin/career-ops.mjs commit --task task.json --response response.json
node bin/career-ops.mjs batch --manifest batch.json
node bin/career-ops.mjs evaluate --skip-liveness
node bin/career-ops.mjs evaluate --config <runtime.yml> --provider <id> --acknowledge-quota --apply
node bin/career-ops.mjs recover --target <data-root> --config <runtime.yml> --apply
```

### evaluate

`npm run evaluate` (or `node bin/career-ops.mjs evaluate`) is the single
command for the triage evaluation pass. It reads `data/scan-results-*.tsv`,
runs the liveness gate, fetches JD evidence, then
`prepare -> respond -> commit` through an explicitly selected provider.

```bash
# Plan: prune level/geo/expired rejects from triage; no A-G reports
npm run evaluate
npm run evaluate -- --file ft/data/scan-results-2026-09-12.tsv --max 25

# Commit survivors (requires local runtime config + provider + quota ack)
npm run evaluate -- \
  --config config/runtime.local.yml \
  --provider antigravity-gemini-flash-high \
  --acknowledge-quota \
  --apply
```

Without `--apply` the command prints a human summary of the plan (pre-filters,
liveness counts, rows dropped before scoring, and the eval queue). Rejected
rows (level, geography, expired) are pruned from `data/scan-results-*.tsv` so
`--max N` advances on the next run. No A–G reports or tracker rows are written
until `--apply`. Pass `--json` for the full `EvaluateScanResultV1` object, or
`--out plan.json` to save JSON while still showing the summary. With `--apply`
it writes reports and tracker rows through the transactional commit path, also
drops committed URLs from the scan-results handoff, and never merges
`reports/pending.md` placeholders. Use `--profile career-ops-job-v1` instead of
`--provider` to select that profile's judgment provider (`codex-luna` in the
example config). `antigravity-gemini-flash-high` is the checked-in Antigravity
Gemini 3.8 Flash High provider for unattended evaluate runs. Use
`--skip-liveness` only in tests or when a fresh liveness TSV was already
applied.

#### Deterministic gates before the provider call

Every candidate passes three model-free filters first, so no provider quota is
spent on a row that cannot pass policy anyway:

1. **Level.** `config/profile.yml`'s target level band drives a title check
   (and a fallback check on the posting URL slug, because some feeds report a
   generic title for a senior req). Senior, staff, principal, lead, manager,
   and `III`/`IV` titles are dropped. `Member of Technical Staff` is carved out.
2. **Geography.** A definitively non-US location is dropped when the profile
   declares a US-only search.
3. **True age.** Postings older than `--max-age-days` (default 21, matching
   `modes/scan.md`) are skipped after the ATS publish date is read.

The candidate record (`cv.md` plus the profile constraints, with contact
details redacted) is sent as a second `trusted_evidence` item so Block B has
something to match against, and so `geography_eligible`,
`citizenship_restricted`, and `sponsorship_compatible` can resolve
deterministically instead of holding every result at `CONSIDER`. A posting
shorter than ~900 characters leaves `required_evidence_complete` UNKNOWN, which
returns `REVIEW_REQUIRED` with no score rather than a confident number derived
from a nav blob.

#### Flags

| Flag | Default | Effect |
|---|---|---|
| `--max <n>` | all | Evaluate only the first N triage rows |
| `--file <path>` | all dated TSVs | Restrict to one scan-results file |
| `--concurrency <n>` | 10 | Parallel liveness probes |
| `--eval-concurrency <n>` | 3 | Parallel provider calls (commits stay serialized) |
| `--max-age-days <n>` | 21 | True-age cutoff; `0` disables |
| `--allow-senior` | off | Disable the level filter |
| `--refresh-liveness` | off | Ignore the cached liveness pass |
| `--liveness-ttl-hours <n>` | 12 | Liveness cache lifetime |
| `--no-liveness-cache` | off | Neither read nor write the cache |
| `--force-provider` | off | Accept a disabled or qualification-failed provider |
| `--json` / `--human` / `--out <path>` | TTY-dependent | Output form |

Liveness verdicts are cached in
`{data-root}/.career-ops-runtime/liveness-cache.tsv`, so a rerun re-probes only
URLs that are new or stale. Failed rows are written to
`{data-root}/data/evaluate-failures-{date}.tsv` for a targeted `--file` retry.

Mutation requires an explicit local runtime configuration, writer authorization,
and `--apply`. Providers may be disabled or ineligible; routing fails closed
with `NO_ELIGIBLE_PROVIDER` instead of silently lowering task capability. A
provider that is disabled or has explicitly failed qualification needs
`--force-provider`; one that simply has no qualification record yet runs but is
reported under `provider_override` in the result.
Runtime contracts live in `schemas/runtime/` and implementation lives in
`lib/runtime/`.

Runtime qualification and shadow helpers are exposed through the `runtime:*`
package scripts in `package.json`. They are diagnostic or rollout controls and
do not enable production routing by themselves.

## Optional application pipeline

Application attempts are configuration-gated and disabled by default. Use the
runtime CLI, not an ad hoc script:

```bash
# Readiness checklist (profile, resumes, seed, ATS allowlist, near-misses)
node bin/career-ops.mjs apply doctor --config config/runtime.local.yml

# Preview eligibles + near-misses (MISSING_APPLY_TOKEN, etc.)
node bin/career-ops.mjs apply enqueue --human
node bin/career-ops.mjs apply enqueue --config config/runtime.local.yml --apply

node bin/career-ops.mjs apply run --config config/runtime.local.yml --apply
node bin/career-ops.mjs apply serve
node bin/career-ops.mjs apply analytics
```

`apply serve` opens the **Apply Attempts** board (`ApplicationAttemptV1`). The
root `node apply-board.mjs` scan-history checklist is a different surface.

The runner uses the dedicated Job Autofill profile, an ATS allowlist, a
mandatory pre-fill liveness gate, exact tracker-number plus canonical-URL
attempt keys, and terminal attempt states. Only recognized submission evidence
may change a tracker row to `Applied`. It never auto-answers sensitive or
ambiguous questions and never retries `SUBMITTED` or `SUBMISSION_UNKNOWN`
automatically.

After an interrupted submit (`SUBMISSION_UNKNOWN`), check the employer/ATS
email before `apply retry --confirm-not-submitted`.

## Analytics and compatibility entrypoints

These utilities are direct Node commands rather than package scripts:

```bash
node stats.mjs --summary
node source-analytics.mjs
node verify-pipeline.mjs
```

`gemini-eval.mjs` and `batch/batch-runner.sh` are compatibility entrypoints.
They delegate to the provider-free runtime by default; set
`CAREER_OPS_RUNTIME=legacy` only for an explicitly needed historical path.
On native Windows, call `node bin/career-ops.mjs ...` directly because the shell
wrapper requires Bash.

`npm run pdf` and `generate-latex.mjs` remain legacy tooling. The active
workspace does not generate or rebuild resume PDFs; the user supplies the
maintained SDE or MLE resume.

## Verification after changes

For documentation-only changes, run the relevant link and diff checks. For
runtime or script changes, run:

```bash
npm test
npm run verify
(cd dashboard && go test ./...)
```

Do not commit or push as part of script execution unless the user explicitly
requests it.
