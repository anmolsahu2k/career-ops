# Career-Ops Runtime

The runtime makes model output advisory. Its provider-free flow is `prepare -> respond -> validate -> PolicyEngine -> commit -> recover`. Contracts live in `schemas/runtime/`; executable policy and validation live in `lib/runtime/`.

## Safe first run

Copy `config/runtime.example.yml` to an ignored local configuration and leave every provider disabled. Observe commands and hardware without making provider calls:

```bash
node bin/career-ops.mjs doctor --config config/runtime.example.yml
npm run runtime:test
```

`doctor` is read-only by default. Add `--apply` only when you want to persist its 15-minute provider observations under the selected data root for routing.

Capture a metadata-only baseline with `node bin/career-ops.mjs baseline`. It counts dirty entries and data bytes without collecting filenames or file contents, estimates base and per-workflow instruction tokens, and aggregates token and latency medians from receipts. Later, compare with `--before baseline.json`.

API billing and subscription overages default to disabled. Enabling an API adapter requires both global `api_billing: true` and `enabled: true` for that provider. Ollama configurations marked `local_only` must use a loopback host.

Qualify local Ollama hardware without enabling routing or API billing:

```bash
node bin/career-ops.mjs hardware-qualify \
  --config config/runtime.local.yml \
  --provider ollama-qwen3-4b \
  --out .career-ops-runtime/hardware/ollama-qwen3-4b.json
```

The command requires an `EXTRACTION`/`LOW` local provider, runs at least 50
synthetic exact-match cases, verifies model residency through Ollama's loopback
status endpoint, and always records `routing_authorized: false`.

## Provider-free evaluation

Prepare a versioned task from a local seed:

```bash
node bin/career-ops.mjs prepare --input seed.json --out task.json
```

The prepared bundle contains a TaskEnvelope and a provider request whose evidence text is checked against the manifest hashes. Give that provider request to any qualified model, then save the JSON response. Validate without writing Career-Ops data:

```bash
node bin/career-ops.mjs validate --task task.json --response response.json
```

```bash
node bin/career-ops.mjs evaluate --skip-liveness
node bin/career-ops.mjs evaluate \
  --config config/runtime.local.yml \
  --provider antigravity-gemini-flash-high \
  --acknowledge-quota \
  --apply
```

`evaluate` is the single triage-evaluation command. Without `--apply` it
plans against `data/scan-results-*.tsv`. With `--apply` it runs liveness, fetches
JD evidence, then `prepare -> respond -> commit`, and removes committed or
expired URLs from the handoff. It never writes `reports/pending.md`
placeholders into the tracker. Prefer `--provider antigravity-gemini-flash-high`
for Antigravity Gemini 3.8 Flash High, or `--profile career-ops-job-v1` for the
Codex Luna judgment path.

Preview a commit, then explicitly apply it:

```bash
node bin/career-ops.mjs commit --task task.json --response response.json
node bin/career-ops.mjs commit --task task.json --response response.json \
  --config config/runtime.local.yml --apply
```

The second command is the only one above that writes a report and tracker row. It also persists an immutable decision, transaction journal, durable number reservation, and receipt. Repeating the same idempotency key returns the existing receipt. Every command that mutates the configured data or runtime root requires `--config`; the operating-system hostname must match its non-empty `writer_host`. Previews and other read-only commands do not require writer authorization.

## Providers and routing

Provider names, model snapshots, execution surfaces, pools, and commands exist only in runtime configuration. The generic command adapter uses `spawn` without a shell and an allowlisted environment. HTTP adapters cover OpenAI-compatible chat, Gemini generate-content, and Anthropic messages APIs. CLI entries cover Codex and Antigravity without coupling policy to their flags.

For CLI JSON envelopes, a schema-validated `structured_output` object is authoritative over display text. Text-mode retry prompts include only the bounded validation diagnostic and the original trusted request; a failed batched case is retried once as an explicitly identified repair rather than as a blind duplicate call. Provider-specific transport timeouts live in configuration and do not weaken schema, semantic, policy, or preflight checks.

Direct Gemini CLI execution is not supported. Google subscription-backed runs
use Antigravity CLI (`agy`). The Gemini HTTP adapter is a separate, disabled-by-
default API capability and cannot run while `api_billing` is false.

The legacy evaluator and batch runner are thin compatibility entrypoints. By default, `gemini-eval.mjs` delegates to `career-ops respond`, and `batch/batch-runner.sh` delegates to `career-ops batch`. Set `CAREER_OPS_RUNTIME=legacy` to reach the historical implementations during rollout. A provider-free batch manifest is:

