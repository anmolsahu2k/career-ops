# mode: gmail-sweep

Sweep Anmol's two Gmail accounts and reconcile findings against `data/applications.md`.

- **anmolsahu2k@gmail.com** (personal) — used on most external application portals; receives confirmation + rejection emails directly from ATSes (Workday, Lever, Greenhouse, Ashby, etc.)
- **anmolsah@andrew.cmu.edu** (CMU) — used on Handshake; receives Handshake "✅ You applied to" confirmation emails

Three sub-sweeps:
1. **personal-apps** — confirmation emails on personal → add unseen rows as `Applied`
2. **personal-rejections** — rejection emails on personal → flip matching tracker rows to `Rejected` (or backfill as `Rejected` if no matching row)
3. **cmu-handshake** — Handshake confirmation emails on CMU → add unseen rows as `Applied` with `[Handshake]` prefix in Notes

## Prerequisites

Gmail MCP must be registered for both accounts. One-time setup (already done 2026-06-05 — verify with `claude mcp list`):
- `gmail-personal` → `~/.gmail-mcp/personal-credentials.json`
- `gmail-cmu` → `~/.gmail-mcp/cmu-credentials.json`
- Shared OAuth client at `~/.gmail-mcp/gcp-oauth.keys.json`

If MCP servers aren't connected, follow setup steps at [docs/gmail-mcp-setup.md](docs/gmail-mcp-setup.md) (Cloud Console OAuth client + `npx @gongrzhe/server-gmail-autoauth-mcp auth` twice with `GMAIL_CREDENTIALS_PATH` per account).

## Workflow (user-triggered, no schedules)

### 1. Fetch

Ask user for the `since` date (default: last sweep date + 1 day, or `2025-07-01` for first run). Then run all three sweeps in parallel:

```bash
python3 scripts/gmail-sweep.py --mode personal-apps --account personal --since {since}
python3 scripts/gmail-sweep.py --mode personal-rejections --account personal --since {since}
python3 scripts/gmail-sweep.py --mode cmu-handshake --account cmu --since {since}
```

Each writes a JSON dump to `data/gmail-sweeps/<mode>-<today>.json`. Bypasses Gmail MCP layer by reading the OAuth tokens directly with `google-api-python-client`, which is faster and works without an MCP-aware session restart.

### 2. Split into agent batches

```bash
python3 scripts/split-sweep-batches.py
```

Splits each mode's JSON into chunks of ~45 emails (target: 8-12 batches total across all modes). Writes a manifest at `data/gmail-sweeps/manifest-<today>.json`.

### 3. Dispatch parallel parser agents

For EACH batch in the manifest, dispatch a `general-purpose` Agent with the input/output file paths and the per-mode classification prompt (see `prompts/` block below). Run all batches in one parallel message — they share no state.

Each agent:
- Reads its assigned batch JSON
- Classifies every email as `APPLIED_CONFIRMATION` / `REJECTION` / `NEITHER`
- Extracts `company`, `role`, `date_iso`, `rejection_reason` (rejections only), `confidence`, `reason`
- Writes one-line summary as its return value
- Writes parsed JSON to `data/gmail-sweeps/parsed/<batch-id>.json`

### 4. Aggregate + bucket + emit TSVs

```bash
node scripts/gmail-sweep-merge.mjs
```

Loads all parsed JSONs, dedupes by `msg_id`, buckets by `(normalized_company, fuzzy_role)`, resolves final state per bucket (REJECTION trumps APPLIED_CONFIRMATION), matches against `data/applications.md`, and writes:
- `batch/tracker-additions/gmail-<source>-<today>.tsv` — new rows (multi-row TSV)
- `batch/status-flips/gmail-rejections-<today>.tsv` — proposed flips for existing rows
- `data/gmail-sweeps/merge-report-<today>.json` — full diagnostic (additions, flips, no-op-skipped, etc.)

Print summary; show user the diagnostic for review.

### 5. Apply

#### a. Status flips (existing tracker rows)

```bash
node scripts/apply-status-flips.mjs            # dry-run
node scripts/apply-status-flips.mjs --apply    # commit
```

Edits `data/applications.md` in place. Makes a `.backup-<today>` copy first. Dedupes by `tracker_row` — if multiple rejection emails target the same row, latest `rejection_date` wins.

