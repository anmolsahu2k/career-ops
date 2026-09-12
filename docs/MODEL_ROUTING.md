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
`--provider antigravity-gemini-flash-high` selects Gemini 3.8 Flash High through
Antigravity (`agy`) for full A-G judgment. That provider is consequential-capable
and is separate from Flash Low triage in `career-ops-job-v1`. The full
manual/no-agent loop is in [SCRIPTS.md](SCRIPTS.md#manual-workflow-no-agent).

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
currently enabled. All profile providers remain disabled in the local runtime
configuration, resource-pool quota states are `UNKNOWN`, and automatic routing
must fail closed until qualification, quota, receipt, migration, integrity, and
writer-authorization gates pass.

In one line:

> Flash Low ranks, Luna Medium evaluates, Sol Medium reviews the consequential
> 20 percent, and deterministic Career-Ops policy decides and writes.
