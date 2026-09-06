# Windows Runtime Handoff

Last updated: 2026-09-06

This document transfers repository-safe implementation context to the Windows
machine. It intentionally excludes credentials, the live `ft/` funnel,
generated `.career-ops-runtime/` state, source-report indexes, and personal
artifacts. Those remain local and must use the manifest-verified migration
process after qualification and canary gates pass.

## Current state

- Continue on branch `codex/model-agnostic-runtime`.
- The provider-free runtime, contracts, policy engine, sanitizer, renderer,
  router, qualification harness, transaction journal, recovery logic, schemas,
  compatibility adapters, and runtime tests are implemented.
- `package-lock.json` is tracked; a clean `npm ci` succeeds.
- The user confirmed `npm run runtime:test` is fully green on native Windows.
- Windows host ID: `AnmolDaPredator`.
- Observed hardware: 20 logical CPUs, 16 GB RAM, approximately 6 GB free at
  observation time. The RTX 4050 has 6 GB VRAM and still needs local-model
  qualification.
- Codex CLI `0.153.4` and Antigravity CLI (`agy`) `1.1.27` were discovered on
  Windows and passed their version probes.
- Direct Gemini CLI is retired. Google and partner-model runs use `agy`.
- All example providers are disabled by design. `available: false` with
  `usable: true` means the executable was found but the provider has not been
  enabled and qualified.
- API billing and subscription overages remain disabled.
- Ollama/local Qwen is not yet installed, running, or qualified.
- Windows is not yet authorized as the live writer. Do not copy or mutate the
  live `ft/` funnel until qualification, isolated canaries, and verified
  migration are complete.

## Start on Windows

In PowerShell:

```powershell
git switch codex/model-agnostic-runtime
git pull --ff-only
npm ci
npm run runtime:test

if (-not (Test-Path config\runtime.local.yml)) {
  Copy-Item config\runtime.example.yml config\runtime.local.yml
}
```

Set this machine-local value in `config\runtime.local.yml`:

```yaml
writer_host: AnmolDaPredator
```

Keep every provider disabled during the initial read-only observation:

```powershell
node bin/career-ops.mjs doctor --config config/runtime.local.yml
```

The doctor command is read-only unless `--apply` is supplied. A large latency
sentinel on an unavailable provider means latency was not measured; it is not
an actual multi-year response time.

## Next implementation milestones

1. Confirm the clean checkout and local configuration without changing billing,
   quota, provider, or writer authorization.
2. Install Ollama on Windows, bind it to loopback only, select a model that fits
   the 6 GB GPU, and record an `EXTRACTION`-class hardware qualification. Do not
   route consequential evaluation to the local model.
3. Run small, quota-acknowledged Codex and Antigravity shadow checks against the
   committed deterministic fixture set. A discovered CLI is not a qualified
   model snapshot.
4. Transfer only the redacted qualification component needed for historical
   shadowing. Do not upload the local source-report index to a provider and do
   not commit it to Git.
5. Build the representative recommendation and deterministic hard-gate
   qualification bundle. Enforce the thresholds in `docs/RUNTIME.md`.
6. Run at least three isolated end-to-end canary commits and certify their
   receipts on one Windows host.
7. Only after every gate passes, perform the manifest-verified one-way live-data
   migration and promote Windows to the sole writer.

Stop and report instead of weakening a capability class, qualification floor,
quota reserve, policy gate, evidence requirement, or transaction safeguard.

## Safety boundaries

- Do not enable API billing or subscription overages.
- Do not submit applications, send messages, generate resume PDFs, schedule
  workflows, change the tracker schema, or push without an explicit request.
- Do not commit `config/runtime.local.yml`, `.career-ops-runtime/`, `.mcp.json`,
  `.codex/config.toml`, credentials, `ft/` data, reports, or local review indexes.
- Native Windows should call `node bin/career-ops.mjs batch ...`; the legacy
  `batch/batch-runner.sh` wrapper requires WSL or Git Bash.
- Preserve `UNKNOWN` and fail closed with `NO_ELIGIBLE_PROVIDER` when no route
  satisfies the minimum capability and qualification requirements.

## Continuation prompt for Codex

Paste the following into a new Codex session opened at the Windows checkout:

```text
Continue the Career-Ops model-agnostic runtime rollout on Windows.

First read AGENTS.md, CAREER_OPS.md, docs/RUNTIME.md, and
docs/WINDOWS_HANDOFF.md. Continue on branch codex/model-agnostic-runtime and
preserve all ignored/personal data and unrelated worktree changes.

Known state: npm ci succeeds; npm run runtime:test is fully green on native
Windows; host ID is AnmolDaPredator; Codex CLI 0.153.4 and agy 1.1.27 are
installed and usable. Providers are intentionally disabled and unqualified,
API billing and overages are disabled, Ollama is not yet qualified, and Windows
is not yet the live writer. Gemini CLI is retired; use agy for Google and
partner models.

Begin with read-only verification of git state and config/runtime.local.yml.
Then continue the next incomplete milestone from docs/WINDOWS_HANDOFF.md:
Windows Ollama hardware qualification, followed by small quota-acknowledged
Codex/Antigravity shadows, qualification bundling, isolated one-writer canaries,
and only then manifest-verified live-data migration. Do not weaken policy,
capability, evidence, quota, or transaction gates. Do not mutate the live ft/
funnel, enable billing, send/submit anything, commit personal data, or push
unless I explicitly request it. Report what you verified, changed, and what
remains after each milestone.
```