The shell wrapper requires Bash. On native Windows without WSL or Git Bash,
invoke the same cross-platform path directly with
`node bin/career-ops.mjs batch ...`.
Command providers forward the minimal Windows profile variables needed for an
installed CLI to locate its credentials while continuing to exclude unrelated
environment secrets.

```json
{
  "schema": "RuntimeBatchManifestV1",
  "schema_version": 1,
  "entries": [
    { "id": "job-1", "task": "prepared-job-1.json", "response": "response-job-1.json" }
  ]
}
```

Paths are resolved relative to the manifest. Batch validation is the default; add `--apply` for sequential, transaction-protected commits.

Routing order is safety, minimum capability, required capabilities, qualification, risk, audit independence, quota, latency, then cost. It never falls below `TaskEnvelopeV1.minimum_capability_class`. A failed route returns a reasoned `NO_ELIGIBLE_PROVIDER` result.

The configuration-driven `career-ops-job-v1` profile uses Flash Low only to
rank bulk candidates, Luna Medium for the full A-G judgment, and Sol Medium for
bounded escalation. Individual jobs skip triage. Inspect the live-gated route
without invoking a provider with `route --profile career-ops-job-v1 --mode
individual|bulk`; every stage still passes through the normal qualification,
observation, risk, and quota gates.

See [MODEL_ROUTING.md](MODEL_ROUTING.md) for the canonical human-readable
strategy, escalation triggers, model roles, and activation status.

Estimate or execute a non-mutating pipeline shadow with:

```powershell
node bin/career-ops.mjs route-shadow `
  --suite <prepared-set.json> `
  --config <runtime.yml> `
  --profile career-ops-job-v1 `
  --max-judgments 50 `
  --max-escalations 10 `
  --checkpoint <checkpoint-prefix> `
  --acknowledge-quota `
  --out <pipeline-shadow.json>
```

Use `--plan-only --baseline <previous-ledger.json>` to project usage without
provider calls. Missing baseline stages remain `UNKNOWN` (`null` tokens), never
zero. Executed shadows require fresh manual observations for the ChatGPT and
Antigravity pools. The `PipelineShadowRunV1` ledger contains only usage,
latency, validation, and routing metadata; it never persists prompts, CV text,
job descriptions, or `local-index.md` files. Flash rankings can only advance or
defer work and never finalize a recommendation or write the funnel. Flash gets
a deterministic, bounded signal digest instead of full A-G presentation text,
and batches up to ten cases to amortize subscription CLI context overhead.

`--checkpoint <prefix>` writes immutable `<prefix>.triage.json`,
`<prefix>.judgment.json`, and `<prefix>.escalation.json` files after completed
stages. Resume an interrupted run with `--resume <latest-checkpoint.json>`;
completed provider stages are digest-verified and are not invoked again. A
resumed run must use the exact same suite digest, profile, and judgment and
escalation limits. Checkpoints contain only the same redacted decision, usage,
latency, and routing metadata permitted in the final ledger.

Qualification uses at least 50 cases, zero hard-gate and authorization errors, at least 95 percent recommendation agreement, a Wilson 95 percent lower bound of at least 90 percent, at least 99 percent schema success, bounded consequential UNKNOWN regression, shadow, and canary gates.

The qualification command accepts either precomputed `--metrics` or per-case `--results` plus `--metadata`. Per-case truth must come from deterministic oracle fixtures or human-approved labels, not another model.

Shadow records retain the normalized advisory recommendation, deterministic policy recommendation, tri-state gate values, policy reason codes, score, and confidence alongside the compared recommendation. This safe decision trace contains no raw response or presentation text and makes model-versus-policy disagreements diagnosable. A legacy final historical outcome is not treated as atomic advisory or policy truth: it may encode both merit judgment and a hard-gate decision. Such cases run as `DIAGNOSTIC_FINAL_OUTCOME`, are excluded from recommendation-agreement denominators, and add `SPLIT_LABEL_REVIEW_REQUIRED` until advisory recommendation and gate disposition are independently approved. Individual gate accuracy comes only from the separate deterministic hard-gate suite. Successful raw provider responses are not retained.

When the user truthfully attests that they personally reviewed the recommendation
labels in one exact prepared-set digest, the completed diagnostic trace may be
reused without a second review or another provider invocation:

