# Recovery

How this workspace's personal data can be lost, and how it gets recovered. This is a tracked doc; the data it describes is not (see the inventory below).

## Rollback is not recovery

Two different things share the word "backup" in this repo. Do not confuse them.

- **Rollback (same disk).** Several scripts write a sibling snapshot before mutating a file: `applications.md.bak` (normalize, dedup), `applications.md.pre-*` (merge passes), `applications.md.backup-<date>` (apply-status-flips, gmail-sweep). These let you undo the last mutation. They live on the SAME disk, right next to the original, so they are worthless against disk loss, `rm -rf`, or a corrupted volume. They are rollback only.
- **Recovery (off disk).** A real recovery copy lives somewhere the original does not: another drive, a cloud bucket, an external backup. Only an off-disk copy survives losing the machine or the working tree.

If you only ever rely on `.bak` / `.pre-*` siblings, you have no disaster recovery. You have an undo button.

## Local-only inventory (what is NOT in git)

Almost all of this workspace's value is gitignored personal data (untracked and scrubbed from git history on 2026-05-20). Losing the working tree loses all of it unless there is an off-disk copy. Two surfaces:

### In-repo, gitignored (under this repo root)

Derive the current list at any time:

```bash
git ls-files --others --ignored --exclude-standard
```

As of this writing that covers: `cv.md`, `portals.yml`, `config/profile.yml`, `data/` (intern archive), `ft/data/` and `ft/reports/` (live FT funnel), `reports/` (intern archive), `resumes/`, `interview-prep/`, `prep/`, `housing/`, `portfolio/`, `faculty_emails/`, `STATUS.md`, `CHANGELOG.md`, `INDEX.md`, and `modes/_profile.md`. (`config/profile.example.yml` stays tracked; it is a template, not personal data.)

### Out of repo (elsewhere on the machine)

These never live under the repo and will not show up in the command above:

- `~/.gmail-mcp/personal-credentials.json`, `~/.gmail-mcp/cmu-credentials.json`, `~/.gmail-mcp/gcp-oauth.keys.json` (Gmail OAuth tokens + shared client; see [docs/gmail-mcp-setup.md](gmail-mcp-setup.md)).
- `.env` (repo root; secret values, gitignored).
- `.claude/settings.local.json` (local permissions + env block, gitignored).
- `~/.claude/projects/-Users-anmolsahu2k-Stuff-Create-career-ops/memory/` (auto-memory dir: MEMORY.md index + the per-topic memory files).

No secret values are recorded here on purpose. This file lists paths and key names only; the values live in the files above.

## Canonical recovery path

The intended recovery mechanism is a user-triggered `backup.mjs` (`/career-ops backup`), which copies the in-repo gitignored set plus the out-of-repo surface to an off-disk location on demand (user-triggered, per CLAUDE.md Rule 6: no schedules). Run it before risky operations and after meaningful state changes. Until it exists, copy the two surfaces above off disk manually.

## Gmail token re-auth

The Gmail OAuth refresh tokens expire every 7 days because the GCP app is in Testing status. When a sweep fails with `invalid_grant`, re-run the auth step once per account (the shared `gcp-oauth.keys.json` is not re-downloaded):

```bash
GMAIL_CREDENTIALS_PATH=<path-to-account-credentials.json> \
  npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

See [docs/gmail-mcp-setup.md](gmail-mcp-setup.md) for the full setup and the per-account credential paths.
