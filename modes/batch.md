# Mode: batch — Mass Processing of Jobs

Two usage modes: **browser-assisted** (navigate portals in real time) or **collected-input** (process URLs already present in `batch/batch-input.tsv`).

> **Data-dir note:** All `reports/`, `data/`, and `batch/` paths here resolve under `$CAREER_OPS_DATA_DIR`, default `ft/` (the live FT funnel). `batch/tracker-additions/` means `ft/batch/tracker-additions/`, `applications.md` means `ft/data/applications.md`, `reports/` means `ft/reports/`. Engines resolve via `lib/paths.mjs` / `scripts/_paths.py`.
>
> **Execution rule:** Use Codex subagents directly. Do not invoke `batch/batch-runner.sh`; it is a legacy Claude compatibility script. Reserve a unique report number for every role before dispatch, require the full Block A-G report and a per-worker tracker TSV, and merge only after all workers finish. Subagents share the same filesystem, so no two workers may edit the same tracker or report artifact.
>
> **Resume rule:** Workers do not generate CV PDFs. Record the maintained resume choice (`Submit SDE resume` or `Submit MLE resume`) in the tracker Notes column.

## Architecture

```text
Codex conductor
  |
  |  Browser: collect the posting URL and visible JD
  |  Reserve report numbers before parallel work begins
  |
  +-- Job 1 -> Codex subagent -> report .md + tracker TSV
  +-- Job 2 -> Codex subagent -> report .md + tracker TSV
  |
  +-- End -> merge tracker additions -> verify pipeline -> summary
```

The conductor owns discovery, number reservation, merging, and final verification. Each worker owns only its assigned report and tracker-addition file.

## Files

```text
batch/
  batch-input.tsv               # URLs (from conductor or manual)
  batch-state.tsv               # Progress (auto-generated, gitignored)
  batch-runner.sh               # Legacy Claude compatibility runner, do not call from Codex
  batch-prompt.md               # Legacy runner prompt
  logs/                         # Legacy runner logs (gitignored)
  tracker-additions/            # Tracker lines (gitignored)
```

## Mode A: Browser-assisted

1. Read `batch/batch-state.tsv` and identify pending items.
2. Navigate the portal with the in-app browser or Playwright and collect each posting URL plus its visible JD.
3. Apply title, geography, liveness, and posting-age gates before evaluation.
4. Reserve report numbers with `node reserve-report-num.mjs --count N` before dispatching workers.
5. Dispatch independent Codex subagents. Give each worker `modes/_shared.md`, `modes/auto-pipeline.md`, one URL or JD, its canonical source id, and its reserved report number.
6. Require each worker to write one full Block A-G report and one 9-column TSV under `batch/tracker-additions/`.
7. Mark each item completed or failed in `batch/batch-state.tsv`; a failed item must not block the rest.
8. After all workers finish, merge additions and run `node verify-pipeline.mjs`.

## Mode B: Collected-input

1. Read pending rows from `batch/batch-input.tsv` and `batch/batch-state.tsv`.
2. Run the mandatory liveness and posting-age gates.
3. Reserve numbers for survivors in one operation.
4. Dispatch bounded groups of Codex subagents, keeping each worker's output paths disjoint.
5. Retry only failed items when doing so remains safe and useful.
6. Merge tracker additions, verify the pipeline, and report completed, skipped, and failed counts.

## batch-state.tsv Format

```text
id	url	status	started_at	completed_at	report_num	score	error	retries
1	https://...	completed	2026-...	2026-...	002	4.2	-	0
2	https://...	failed	2026-...	2026-...	-	-	Error msg	1
3	https://...	pending	-	-	-	-	-	0
```

## Resumability

- On a resumed run, read `batch-state.tsv` and skip completed jobs.
- Never start a second batch while the same input set is active.
- Each worker is independent: failure in job #47 does not affect the others.

## Workers

Each Codex worker receives the shared mode contract, auto-pipeline mode, one job, a canonical source id, and a pre-reserved report number.

The worker produces:
1. `.md` report in `reports/`
2. Tracker line in `batch/tracker-additions/{id}.tsv`
3. Concise result summary for the conductor

## Error handling

| Error | Recovery |
|-------|----------|
| URL inaccessible | Mark `failed` or `skipped_expired`, as appropriate, and continue |
| JD behind login | Try the visible browser session; if unavailable, mark `failed` |
| Portal changes layout | Inspect current page state and adapt the extraction |
| Worker fails | Mark `failed`, continue, and retry only when useful |
| Conductor stops | Resume from state and skip completed jobs |
