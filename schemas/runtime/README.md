# Runtime schemas

`contracts.v1.schema.json` contains the provider-neutral V1 definitions for TaskEnvelope, evidence, raw provider results, normalized evaluations, immutable policy decisions, commit plans, journals, receipts, environment observations, capability profiles, resource pools, and model qualifications.

`provider-response.v1.schema.json` is the constrained model-facing response shape used by CLI providers that support schema-enforced output.

`qualification-batch-response.v1.schema.json` constrains two-to-three-case shadow batches so provider startup context is amortized without combining their scoring records.

`historical-recommendation-set.v1.schema.json` records human-approved recommendation labels. `prepared-qualification-set.v1.schema.json` binds those labels to redacted, outcome-free provider inputs. Historical recommendation-only sets are deliberately non-promotable until a separate deterministic hard-gate suite is combined with them.

`qualification-set.v1.schema.json` identifies the deterministic hard-gate oracle as synthetic and non-representative. `qualification-evidence-bundle.v1.schema.json` combines a passing recommendation component and a passing hard-gate component from the same provider/model snapshot; the combined qualification can enter shadow but remains non-production until a canary passes.

`CanaryCertificationV1` binds a shadow-qualified bundle to verified end-to-end commit receipts from one writer host. It is computed without model calls and cannot pass with duplicate tasks, degraded provider output, mismatched provider/model identity, invalid artifacts, or cross-host writes.

Historical recommendation revisions are immutable: `revision.source_set_digest` links the prior approved set and `replacement_pack_digest` links the exact reviewed substitutions. Prepared sets record incomplete-source and explicit-outcome-conflict counts as independent promotion blockers.

Runtime validation is enforced in deterministic code under `lib/runtime/contracts.mjs`; the JSON Schema bundle is the interchange and tooling contract. New versions must be additive or use a new schema version. Persisted objects always identify both their schema name and version.
