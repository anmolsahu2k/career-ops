# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates).

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

| File | Purpose |
|------|---------|
| `AGENTS.md` | Codex entry point for this personalized workspace |
| `CAREER_OPS.md` | Provider-neutral rules and authorization contract for this workspace |
| `CLAUDE.md` | Shared legacy-named rules contract and compatibility sentinel |
| `LEGACY_CLAUDE_CONTEXT.md` | Preserved on-demand historical context from the pre-runtime Claude contract |
| `.agents/skills/career-ops/*` | Repository-local Codex workflow router |
| `.codex/config.toml` | Ignored, machine-local Codex tool configuration copied from `.codex/config.example.toml` |
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, targets, comp range |
| `modes/_profile.md` | Your archetypes, narrative, negotiation scripts |
| `article-digest.md` | Your proof points from portfolio |
| `interview-prep/story-bank.md` | Your accumulated STAR+R stories |
| `portals.yml` | Your customized company list |
| `data/applications.md` | Your application tracker |
| `data/scan-history.tsv` | Your scan history |
| `data/scan-results-{date}.tsv` | Transient scanner output (consumed inline by skill workflow; deleted after eval pass — Anmol's workspace, no triage state) |
| `data/follow-ups.md` | Your follow-up history |
| `.career-ops-runtime/*` | Local decisions, journals, receipts, quota observations, and failure retention under the selected data root |
| `writing-samples/*` | Your personal writing samples for style calibration |
| `reports/*` | Your evaluation reports |
| `output/*` | Legacy generated artifacts (CV PDF generation is disabled in this workspace) |
| `jds/*` | Your saved job descriptions |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/offer.md` | Evaluation mode instructions |
| `modes/pdf.md` | Resume review and maintained-PDF selection instructions |
| `modes/scan.md` | Portal scanner instructions |
| `modes/batch.md` | Batch processing instructions |
| `modes/apply.md` | Application assistant instructions |
| `modes/auto-pipeline.md` | Auto-pipeline instructions |
| `modes/contact.md` | LinkedIn outreach instructions |
| `modes/deep.md` | Research prompt instructions |
| `modes/offers.md` | Comparison instructions |
| `modes/project.md` | Project evaluation instructions |
| `modes/tracker.md` | Tracker instructions |
| `modes/training.md` | Training evaluation instructions |
| `modes/patterns.md` | Pattern analysis instructions |
| `modes/followup.md` | Follow-up cadence instructions |
| `modes/de/*` | German language modes |
| `modes/fr/*` | French language modes |
| `modes/ja/*` | Japanese language modes |
| `modes/pt/*` | Portuguese language modes |
| `modes/ru/*` | Russian language modes |
| `*.mjs` | Utility scripts |
| `bin/career-ops.mjs` | Provider-neutral runtime command entry point |
| `lib/runtime/*` | Contracts, policy, routing, adapters, and transactions |
| `schemas/runtime/*` | Versioned runtime interchange schemas |
| `config/runtime.example.yml` | Disabled-by-default runtime configuration template |
| `.codex/config.example.toml`, `.mcp.example.json` | Credential-free tool configuration templates |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | Base templates |
| `fonts/*` | Self-hosted fonts |
| `.claude/skills/*` | Skill definitions |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a file is in the System Layer, it can be safely replaced with the latest version from the upstream repo.**
