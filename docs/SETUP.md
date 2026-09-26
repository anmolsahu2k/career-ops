# Setup Guide

Codex is the primary agent for this workspace. Antigravity CLI (`agy`) is the
subscription-backed Google and partner-model review surface. Claude Code,
Gemini CLI, and OpenCode files remain only as compatibility adapters.

## Prerequisites

- ChatGPT desktop with Codex, the Codex IDE extension, or a working Codex CLI
- Node.js 18+
- Playwright Chromium for liveness checks and job-page verification
- Go 1.21+ only for the optional dashboard

## Install

```bash
npm ci
npx playwright install chromium
```

`requirements-discovery.txt` installs JobSpy from GitHub `main` (preferred over
PyPI so LinkedIn and other scraper fixes land before the next package bump).
Install those optional Python adapters only when you use them; on macOS, use a
virtual environment rather than installing packages into the system Python.

For a MacBook setup and safe Windows/macOS syncing, follow the [multi-machine guide](MULTI_MACHINE.md). Cloning upstream `main` will not include this workspace's changes.

## Configure

This checkout has local personal files that are excluded from Git. For a fresh setup, start from the examples:

```bash
cp config/profile.example.yml config/profile.yml
cp templates/portals.example.yml portals.yml
```

Add your maintained CV as `cv.md`, then run `npm run doctor` to check the local
setup.

Maintain these inputs:

- `config/profile.yml`: identity, target roles, constraints, and preferences
- `cv.md`: source-of-truth career content used for evaluation
- `modes/_profile.md`: role archetypes and proof-point mapping
- `portals.yml`: configured discovery sources

The user maintains the actual SDE and MLE resume PDFs outside this repository. Career-Ops selects the correct resume for a role but never generates or rebuilds a CV PDF.

## Use with Codex

Open this repository in the ChatGPT desktop app or IDE. Codex automatically reads `AGENTS.md` and discovers `.agents/skills/career-ops/SKILL.md`.

To enable the project-scoped Playwright MCP, copy `.codex/config.example.toml` to `.codex/config.toml`, then trust the repository when prompted. The local file is ignored so credentials and machine-specific settings cannot enter version control. Gmail connections require separate account authorization and are not imported from repo files.

```text
$career-ops
$career-ops scan
npm run scan:all
npm run evaluate
$career-ops tracker
$career-ops offer <job URL>
$career-ops <job URL or pasted JD>
```

`npm run scan:all` is discovery-only (every active source, no evaluation). Use
`$career-ops scan` when you also want the agent-driven inline evaluation pass.

### Manual workflow (save agent tokens)

To run the funnel without a Codex/Claude session, use the CLI path documented in
[SCRIPTS.md](SCRIPTS.md#manual-workflow-no-agent):

```powershell
npm run scan:all
npm run evaluate -- --max 25
npm run evaluate -- `
  --config config/runtime.local.yml `
  --provider antigravity-gemini-flash-high `
  --acknowledge-quota `
  --apply
npm run verify
```

Only step three spends provider quota. Discovery, plan mode, liveness, and
verify are zero-LLM.

Natural-language requests can also select the skill implicitly. See [CODEX.md](CODEX.md) for routing details and the optional Claude Code import flow.

## Data Paths

The default data root is `ft/`, the live full-time and new-grad funnel. Root `data/` and `reports/` are the frozen intern archive. Set `CAREER_OPS_DATA_DIR=.` only for an explicitly requested archive operation.

## Verify

```bash
npm test
npm run verify
(cd dashboard && go test ./...)
```

## Build the Optional Dashboard

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ../ft
# ./career-dashboard --path ..   # read-only intern archive
```
