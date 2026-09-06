# Mode: tracker — Application Tracker

Reads and displays `ft/data/applications.md` (path resolves under `$CAREER_OPS_DATA_DIR`, default `ft/`; `.` = frozen intern archive at the root).

**Tracker schema (9 columns, do NOT change):**
```markdown
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
```

Possible statuses (canonical, see `templates/states.yml`): `Evaluated` → `Applied` → `Responded` → `Interview` → `Offer` / `Rejected` / `Rejected-at-eval` / `Purged` / `Discarded` / `SKIP` (legacy Spanish forms like `Evaluada` survive only as parse aliases; never write them)

**The three closed-without-applying buckets are not interchangeable (decided 2026-08-12).** Write the one that matches who made the call:

| Status | Who decided | Written by |
|---|---|---|
| `Rejected-at-eval` | an eval agent, on the merits (no sponsorship, ITAR, level mismatch, comp below floor, off-target title) | eval agents, `prune-by-liveness.py` clearance branch |
| `Purged` | nobody: the posting died or the row sat past its shelf life | `hygiene-sweep.mjs`, dashboard `--expire-days`, `prune-by-liveness.py` expired branch |
| `Discarded` | **the user**, by hand, with the dashboard `d` key | the user only |

Never write `Discarded` from a script or an agent. It is the one bucket that means "Anmol decided against this", and filling it with machine output is what made it useless before the split.

- `Applied` = the candidate submitted their application
- `Responded` = A recruiter/company reached out and the candidate replied (inbound)

If the user asks to update a status, edit the corresponding row.

Also show statistics:
- Total applications
- By status
- Average score
- % with PDF generated
- % with report generated