#### b. Additions (new tracker rows)

merge-tracker.mjs only consumes single-row TSVs, so split the multi-row TSVs first:

```bash
node scripts/split-tsv-for-merge.mjs    # produces N single-row TSVs
node merge-tracker.mjs                  # ingests them, runs its own fuzzy dedup
```

### 6. Verify

```bash
node verify-pipeline.mjs
```

Confirm 0 errors. If errors point to malformed rows (e.g. a stray `|` in role title broke the markdown row), fix by hand.

### 7. Append CHANGELOG entry

Per `feedback_changelog_per_turn.md`, write a CHANGELOG.md entry capturing the sweep counts.

## Per-mode classification prompts

### personal-apps

> You are parsing one batch of job-application confirmation emails. Classify each as `APPLIED_CONFIRMATION` (real "we received your application" from an ATS like Workday, Lever, Greenhouse, Ashby, iCIMS, Smartrecruiters) or `NEITHER` (newsletter, password reset, job suggestion). Per email, extract `company` (canonical, no Inc./LLC), `role` (full title as written), `date_iso` (YYYY-MM-DD from Date header), `confidence`, `reason`. Watch for the Workday edge case: **"Thank you for Applying to {COMPANY}"** is sometimes used as a REJECTION subject — if the body explicitly says "decided not to move forward" or "not moving forward", classify as REJECTION (it'll get re-classified during aggregation).

### personal-rejections

> You are parsing one batch of emails that may be rejections. Query is permissive (caught anything with "application" AND a rejection keyword), so many are false positives — confirmations often contain "Unfortunately, we cannot respond to every applicant individually". Classify each as `REJECTION` (actually informs candidate they're no longer being considered), `APPLIED_CONFIRMATION` (false positive — a receipt that incidentally contained the keyword), or `NEITHER`. For rejections, also extract a short `rejection_reason` quote ("decided to move forward with other candidates", "no longer being considered", etc.).

### cmu-handshake

> Handshake-sent emails on CMU account. Real application confirmations: subject starts with **`✅ You applied to {COMPANY}`** OR **`Application sent to {COMPANY}`**; body contains **`Your application was sent to`** or **`You successfully applied to`**. Anything else (job suggestions "New X at Y", saved-search digests, profile reminders, weekly roundups) is `NEITHER`. For confirmations, extract `company` (from subject between "to" and ","), `role` (from body's structured listing: company → industry → role title → compensation → mode → location).

## Edge cases captured during 2026-06-05 first run

- **Workday "Thank you for Applying" used as rejection subject.** Adobe (and likely other Workday tenants) reuse the same subject template for rejection emails. The aggregator's REJECTION-trumps-APPLIED_CONFIRMATION resolution handles this when both classifications exist for the same `msg_id`.
- **Markdown-table corruption from pipes in role titles.** Two rows had `|` in role text (location appended after a separator). **Fixed 2026-06-05:** `merge-tracker.mjs` now runs every interpolated cell through `sanitizeCell()` (replaces `|` → `/`, flattens tabs/newlines) at both row-writers, and a `rowIsValid()` guard warns+skips any row that still doesn't split into exactly 9 fields. The fix lives at the row-construction chokepoint, so it covers every source (scan agents, aggregator, gmail-sweep), not just this sweep. No longer needs hand-fixing.
- **AI/ML abbreviation expansion over-matches.** `roleFuzzyMatch` expands `ai` → `artificial intelligence`, which can collapse 3 different AI intern tracks at the same company into one "already in tracker" no-op. Diagnostic file lists every no-op-skipped case for manual review.
- **Carnegie Mellon Heinz internal postings** (Resume Blitz, Coffee Chat sign-ups, Career Services events) get added because they came through Handshake. Not real internships — user may want to manually flip these to `Discarded` after the sweep.
- **Status `N/A`** is not a canonical status — pre-existing rule. New rows must use `Applied` / `Rejected` / `Discarded` etc.

## What this mode does NOT do

- Does not commit to git (per CLAUDE.md hard rules — let user commit).
- Does not write rejection emails or follow-up drafts (use `linkedin-reply-handler` etc. separately).
- Does not delete the source JSON dumps or batch TSVs — they're audit trail. Manual cleanup later via `rm data/gmail-sweeps/*-batch-*` etc.
