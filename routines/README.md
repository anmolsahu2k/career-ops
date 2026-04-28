# Career-Ops Routines

Three Claude Code Routines that replace the local system cron from Phase 3 of `HANDOFF-now-phase-execution.md`. Routines run on Anthropic's cloud — no laptop-on requirement. Min interval is 1 hour; weekly is fine.

## Files in this directory

| File | Replaces | Schedule (target) |
|---|---|---|
| `daily-scan.md` | W1 system cron | Daily at 7am ET (= 11:00 UTC EDT or 12:00 UTC EST; pick one and accept the DST drift) |
| `weekly-news.md` | W8 system cron + LLM fill (combined into one routine) | Weekly Sunday 6pm ET |
| `daily-hygiene.md` | W9 system cron | Daily at 8am ET |

Each `.md` is a paste-ready prompt body for the routine's `message` field. The routine's `git_repository` should point at this repo so it can clone, run wrappers, and commit outputs back.

## Setup checklist

Before any routine fires:

1. **Pick a private GitHub repo URL.** Likely `https://github.com/anmolsahu2k/career-ops` (private). Add as remote: `git remote set-url origin <url>` (or `git remote add user <url>` keeping santifer as upstream).
2. **Decide what to commit.** Edit `.gitignore` if you want routines to see/update `data/applications.md`, `cv.md`, `reports/`, etc. Default `.gitignore` excludes all of those.
3. **First push.** `git push -u origin main` (or `master`).
4. **Connect or skip MCP.** Routines run with no MCP unless you configure connectors at https://claude.ai/customize/connectors. None of these three routines need connectors.
5. **Create routines.** Either:
   - Web UI at https://claude.ai/code/routines: paste the prompt from each `.md` file, set the cron, point at your repo.
   - From a Claude Code session, ask Claude to invoke `RemoteTrigger` with the body shape from the `schedule` skill.

## After routines are live

- Each routine creates a `claude/<branch-name>` branch on each run with its outputs committed there. Merge to main weekly (or auto-merge via a GitHub Action if you trust it).
- Logs visible at https://claude.ai/code/routines per-run.
- Each run consumes your daily routine cap.

## Uninstalling

To pause: set `enabled: false` on each routine via web UI or RemoteTrigger update. To delete: web UI only (https://claude.ai/code/routines).