```bash
npm run runtime:reinterpret-history -- \
  --suite historical-prepared.json \
  --run historical-diagnostic-shadow.json \
  --attestation scope-direction-id \
  --labels-personally-reviewed \
  --accept-final-outcomes-as-recommendations \
  --out recommendation-shadow.json
```

This digest-bound override compares only the recorded advisory recommendation,
clears only `SPLIT_LABEL_REVIEW_REQUIRED`, and retains
`RECOMMENDATION_ONLY_LABELS`, `gate_labels_included: false`, and
`promotion_eligible: false`. It rejects any other prepared-set blocker and does
not create or infer gate truth. All numerical qualification thresholds remain
unchanged. A model-generated historical decision is not human-approved truth;
it remains diagnostic unless the user later reviews the underlying labels. A
user-designated flagship model may serve as the authoritative advisory reference
for subjective recommendation judgment, but agreement with that reference is
not an accuracy metric and cannot satisfy qualification truth requirements.

Human-approved historical labels are prepared with `npm run runtime:historical-fixtures`. The prepared evidence body removes prior overall scores, statuses, final recommendations, direct target-company strings, URLs, and direct candidate identity. It retains bounded evidence from every decision-relevant historical block; prose lines receive enough room to preserve late constraint clauses, while section budgets still cap total context. Removing risk or constraint sections to save tokens is forbidden because it changes recommendation quality. The provider receives a fixed recommendation rubric and calibration rules from trusted task rules, and task input cannot weaken or replace them. A concrete, honestly disclosed skill gap does not by itself force `CONSIDER` when the experience bar is met and the role remains a strategically reasonable 4/5-or-better pursuit; `CONSIDER` covers 3-3.9/5 fits and unresolved evidence, level, eligibility, or merits uncertainty. Historical outcomes that depend on comparing another role, an application cap, or portfolio ordering block qualification because a standalone TaskEnvelope cannot reproduce that decision. Because the set has no approved hard-gate labels, it is a recommendation component and cannot promote a model by itself.

Before rebuilding the prepared set, `npm run runtime:historical-evidence` may replace discovery-only stubs with current evidence from the exact Greenhouse, Workday, or Ashby posting already bound to the approved tracker row. The command writes only to the ignored local qualification cache, requires an explicit apply flag in its underlying script, checks the returned title, and fails closed for removed jobs, generic company pages, redirects to a different requisition, or unsupported sources. Cached records are digest-bound and never turn a recommendation label into a hard-gate label. Because a label approved from an unresolved stub is not automatically valid against later job evidence, such a case adds `LIVE_EVIDENCE_LABEL_REVIEW_REQUIRED` until its recommendation record contains the exact `approved_evidence_record_digest`. Recommendation-set revisions also preserve their source-set and replacement-pack digests; a historical report whose explicit outcome contradicts the proposed label blocks the component instead of being silently scored.

Run the synthetic transport and hard-gate shadow suite without enabling production routing:

```bash
node bin/career-ops.mjs shadow \
  --suite tests/fixtures/runtime-qualification-set-v1.json \
  --config config/runtime.local.yml \
  --provider antigravity-gemini-flash \
  --limit 1 \
  --acknowledge-quota
```

For a small qualification smoke test, add `--preflight`. The command writes the complete shadow artifact but exits with status 2 unless recommendation agreement and schema success are 100 percent, all cases complete, hard-gate and authorization errors are zero, and no repair was needed. `--minimum-agreement <0..1>` can lower only the advisory-agreement check when a documented test protocol calls for it; `--allow-preflight-repairs` relaxes only the repair check. Neither flag changes full qualification thresholds.

After a failed full run, use `--case-ids CASE-1,CASE-2` with `--preflight` to screen another candidate against the exact challenge cases without evaluating their neighbors. Case IDs must be unique and belong to the digest-verified suite; `--case-ids` cannot be combined with `--offset`. A targeted run is diagnostic only and cannot satisfy the complete-set promotion gate.

Increase the limit only after checking subscription quota. Shadow output contains metrics and response digests, not raw responses. The synthetic suite cannot replace redacted historical cases or the one-writer canary required for production.

The synthetic suite declares `truth_source: DETERMINISTIC_ORACLE`, covers hard gates and final policy decisions, and is deliberately non-representative. A completed shadow run records `component_passed` separately from `qualification.qualified`. After the same resolved provider/model snapshot passes both the representative recommendation set and deterministic hard-gate set, combine them with:

