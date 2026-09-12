# Batch Processing

The current batch workflow is the provider-free runtime or the Codex `batch`
mode. The shell wrapper and its prompt are retained only as compatibility
entrypoints for an explicitly requested historical run.

## Current runtime batch

Prepare task and response JSON files, then create a manifest whose paths are
relative to the manifest file:

```json
{
  "schema": "RuntimeBatchManifestV1",
  "schema_version": 1,
  "entries": [
    { "id": "job-1", "task": "prepared-job-1.json", "response": "response-job-1.json" }
  ]
}
```

Validate without writing Career-Ops data:

```powershell
node bin/career-ops.mjs batch --manifest batch.json
```

Commit sequentially and transactionally only with explicit writer
authorization:

```powershell
node bin/career-ops.mjs batch --manifest batch.json `
  --config config/runtime.local.yml --apply
```

The runtime validates every response, applies the deterministic PolicyEngine,
and writes only after the commit gate passes. A failed entry is reported as
`FAILED`; successful preview entries are `VALIDATED`, and applied entries are
`COMMITTED`. It never lowers the task's minimum capability or silently falls
back to an unqualified provider.

## Codex worker workflow

For URL collection and model-backed evaluation, use
[`modes/batch.md`](../modes/batch.md). The conductor owns discovery, liveness,
true-age gates, report-number reservation, merging, and final verification.
Each worker receives one disjoint job and writes:

```text
ft/reports/<company-slug>/<report>.md
ft/batch/tracker-additions/<report>.tsv
```

The default target is `ft/`. Set `CAREER_OPS_DATA_DIR=.` only for an explicitly
requested operation on the frozen root internship archive. Workers do not edit
`applications.md` directly, generate resume PDFs, submit applications, or send
messages.

After all workers finish:

```powershell
npm run merge -- --verify
```

## Compatibility shell runner

`batch-runner.sh` delegates to `node bin/career-ops.mjs batch` unless
`CAREER_OPS_RUNTIME=legacy` is set. The current runtime path requires
`--manifest`; it does not use the legacy input/state files.

```bash
./batch/batch-runner.sh --manifest batch.json
```

The legacy branch uses `batch-input.tsv`, `batch-state.tsv`,
`batch-prompt.md`, and the root `data/`, `reports/`, and `batch/` paths. It
requires Bash and a `claude` executable, and is not the active FT pipeline.
Do not invoke it from Codex; use the runtime CLI or Codex subagents instead.

## Safety and resumability

- Reserve report numbers before parallel workers write reports.
- Keep worker report and TSV paths disjoint.
- Run the liveness and true-age gates before evaluation.
- Merge only after workers finish, then run `verify-pipeline.mjs`.
- Treat provider output as untrusted until schema, evidence, presentation, and
  policy validation pass.
- Resume only from the runtime's digest-bound checkpoints or the legacy state
  file when explicitly using the legacy branch.

See [`docs/RUNTIME.md`](../docs/RUNTIME.md) for provider routing, transaction,
recovery, and qualification details.
