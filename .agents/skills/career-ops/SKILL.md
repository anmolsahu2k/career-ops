---
name: career-ops
description: Run this repository's career-search workflows, including job evaluation, source scans, tracker operations, application answers, interview preparation, and outreach drafts. Use for Anmol's job-search operations in this repo, not for generic code maintenance.
---

# Career-Ops

Use the existing Career-Ops modes, scripts, templates, and tracker flow. Do not create a second implementation.

## Start

1. Read the provider-neutral root `CAREER_OPS.md` completely. Read `CLAUDE.md` only when a selected legacy mode explicitly requires historical detail not present there.
2. Read `STATUS.md` only when current funnel state or outstanding work matters.
3. Before a mutating scan or evaluation run, check for `ft/data/scan-results-*.tsv`. If one exists, follow the split-mode resume contract in `modes/scan.md` before starting fresh discovery.
4. Infer the requested mode from the words after `$career-ops` or from the user's natural-language request. A job URL or pasted JD without a named mode is `auto-pipeline`.

## Route

Read only the files required by the selected mode:

| Request | Read |
|---|---|
| Job URL or JD | `modes/_shared.md`, then `modes/auto-pipeline.md` |
| `offer` | `modes/_shared.md`, then `modes/offer.md` |
| `offers` | `modes/_shared.md`, then `modes/offers.md` |
| `scan` | `modes/scan.md` only; it is standalone and repeats the shared rules it needs |
| `apply` | `modes/_shared.md`, then `modes/apply.md` |
| `batch` | `modes/_shared.md`, then `modes/batch.md` |
| `contact` | `modes/_shared.md`, then `modes/contact.md` |
| `pdf` | `modes/_shared.md`, then `modes/pdf.md`; use it only as resume-formatting reference because PDF generation is disabled |
| `tracker`, `deep`, `training`, `project`, `patterns`, `followup`, `interview-prep`, `gmail-sweep`, `outreach` | The matching file under `modes/` |
| `backup` | `docs/RECOVERY.md`; run a real backup only when explicitly requested |

Accept `oferta`, `ofertas`, and `contacto` only as legacy aliases for `offer`, `offers`, and `contact`.

If no mode or actionable input is supplied, show the available modes and make no changes.

## Execute

- Follow the selected mode and the hard rules in `CAREER_OPS.md`. The full A-G report format is mandatory on every evaluation path.
- Never treat a historical decision authored by a model as human-approved truth. Such labels may support model-to-model agreement diagnostics only. The user may designate a model as the authoritative advisory reference for subjective recommendation judgment, but its outputs remain model-reference policy rather than qualification truth and cannot qualify that model or another model. A digest-bound scope override may reuse a historical set without a second review only when the user truthfully attests that they personally reviewed the underlying recommendation labels; an instruction to use a set does not convert model-generated labels into ground truth. Bind any valid override to the prepared-set and source-shadow digests, keep `gate_labels_included: false`, retain `RECOMMENDATION_ONLY_LABELS`, and clear only `SPLIT_LABEL_REVIEW_REQUIRED`. Never infer gate truth, lower qualification thresholds, rerun a provider when the existing trace is sufficient, or describe a diagnostic as promotion-eligible.
- Use Codex subagents for independent URL batches when that improves latency. All subagents share the workspace, so reserve unique report numbers first and keep tracker writes in per-worker TSV files until merge.
- Never invoke the legacy `claude -p` batch runner from Codex. Use Codex subagents and the existing mode contract instead.
- Do not generate a resume PDF. Record whether the user should submit the SDE or MLE resume.
- Draft cover letters, application answers, or external messages only when the user explicitly asks. Never send or submit them.
- For current facts, liveness, compensation, laws, or company information, verify with the appropriate live source before relying on them.

## Finish

For a workspace-changing run, follow the changelog and status-maintenance rules referenced by the legacy memory index. Validate in proportion to the change, using `npm test`, `npm run verify`, and dashboard tests when relevant. Report what changed without committing or pushing.
