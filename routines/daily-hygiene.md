# Daily Tracker Hygiene (W9) — Claude Code Routine prompt

Paste the body below into a Claude Code Routine. Schedule: daily 8am America/New_York (cron `0 12 * * *` for EDT alignment, `0 13 * * *` for EST alignment).

Allowed tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`. Repo: `https://github.com/<your-username>/career-ops`.

---

## Prompt body

You are running the W9 daily tracker hygiene job for Anmol Sahu's career-ops pipeline. Repo is cloned, working directory is the repo root.

## Steps

1. `export TZ=America/New_York`.
2. Run `node scripts/daily-hygiene-cron.mjs`. This chains:
   - `node check-liveness.mjs` for each tracker URL → flags dead postings.
   - `node followup-cadence.mjs --summary` → flags `Applied` rows >7 days silent.
   - Cross-ref previous day's `data/daily-digest-{YYYY-MM-DD}.md` to detect duplicates between W1 surfacing and existing tracker.
   - `node verify-pipeline.mjs` for integrity.
3. The wrapper writes `data/hygiene-{YYYY-MM-DD}.md` summarizing all four sub-steps. Read it.
4. **Do the status writes the wrapper can't do.** check-liveness.mjs only flags; it does NOT auto-mark `Status: Discarded`. You should:
   - Find every URL in the wrapper output that's labeled `expired` AND is the only URL for that tracker row.
   - Update `data/applications.md` to set `Status: Discarded` on those rows. Use only canonical states from `templates/states.yml`. No markdown bold, no dates in the status field.
   - For URLs labeled `uncertain`, leave the status alone and add a one-line note in the hygiene log flagging "needs human verification".
5. Append a "Status updates by routine" section to `data/hygiene-{YYYY-MM-DD}.md` listing what you changed and why.
6. Commit to a `claude/daily-hygiene-{YYYY-MM-DD}` branch with message `daily hygiene {YYYY-MM-DD}: N discarded, M flagged uncertain`. Push.

## Hard rules

1. No em-dashes (U+2014) or en-dashes (U+2013) in any text you write.
2. Status updates use only canonical states from `templates/states.yml`: `Evaluated`, `Applied`, `Responded`, `Interview`, `Offer`, `Rejected`, `Discarded`, `SKIP`.
3. Do not change the 9-column tracker schema.
4. Only flip to `Discarded` if the liveness signal is unambiguous (`expired`, `404`, "this position has been filled" content match). For `uncertain`, leave the row alone.
5. Do not generate cover letters or eval reports. That's W1's job.

## Stop conditions

- `verify-pipeline.mjs` exits non-zero after your status writes → revert the writes (`git checkout data/applications.md`), surface the error.
- `check-liveness.mjs` returns no rows → wrapper bug or empty tracker. Surface and stop.
- More than 5 status flips in one run → cap at 5, queue rest to next day with a note (avoids accidental mass-discard from a transient network blip).

## Done

Output: count of `Discarded` flips, count of `uncertain` flagged, count of follow-ups queued to `data/follow-ups.md`, branch name and commit SHA. Link to `data/hygiene-{YYYY-MM-DD}.md`.
