# Career-Ops for Codex

Read [CAREER_OPS.md](CAREER_OPS.md) once as the provider-neutral rules and authorization contract. Do not preload the longer legacy `CLAUDE.md` unless a selected mode explicitly needs historical detail absent from the canonical contract.

For a Career-Ops workflow, use [.agents/skills/career-ops/SKILL.md](.agents/skills/career-ops/SKILL.md) and load only the mode files it routes to. Read `STATUS.md` only for current funnel state. For runtime implementation, load only `docs/RUNTIME.md`, the relevant schema, and the module being changed.

Preserve the dirty worktree and gitignored personal data. The `.claude/`, `.gemini/`, and `.opencode/` integrations are compatibility adapters, not separate pipelines.
