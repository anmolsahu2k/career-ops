# Career-Ops Model Routing Strategy

Last reviewed: 2026-09-08

This document is the canonical human-readable reference for the
`career-ops-job-v1` routing profile. Provider IDs and thresholds remain
authoritative in `config/runtime.local.yml`; deterministic policy must never
branch on a model name.

## Final routing ladder

| Stage | Default implementation | Responsibility | Authority |
|---|---|---|---|
| Deterministic intake | Career-Ops runtime | Deduplication, canonical evidence resolution, liveness, age, eligibility, sponsorship, geography, and evidence validation | Authoritative filter |
| Bulk triage | Gemini 3.8 Flash Low through Antigravity | Rank compact batches of surviving candidates | `RANK_ONLY` |
| Routine judgment | GPT-5.6 Luna with medium reasoning through Codex CLI | Produce the complete advisory A-G evaluation | `ADVISORY_FULL_A_G` |
| Escalation | GPT-5.6 Sol with medium reasoning through Codex CLI | Review valuable, borderline, uncertain, or conflicting judgments | `ADVISORY_REVIEW` |
| Final policy and writes | Deterministic Career-Ops runtime | Apply hard gates, validate artifacts, authorize the single writer, and commit transactionally | Authoritative |

For bulk scans, deterministic intake runs before model calls. Flash receives
batches of at most ten compact signal digests. It can advance or defer a job,
but it cannot reject a job, finalize a recommendation, or mutate the tracker.
The configured judgment budget determines how many ranked candidates advance
to Luna.

Individual user-supplied jobs skip Flash and begin with Luna.

For the unattended `npm run evaluate` / `career-ops evaluate` path, an explicit
`--provider antigravity-gemini-flash-high` or
`--provider antigravity-gemini-flash-medium` selects Gemini 3.8 Flash High or
Medium through Antigravity (`agy`) for full A-G judgment. Flash High is
consequential-capable; Flash Medium is the standard-tier Antigravity option.
Both are separate from Flash Low triage in `career-ops-job-v1`. The full
manual/no-agent loop is in [SCRIPTS.md](SCRIPTS.md#manual-workflow-no-agent).

## Windows workstation configuration

The active workstation is the Windows machine (`AnmolDaPredator`: i5 13th gen,
16 GB RAM, RTX 4050 6 GB), which also holds the writer lock. `agy`, `codex`,
`ollama`, and `python` are all on `PATH` there. The 6 GB VRAM budget rules out a
local judgment model: a 4-bit 14B model leaves no room for the 20k-plus token
evidence payload an A-G evaluation carries, so local inference stays limited to
Qwen3 4B extraction and application prose.

`config/runtime.local.yml` therefore defines `career-ops-windows-v1`, which
keeps deterministic policy identical to `career-ops-job-v1` but sources
judgment from the subscription with the most headroom:

| Stage | Provider | Why |
|---|---|---|
| Bulk triage | `antigravity-gemini-flash-low` | Cheapest ranking pass on the Google AI Pro pool |
| Routine judgment | `antigravity-gemini-flash-high` | Consequential-capable, long-context, already qualified for evaluate |
| Escalation | `codex-luna` | Different vendor on ChatGPT Plus, so boundary cases get an independent read |

`cerebras-gpt-oss-120b` is configured separately as the high-throughput sweep
provider. Its free-tier key incurs no charges, which the provider entry
declares with `free_tier: true` so it runs without enabling the global
`api_billing` switch. Use it to score a large backlog quickly, then re-run the
boundary cases through Flash High. `groq-llama-70b` is the overflow if Cerebras
is rate-limited.

Ready-made commands (`package.json`):

| Script | Purpose |
|---|---|
| `npm run evaluate:plan` | Dry run: pre-filters, liveness, prune rejects, save eval queue |
| `npm run evaluate:sweep` | Score only the saved eval queue through Cerebras |
| `npm run evaluate:overflow` | Cerebras backup: score only the saved eval queue through Groq |
| `npm run evaluate:judge` | Score only the saved eval queue through Flash High |
| `npm run evaluate:ladder` | Score only the saved eval queue through the Windows profile |

Concurrency stays low deliberately. The bottleneck is not the CPU but the
liveness stage's Chromium instances and the provider's rate limit, and each
committed evaluation takes the single writer lock, so parallel commits
serialize regardless.

## Sol escalation policy

A Luna judgment is eligible for Sol review when any of these conditions holds:

- Luna recommends `APPLY`.
- The score is at least 4.0.
- The score is within the 3.8 to 4.2 decision boundary.
- Confidence is below 0.85.
- Flash and Luna disagree.
- Role fit, seniority, compensation, or other decision evidence conflicts.

Sol reviews at most 20 percent of completed Luna judgments, rounded up, and is
also bounded by the command's `--max-escalations` value. When triggers exceed
the cap, priority is:

1. `APPLY` recommendations.
2. Lowest confidence.
3. Flash/Luna disagreement.
4. Stable case ID order.

Missing evidence by itself does not consume Sol capacity. Career-Ops performs
the single permitted enrichment pass, preserves unresolved facts as `UNKNOWN`,
and lets deterministic policy downgrade or require review.

## Non-default models

- GPT-6 Astra is an explicit user-selected override or independent audit, not
  part of default routing.
- GPT-5.6 Terra remains configured for diagnostics but is not used by this
  profile.
- Qwen3 4B remains limited to extraction and future offline fallback work. It
  cannot make Career-Ops judgment decisions.
- Further local judgment-model benchmarking is deferred and is not a rollout
  blocker.

The selection rationale is that Luna provided the strongest measured
consensus/cost combination in the repository benchmark: 38 of 50 agreement
with Claude-authored history, 40 of 50 with the Astra advisory reference, and
30 of 50 with both. These historical labels remain advisory model references,
not objective truth or hard-gate labels.

OpenAI describes GPT-5.6 Luna as the cost-sensitive, high-volume model in its
family and GPT-5.6 Sol as the flagship for complex professional work. Both
support Structured Outputs:

- [GPT-5.6 Luna documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [GPT-5.6 Sol documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol)

## Safety and authorization invariants

- Models advise; deterministic gates remain authoritative.
- No model response directly authorizes a write.
- Neither `local-index.md` file may enter provider input.
- Every response must pass schema, evidence, recommendation-consistency, risk,
  quota, and qualification checks.
- Subscription pools require fresh quota observations and preserve the
  configured 20 percent reserve.
- API billing and subscription overages remain disabled.
- Career-Ops never automatically submits an application or sends a message.
- Reports and tracker rows are written only through the single-writer,
  transaction-protected runtime.

## Current activation state

This is the final target strategy, not a claim that live automatic routing is
currently enabled. Automatic routing must still fail closed until qualification,
quota, receipt, migration, integrity, and writer-authorization gates pass.

The Windows runtime enables `antigravity-gemini-flash-low`,
`antigravity-gemini-flash-medium`, `antigravity-gemini-flash-high`,
`codex-luna`, `cerebras-gpt-oss-120b`, and `ollama-qwen3-4b`. Enabling a
provider only makes it selectable; it does not qualify it. The subscription
pools (`chatgpt-plus`, `google-gemini`) still report `UNKNOWN` quota, so every
run needs an explicit `--provider` or `--profile` plus `--acknowledge-quota`.
Providers without a qualification artifact are recorded as forced in the result
under `provider_override`, and a provider that deliberately failed
qualification requires `--force-provider`.

In one line:

> Flash Low ranks, Luna Medium evaluates, Sol Medium reviews the consequential
> 20 percent, and deterministic Career-Ops policy decides and writes.
