# Windows Runtime Handoff

Last updated: 2026-09-06

This tracked document contains repository-safe implementation context. The
Windows workspace now also has a private full copy of the Mac workspace,
including ignored qualification artifacts and `ft/` data. Possession of that
copy does not authorize Windows to mutate the live funnel or become the writer;
qualification, canary, and migration gates still apply.

## Current state

- Continue on branch `codex/model-agnostic-runtime`.
- The provider-free runtime, contracts, policy engine, sanitizer, renderer,
  router, qualification harness, transaction journal, recovery logic, schemas,
  compatibility adapters, and runtime tests are implemented.
- `package-lock.json` is tracked; a clean `npm ci` succeeds.
- The user confirmed `npm run runtime:test` is fully green on native Windows.
- Windows host ID: `AnmolDaPredator`.
- Observed hardware: 20 logical CPUs, 16 GB RAM, approximately 6 GB free at
  observation time. The RTX 4050 has 6 GB VRAM.
- Ollama `0.33.3` is bound to `127.0.0.1:11434`, and
  `qwen3:4b-instruct-2507-q4_K_M` is installed. It passed the 50-case
  `EXTRACTION` hardware qualification with 100 percent completion, schema
  success, and exact match. Median latency was 575 ms, p95 latency was 595 ms,
  and all 3,178,149,969 model bytes were GPU-resident. The ignored record is
  `.career-ops-runtime/hardware/ollama-qwen3-4b.json` and explicitly does not
  authorize routing.
- Codex CLI `0.153.4` and Antigravity CLI (`agy`) `1.1.27` were discovered on
  Windows and passed their version probes.
- `gpt-5.6-luna` and `gemini-3.8-flash-low` each passed a two-case Windows
  preflight in one provider call with 100 percent agreement and schema success,
  zero hard-gate or authorization errors, zero repairs, and zero failures. The
  metrics-only records are under `.career-ops-runtime/shadow/`.
- The full private workspace transfer is complete and Windows has
  `.career-ops-runtime/qualification-sets/historical-prepared-v14.json`.
  Its file SHA-256 is
  `a9f7bfbfb9749da83a6028c806420b02469152a9f68993fc46b7508368d76331`;
  its internal set digest is
  `40cb882eb00548e885f10676ee48487a0ae62078e5cdbd4ca1ff96506a4564f9`.
  It is a 50-case representative, human-approved recommendation component,
  not full promotion truth: `gate_labels_included` and `promotion_eligible`
  are false, with `RECOMMENDATION_ONLY_LABELS` and
  `SPLIT_LABEL_REVIEW_REQUIRED` blockers. Local indexes may exist on Windows
  for human navigation but must never be included in provider input.
- Direct Gemini CLI is retired. Google and partner-model runs use `agy`.
- All example providers are disabled by design. `available: false` with
  `usable: true` means the executable was found but the provider has not been
  enabled and qualified.
- API billing and subscription overages remain disabled.
- Ollama/local Qwen is hardware-qualified only for `EXTRACTION`/`LOW`; the
  provider remains disabled and cannot perform consequential evaluation.
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

1. Completed: confirm the checkout and local configuration without changing
   billing, quota, provider, or writer authorization.
2. Completed: install Ollama on Windows, bind it to loopback only, select a
   model that fits the 6 GB GPU, and record an `EXTRACTION`-class hardware
   qualification. Do not route consequential evaluation to the local model.
3. Completed: run small, quota-acknowledged Codex and Antigravity shadow checks
   against the committed deterministic fixture set. These diagnostic preflights
   do not qualify either model snapshot.
4. Ready on Windows: verify both digests for `historical-prepared-v14.json`,
   then run quota-bounded representative historical shadows. Treat the file as
   recommendation-only and do not expose either local source-report index to a
   provider. Resolve the split-label blocker independently before promotion.
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
API billing and overages are disabled, and Windows is not yet the live writer.
Ollama `0.33.3` is loopback-only and the pinned Qwen 3 4B Q4 model passed a
50-case `EXTRACTION` hardware qualification, but routing remains unauthorized.
Small `gpt-5.6-luna` and `gemini-3.8-flash-low` Windows preflights also passed;
neither diagnostic run is a production qualification. The full private Mac
workspace has been copied to Windows, including historical-prepared-v14.json
and local review indexes. The prepared set is representative recommendation
truth only and remains promotion-blocked until split labels are resolved.
Gemini CLI is retired; use agy for Google and partner models.

Begin with read-only verification of git state and config/runtime.local.yml.
Then continue milestone 4 from docs/WINDOWS_HANDOFF.md: verify the prepared-set
digests, run quota-bounded representative historical shadows, and resolve the
split-label blocker without sending local indexes to providers. Continue with
qualification bundling, isolated one-writer canaries, and only then
manifest-verified writer promotion. Do not weaken policy,
capability, evidence, quota, or transaction gates. Do not mutate the live ft/
funnel, enable billing, send/submit anything, commit personal data, or push
unless I explicitly request it. Report what you verified, changed, and what
remains after each milestone.
```
