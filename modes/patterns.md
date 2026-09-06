# Mode: patterns -- Rejection Pattern Detector

> **Data-dir note:** `data/` and `reports/` paths here resolve under `$CAREER_OPS_DATA_DIR`, default `ft/` (the live FT funnel): `data/applications.md` means `ft/data/applications.md`, `reports/` and `reports/_misc/` mean `ft/reports/...`. `analyze-patterns.mjs` resolves these via `lib/paths.mjs`. (`portals.yml`, `config/profile.yml`, and `modes/_profile.md` are NOT resolver-relative; they always live at the repo root.)

## Purpose

Analyze all tracked applications to find patterns in outcomes and surface actionable insights. Identifies what's working (archetypes, remote policies, score ranges) and what's wasting time (geo-restricted roles, stack mismatches, low-score applications).

## Inputs

- `data/applications.md` — Application tracker
- `reports/` — Individual evaluation reports
- `config/profile.yml` — User profile (for recommendation context)
- `modes/_profile.md` — User archetypes and framing
- `portals.yml` — Portal config (for filter update recommendations)

## Minimum Threshold

Before running analysis, check: does `data/applications.md` have at least 5 entries with status beyond "Evaluated" (i.e., Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP)?

If not, tell the user:
> "Not enough data yet -- {N}/5 applications have progressed beyond evaluation. Keep applying and come back when you have more outcomes to analyze."

Exit gracefully.

## Step 1 — Run Analysis Script

Execute:

```bash
node analyze-patterns.mjs
```

Parse the JSON output. It contains:

| Key | Contents |
|-----|----------|
| `metadata` | Total entries, date range, analysis date, counts by outcome |
| `funnel` | Count per status stage (evaluated, applied, interview, offer, etc.) |
| `scoreComparison` | Avg/min/max score per outcome group (positive, negative, self_filtered, pending) |
| `archetypeBreakdown` | Per-archetype: total, positive, negative, self_filtered, conversion rate |
| `blockerAnalysis` | Most frequent hard blockers: geo-restriction, stack-mismatch, seniority, onsite |
| `remotePolicy` | Per-policy bucket: total, positive, negative, conversion rate |
| `companySizeBreakdown` | Per-size bucket: startup, scaleup, enterprise |
| `scoreThreshold` | Recommended minimum score + reasoning |
| `techStackGaps` | Most frequent tech gaps in negative outcomes |
| `recommendations` | Top 5 actionable items with reasoning and impact level |

If the script returns `error`, display the error message and exit.

## Step 2 — Generate Report

Write the report to `reports/_misc/pattern-analysis-{YYYY-MM-DD}.md` (cross-cutting; not tied to a single company).

### Report Structure

```markdown
# Pattern Analysis -- {YYYY-MM-DD}

**Applications analyzed:** {total}
**Date range:** {from} to {to}
**Outcomes:** {positive} positive, {negative} negative, {self_filtered} self-filtered, {pending} pending

---

## Conversion Funnel

Show each status with count and percentage of total. Use a simple table:

| Stage | Count | % |
|-------|-------|---|
| Evaluated | X | X% |
| Applied | X | X% |
| ... | | |

## Score vs Outcome

| Outcome | Avg Score | Min | Max | Count |
|---------|-----------|-----|-----|-------|
| Positive | X.X/5 | X.X | X.X | X |
| Negative | ... | | | |
| Self-filtered | ... | | | |
| Pending | ... | | | |

## Archetype Performance

Table with each archetype, total applications, positive outcomes, conversion rate.
Highlight the best-performing archetype and the worst.

## Top Blockers

Frequency table of recurring hard blockers (geo-restriction, stack-mismatch, etc.).
Note the percentage of all applications affected by each.

## Remote Policy Patterns

Table showing conversion rate by remote policy bucket (global, regional, geo-restricted, hybrid/onsite).

## Tech Stack Gaps

List of most common missing skills in negative/self-filtered outcomes with frequency.

## Recommended Score Threshold

State the data-driven minimum score and reasoning.

## Recommendations

Number the top recommendations (from the script output). For each:
1. **[IMPACT]** Action to take
   Reasoning behind the recommendation.
```

## Step 3 — Present Summary