```bash
node bin/career-ops.mjs qualify-bundle \
  --recommendations recommendation-shadow.json \
  --hard-gates hard-gate-shadow.json \
  --out qualification-bundle.json
```

The command rejects mismatched model snapshots, missing deterministic gate truth, non-representative recommendations, and unresolved historical-evidence blockers. A passing bundle can enter `shadow`; it cannot reach production until a separate canary passes.

After at least three end-to-end canary commits on an isolated copy of the configured writer root, certify their receipts without invoking a model or changing data:

```bash
node bin/career-ops.mjs canary-certify \
  --qualification qualification-bundle.json \
  --receipts receipt-1.json,receipt-2.json,receipt-3.json \
  --target /path/to/canary-root \
  --out canary-certification.json
```

Certification verifies every receipt and artifact against the target, exact provider/model identity, bounded attempts, no capability degradation, unique tasks and transactions, and a single recorded writer host. A failed certification exits with status 2 and cannot advance the qualification beyond shadow.

An evaluation set must explicitly declare `"representative": true` before it can satisfy the representative-sample or shadow-promotion checks. Synthetic suites declare `false`, even when all numerical metrics pass. Historical labels must be human-approved or deterministic; prior model recommendations are not ground truth.

Build a 50-case, locally redacted historical review pack without changing the
tracker or reports:

```bash
npm run runtime:label-pack
```

The generated JSON and Markdown live under the ignored
`.career-ops-runtime/label-review/` directory. Every proposed label remains
`REVIEW_REQUIRED` until a human approves or edits it; generating the pack never
sets `representative: true`. A separate local-only index links each opaque case
to its source report; do not send that identifying companion file to providers.

Human approval of historical recommendations produces a separate
`RuntimeHistoricalRecommendationSetV1`. Automatically inferred gate values are
not promoted with it: `gate_labels_included` remains false until those gates
receive their own evidence-backed approval. An independent model audit is
recorded as advisory provenance and cannot override the user's attestation. A
replacement audit must name and support every replacement, contain no
discrepancies, and bind its provider/model provenance to the exact replacement
pack digest; an approval for another pack is rejected.

For the full 50-case transport suite, `--provider-runs 20` partitions the cases into schema-constrained batches of two or three. This meets the provider-run sample while amortizing CLI context overhead. Qualification presentation fields are capped at 320 characters and requested as one short sentence. Case metrics remain independent, and one malformed batch receives at most one repair attempt. A successful fallback records the safe validation error that caused it; CLI output paths are created atomically with mode `0600` and are never overwritten.

## Writer and recovery

One host owns the writer lease. Heartbeats occur every five seconds and expire after 60 seconds. A fresh heartbeat, a matching live process identity, or a different-host owner blocks takeover. PID reuse is detected when the recorded process-start identity differs.

Recovery is explicit and deterministic:

```bash
node bin/career-ops.mjs recover --target /path/to/data-root \
  --config config/runtime.local.yml --apply
```

Recovery never invokes a model. Artifact paths must remain inside the selected root and cannot cross symlinks. Expected and observed hashes prevent recovery from overwriting concurrent edits.

## Rollout

## Application attempts

The optional application pipeline uses the existing Job Autofill extension in a
headed, dedicated persistent Chrome profile. It is disabled by default and is
not scheduled: invoke it only after a user-triggered scan has merged and passed
verification.

`applications.supported_ats` is an enforced active-rollout allowlist. Attempts
for a deferred ATS remain queued and visible on the Apply Board, but the runner
does not open, fill, navigate, or submit them until that ATS is added locally.

The dedicated profile remains the default. LinkedIn and Handshake may use the
already signed-in main Chrome only after their adapters are certified and an
explicit `applications.main_profile` configuration points to a loopback Chrome
DevTools endpoint. The runner must attach through that endpoint; it never
copies, launches, or reads the live Chrome profile directory. Existing tabs are
left untouched and a dedicated application tab is created for each attempt.
The LinkedIn extension adapter is intentionally job-view-only during this
development stage and is not an active ATS allowlist entry yet.

