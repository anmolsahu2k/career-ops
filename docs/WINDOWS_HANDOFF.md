# Windows Runtime Handoff

Last updated: 2026-09-06

This tracked document contains repository-safe implementation context. The
Windows workspace now also has a private full copy of the Mac workspace,
including ignored qualification artifacts and `ft/` data. Under the
user-authorized lean rollout, Windows is the operational sole writer. The Mac
copy must remain read-only. Model routing remains disabled and separate from
writer authorization.

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
- The v14 digests and all 50 case evidence digests were verified on Windows.
  Quota-bounded 20-run historical diagnostics completed for `gpt-5.6-luna`
  and `gemini-3.8-flash-low` without retaining raw responses. Under the user's
  explicit digest-bound recommendation-scope direction, the existing advisory
  traces scored 76 percent and 80 percent recommendation agreement,
  respectively. This clears only `SPLIT_LABEL_REVIEW_REQUIRED`; both candidates
  remain below the unchanged 95 percent recommendation floor.
- Both model snapshots passed the separate 50-case deterministic hard-gate
  component with 100 percent agreement, schema success, and evidence accuracy,
  and zero hard-gate or authorization errors. Luna used no repairs. Gemini Flash
  Low had a 24 percent repair rate. Bundle construction correctly rejects both
  because their representative recommendation components did not pass.
- A quota-limited `gpt-6-astra` high-reasoning challenge screen scored 0 of 10
  against the difficult v14 recommendation cases. All ten responses were
  `CONSIDER`; schema validation passed. The planned full run was stopped after
  the screen to avoid spending more quota on a candidate that could not close
  the recommendation gap.
- Direct Gemini CLI is retired. Google and partner-model runs use `agy`.
- All example providers are disabled by design. `available: false` with
  `usable: true` means the executable was found but the provider has not been
  enabled and qualified.
- API billing and subscription overages remain disabled.
- Ollama/local Qwen is hardware-qualified only for `EXTRACTION`/`LOW`; the
  provider remains disabled and cannot perform consequential evaluation.
- Three isolated provider-free Windows commits passed receipt verification on
  host `AnmolDaPredator`. Each produced a unique transaction and complete,
  hash-matching decision, report, and tracker artifacts.
- The copied `ft/` tree has a verified post-copy Windows baseline of 4,743 files
  and 45,491,166 bytes with inventory digest
  `301e81adeb43d5c2bb2c6ff2a1af9f0f48f21e196aef5d0f8f4742e7566b22b8`.
  No Mac-side cryptographic manifest exists, so this proves internal integrity
  of the Windows baseline, not source-to-target equality. Copy completeness is
  based on the user's transfer attestation.
- Windows is now authorized as the operational sole writer. The ignored audit
  record is `.career-ops-runtime/migration/windows-writer-promotion-v1.json`.
  The current CLI does not enforce `writer_host`, so the Mac workspace must be
  kept read-only by operational discipline. No provider has been promoted.

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
4. Completed: verify both digests for `historical-prepared-v14.json`, run
   quota-bounded historical shadows, and apply the explicit digest-bound
   recommendation-scope direction without exposing a local source-report index
   or inventing gate truth.
5. Paused by user direction: the deterministic hard-gate components pass, but
   Luna, Gemini Flash Low, and the Astra challenge screen do not meet the
   unchanged recommendation floor. All provider routes remain disabled. Resume
   model qualification only when its value justifies the quota and elapsed time.
6. Completed: three isolated provider-free end-to-end commits produced valid,
   unique receipts on the Windows host.
7. Completed under the user-authorized lean rollout: verify a post-copy Windows
   data baseline and promote Windows to the operational sole writer. A Mac-side
   source manifest was unavailable, and `writer_host` is not runtime-enforced;
   both limitations are explicit in the ignored promotion audit record.

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
API billing and overages are disabled, and Windows is the operational sole
writer. Keep the Mac workspace read-only. This status is not yet enforced by
the CLI's `writer_host` setting.
Ollama `0.33.3` is loopback-only and the pinned Qwen 3 4B Q4 model passed a
50-case `EXTRACTION` hardware qualification, but routing remains unauthorized.
Small `gpt-5.6-luna` and `gemini-3.8-flash-low` Windows preflights also passed;
neither diagnostic run is a production qualification. The full private Mac
workspace has been copied to Windows, including historical-prepared-v14.json
and local review indexes. The prepared set is representative recommendation
truth only and remains promotion-blocked until split labels are resolved.
Gemini CLI is retired; use agy for Google and partner models.

Begin with read-only verification of git state and config/runtime.local.yml.
Model qualification is paused after Luna scored 76 percent, Gemini Flash Low
scored 80 percent, and the Astra High challenge screen scored 0 of 10 against
the unchanged 95 percent recommendation floor. Keep all provider routes
disabled. Three provider-free Windows canaries and the post-copy data baseline
passed, and Windows is the operational sole writer. Keep the Mac workspace
read-only. Do not weaken policy, capability, evidence, quota, or transaction
gates. Do not enable billing, send/submit anything, commit personal data, or
push unless I explicitly request it. Report what you verified, changed, and
what remains after each milestone.
```
