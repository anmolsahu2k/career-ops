---
name: career-ops
description: AI job search command center -- evaluate offers, scan portals, track applications (user submits own resume PDFs)
user_invocable: true
args: mode
argument-hint: "[scan | deep | pdf | offer | offers | apply | batch | tracker | contact | training | project | interview-prep | patterns | followup | gmail-sweep | outreach]"
---

# career-ops -- Router

## Mode Routing

Determine the mode from `{{mode}}`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `offer` | `offer` |
| `offers` | `offers` |
| `contact` | `contact` |
| `oferta` / `ofertas` / `contacto` (legacy aliases) | `offer` / `offers` / `contact` |
| `deep` | `deep` |
| `pdf` | `pdf` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `apply` | `apply` |
| `scan` | `scan` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |
| `interview-prep` | `interview-prep` |
| `gmail-sweep` | `gmail-sweep` |
| `outreach` | `outreach` |

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `{{mode}}` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
career-ops -- Command Center

Available commands:
  /career-ops {JD}      → AUTO-PIPELINE: evaluate + report + tracker (paste text or URL; no PDF, user submits own resume)
  /career-ops offer     → Full A-G evaluation of a single posting
  /career-ops offers    → Compare and rank multiple offers
  /career-ops contact   → LinkedIn power move: find contacts + draft message
  /career-ops deep      → Deep research prompt about company
  /career-ops pdf       → CV formatting reference (PDF generation disabled; user submits own resume PDFs)
  /career-ops training  → Evaluate course/cert against North Star
  /career-ops project   → Evaluate portfolio project idea
  /career-ops tracker   → Application status overview
  /career-ops apply     → Live application assistant (reads form + generates answers)
  /career-ops scan      → Scan portals (default: also evaluate inline; pass `scan-only` to stop after scan)
  /career-ops batch     → Batch processing with parallel workers
  /career-ops patterns  → Analyze rejection patterns and improve targeting
  /career-ops followup  → Follow-up cadence tracker: flag overdue, generate drafts
  /career-ops interview-prep → Company-specific interview intelligence
  /career-ops gmail-sweep → Sweep both Gmail accounts: add applications, flip rejections
  /career-ops outreach  → Draft cold emails to pipeline-company founders/HMs, stage as Gmail drafts (you send)

Paste a JD directly to run the full auto-pipeline.

NOTE (Anmol's workspace): scan and evaluation can run together OR separately.
Paths below live under $CAREER_OPS_DATA_DIR (default ft/; see modes/_shared.md).
Default `/career-ops scan` does scrape + filter + per-URL eval in a single
invocation and deletes ft/data/scan-results-{date}.tsv before returning. With
`scan-only` it stops after scan and leaves the TSV on disk for a follow-up
invocation to consume. Any new /career-ops invocation MUST first check for
pre-existing ft/data/scan-results-*.tsv files and resume evaluation against them
before doing anything else. Pasting URLs to /career-ops triggers auto-pipeline
on each immediately (no scan step).
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `offer`, `offers`, `pdf`, `contact`, `apply`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`, `patterns`, `followup`, `interview-prep`, `gmail-sweep`

### Modes delegated to subagent:
For `scan` and `apply` (with Playwright): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt. (`scan` agents in default mode must complete the inline evaluation pass before returning, with no leftover candidates in `ft/data/scan-results-{date}.tsv`. Before dispatching any eval agent, the `scan` agent MUST run the mandatory liveness gate (modes/scan.md step 12c) over the surviving URLs and drop every URL classified `expired`; this gate cannot be skipped. In `scan-only` mode, the agent stops after the title-level filter, reports row counts, and leaves the TSV on disk for a follow-up invocation.)

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="career-ops {mode}"
)
```

Execute the instructions from the loaded mode file.