```powershell
# Read-only list of live Evaluated / APPLY / >=4.0 rows.
node bin/career-ops.mjs apply enqueue

# Queue the current eligible backlog (writes only ignored local attempt state).
node bin/career-ops.mjs apply enqueue --include-current --config config/runtime.local.yml --apply

# Explicitly queue one user-selected Evaluated row outside the normal score /
# APPLY gate. The one-off override is recorded on the local attempt and still
# requires the row, report, role, company, and canonical URL to remain unchanged.
node bin/career-ops.mjs apply override --tracker-number 5237 --config config/runtime.local.yml --apply

# Requeue one locally blocked attempt after an adapter repair or user fix.
node bin/career-ops.mjs apply retry --tracker-number 5237 --config config/runtime.local.yml --apply

# Requeue an uncertain post-click attempt only after the candidate explicitly
# confirms that the employer did not create or receive the application.
node bin/career-ops.mjs apply retry --tracker-number 5237 --confirm-not-submitted --config config/runtime.local.yml --apply

# Headed canary: fills and validates only. It cannot click Submit without both
# applications.auto_submit: true and this explicit --submit flag.
node bin/career-ops.mjs apply run --config config/runtime.local.yml --apply

# Run only one exact queued row. This cannot fall through to another attempt.
node bin/career-ops.mjs apply run --tracker-number 5237 --config config/runtime.local.yml --apply

# Optional, candidate-present authentication handoff. Keeps only the
# dedicated-profile page open for a bounded period after an ATS asks for a
# login or one-time code; it never reads email or enters the code.
node bin/career-ops.mjs apply run --config config/runtime.local.yml --apply --submit --pause-for-auth

# Review local blockers and terminal outcomes.
node bin/career-ops.mjs apply serve
```

An enabled post-merge scan workflow may call `career-ops apply after-scan --config
config/runtime.local.yml --tracker-numbers 5280 --apply` only when
`auto_after_scan: true`; it queues exactly the rows committed by that scan and
then processes one at a time.

Attempts live under `ft/.career-ops-runtime/applications/`, keyed by tracker
number plus canonical URL. `SUBMITTED` and `SUBMISSION_UNKNOWN` are never
automatically retried. Only an adapter-recognized success transitions the
nine-column tracker row to `Applied`; incomplete cases stay `Evaluated` and
are shown in the local board at `127.0.0.1`.

Local prose remains canary-only until it passes a separate application-prose
qualification benchmark; hardware residency alone never grants it submission
authority. A qualified local provider may then propose one bounded batch of
job-specific prose. Hosted fallback remains available only after normal
qualification and quota routing; every generated answer must cite supplied
evidence and pass deterministic claim validation. A generated-content
disclosure is never auto-answered "No" when any generated prose was used.

Greenhouse cover-letter text is separately opt-in through
`applications.local_prose.cover_letters: true`. When enabled, the runner uses
Greenhouse's exact `cover_letter-text` control to reveal the manual textarea,
then requests a body-only, job-specific letter from the qualified local prose
provider. It preserves paragraph breaks, enforces the 200-word template limit,
requires both current-job and candidate-profile evidence, and never falls back
to a hosted provider. File-upload cover-letter slots remain untouched.

Compensation intent is separate from candidate prose. The runner leaves current or
previous salary, total compensation, bonus, and equity blank. For an expected,
minimum, range, total-compensation, bonus, or dollar-denominated equity question,
it may ask the qualified local provider for a job-scoped prospective annual
preference using the current report and trusted local context. The answer must be
a bounded dollar number or ascending range, fit the field constraint, and carry
`local-salary-preference` provenance. Share-count and equity-percentage questions
remain review-only. If local generation cannot produce that shape, only a
configured qualified Antigravity fallback is eligible; Codex subscription providers
are not an implicit fallback. Optional
marketing, talent-community, job-alert, and future-opportunity consent controls
are always left unselected.

Run the local-only prose benchmark without invoking a hosted provider:

```powershell
node bin/career-ops.mjs apply qualify-local-prose --config config/runtime.local.yml --provider ollama-qwen3-4b --out .career-ops-runtime/qualifications/ollama-qwen3-4b-application-prose.json
```

It uses at least 50 synthetic evidence-grounded answers, validates every
claim independently, includes prompt-injection cases, and retains only
digests/metrics. Set `local_prose.qualified: true` and bind the resulting
ignored artifact path only after it passes.
No generated prose is promoted into the extension's global answer bank.

Keep `CAREER_OPS_RUNTIME=legacy` entrypoints available while fixtures, shadow comparisons, provider qualification, and one-writer canaries run. Do not move writer ownership to Windows until hardware qualification and a manifest-verified one-way migration pass. The Mac can remain a read-only client and recovery copy.

For the current Windows-machine state, ordered next milestones, and a
ready-to-paste continuation prompt, see [WINDOWS_HANDOFF.md](WINDOWS_HANDOFF.md).
