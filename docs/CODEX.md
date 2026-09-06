# Codex Setup

Career-Ops is configured for Codex through two repository files:

- `AGENTS.md` is the automatically discovered project entry point.
- `.agents/skills/career-ops/SKILL.md` is the native `$career-ops` workflow router.
- `.codex/config.example.toml` is the credential-free project configuration template.

`CLAUDE.md` remains the shared rules contract because existing scripts and compatibility adapters depend on that path. Its filename is historical; its rules apply to Codex.

## Prerequisites

- ChatGPT desktop with Codex, the Codex CLI, or the Codex IDE extension
- Node.js 18+
- Playwright Chromium for liveness checks and job-page verification
- Go 1.21+ only if you use the TUI dashboard

## Install

```bash
npm install
npx playwright install chromium
npm run doctor
```

Open this repository in Codex. Codex discovers `AGENTS.md` and the repo skill automatically. If a newly added skill is not visible, restart Codex.

Copy `.codex/config.example.toml` to the ignored `.codex/config.toml` when you want project-scoped Playwright. Other clients can copy `.mcp.example.json` to the ignored `.mcp.json`. Both local files may contain machine-specific settings and must stay untracked.

## Invoke Career-Ops

Codex skills use `$` mentions rather than the Claude slash-command syntax:

```text
$career-ops
$career-ops scan
$career-ops tracker
$career-ops offer <job URL>
$career-ops <job URL or pasted JD>
```

Natural-language requests also work because the skill supports implicit selection:

- `Evaluate this job URL and run the full Career-Ops pipeline.`
- `Scan my configured sources for matching new-grad roles.`
- `Show the current application tracker summary.`

The old `/career-ops` spelling remains in Claude, Gemini, and OpenCode compatibility files. Use `$career-ops` in Codex.

## Routing

| User intent | Shared mode files |
|---|---|
| Raw JD text or job URL | `modes/_shared.md` + `modes/auto-pipeline.md` |
| Single evaluation | `modes/_shared.md` + `modes/offer.md` |
| Multiple roles | `modes/_shared.md` + `modes/offers.md` |
| Portal and source scan | `modes/_shared.md` + `modes/scan.md` |
| Live application help | `modes/_shared.md` + `modes/apply.md` |
| Batch evaluation | `modes/_shared.md` + `modes/batch.md` |
| Contact research and draft | `modes/_shared.md` + `modes/contact.md` |
| Tracker, research, training, project, follow-up, or interview prep | Matching file under `modes/` |

The live full-time funnel is under `ft/`. Root `data/` and `reports/` are the frozen intern archive. The default resolver already selects `ft`; use `CAREER_OPS_DATA_DIR=.` only for an explicitly requested archive operation.

## Workspace Rules That Matter Most

- Every evaluation produces the full Block A-G report and a 9-column tracker addition.
- The user supplies their own SDE and MLE resume PDFs. Career-Ops selects one but never generates a CV PDF.
- Cover letters and application-question files are created only on explicit request.
- Scans are user-triggered, never scheduled, and must pass the liveness gate before evaluation.
- Tracker additions go through per-worker TSV files and `merge-tracker.mjs`, never direct ad hoc row edits.
- Codex may use parallel subagents, but workers must reserve unique report numbers before writing shared artifacts.
- Codex never submits an application, sends a message, pushes a commit, or changes the tracker schema without explicit authorization.

## Claude Code Import

Importing old chats or personal Claude settings is optional. In the ChatGPT desktop app, use **Settings > Import**. In Codex CLI, run `/import` and choose Claude Code. The repository itself does not require import because its instructions and skill are checked in. See the [official import guide](https://learn.chatgpt.com/docs/import).

Claude's Gmail MCP registrations are not migrated by repository files. The direct Python `gmail-sweep` uses the existing OAuth credential files and does not require MCP. Reconnect Gmail separately only for MCP-backed interactive work or draft staging. Do not copy OAuth secrets into tracked Codex configuration.

## Verification

```bash
npm test
npm run verify
(cd dashboard && go test ./...)
```

Run `node test-all.mjs` when changing cross-runtime system files or the dashboard build.