Show the user a condensed version with:
1. One-line stat summary (X applications, Y% applied, Z% positive outcome)
2. Top 3 findings (most impactful patterns)
3. Link to full report

Example:
> **Pattern Analysis Complete** (24 applications, Apr 7-8)
>
> Key findings:
> - Geo-restricted roles are 0% conversion (7 of 24) -- stop evaluating US/Canada-only postings
> - Regional/global remote roles convert at 57-67% -- these are your sweet spot
> - No positive outcomes below 4.2/5 -- consider this your score floor
>
> Full report: `reports/pattern-analysis-2026-04-08.md`

## Step 3.5 — Mine Resolved Applications (qualitative pass)

`analyze-patterns.mjs` counts outcomes; it cannot read what people said. This step reads the applications that actually **resolved** (Interview / Offer / Rejected after contact) and mines the two things that only resolved applications can teach.

Run it only when at least **3 applications have resolved past the Applied stage**. Below that, say so and skip: 2 data points produce confident nonsense.

### 3.5a — Calibrate scoring against what actually converted

For each resolved application, read the evaluation report and the archived posting (`reports/{company-slug}/{NN}-{role-slug}-jd.md`, written at apply time). Then ask:

- **Where did the A-F score disagree with reality?** A 4.6 that never got a reply and a 3.8 that reached final round are both calibration signals. Name the block that was wrong (usually Block B match or Block D cultural signals), not just the total.
- **What did the converting postings have in common** that the scoring rubric does not currently reward? Compare their archived JD text against the non-converting ones.
- **Which stated requirements turned out not to matter?** Interviews reveal that a "required" skill was decorative far more reliably than the JD does.

Report these as calibration proposals for `modes/_profile.md`. Do **not** edit `_shared.md` (it is auto-updatable and would be overwritten), and do not silently change the rubric — propose, let the user decide.

### 3.5b — Mine interview feedback for STAR+R candidates

Every completed interview round generates story material that is worth more than any invented example, because it already survived contact with a real interviewer. From the tracker Notes, `data/follow-ups.md`, and whatever the user recalls, extract:

- **Questions that were actually asked**, verbatim where remembered. These outrank Glassdoor threads as a source for the next `interview-prep` run.
- **Answers that landed**, and answers that did not. A question the user fumbled is the highest-value story to build next.
- **Gaps the interviewer probed** — the requirement they pushed on tells you where the profile reads thin, regardless of what the JD emphasised.

For each item worth keeping, propose a STAR+R story per `templates/star-plus-r-framework.md` (the forced Reflection step is non-negotiable) and offer to append it to `interview-prep/story-bank.md`.

**Hard rules for this step:**
- Every story is built from facts already in `cv.md`, the master resume, or the archived materials, arranged into S/T/A/R+R. Arranging facts is allowed; adding facts is fabrication.
- Feedback is recorded as the user reports it. Never smooth it, never guess what the interviewer meant.
- Ask the user for the feedback rather than inferring it from an outcome. "Rejected after round 2" is not feedback.

## Step 4 — Offer to Apply Recommendations

Ask the user if they want to act on any recommendations:

> "Want me to apply any of these recommendations? I can:
> - Update `portals.yml` to filter out geo-restricted roles
> - Set a score threshold in `_profile.md` for PDF generation
> - Adjust archetype targeting based on what's converting
> - Append the STAR+R stories mined in Step 3.5b to `interview-prep/story-bank.md`
> - Record the scoring-calibration notes from Step 3.5a in `modes/_profile.md`
>
> Just say which ones, or 'all' to apply everything."

If the user agrees:
- For portal filter changes: edit `portals.yml`
- For profile/archetype changes: edit `modes/_profile.md` (NEVER `_shared.md`)
- For score threshold: add to `config/profile.yml` under a `patterns` key

## Outcome Classification

For reference, outcomes are classified as:

| Status | Outcome |
|--------|---------|
| Interview, Offer, Responded, Applied | **Positive** (invested effort or got traction) |
| Rejected | **Negative** (company said no) |
| Rejected-at-eval, Purged, Discarded | **Not a signal** (never applied: our own screen, a dead posting, or the user's call) |
| SKIP, NO APLICAR | **Self-filtered** (user decided not to apply) |
| Evaluated | **Pending** (no action taken yet) |
