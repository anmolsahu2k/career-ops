# Daily Candidate Scan (W1) — Claude Code Routine prompt

Paste the body below into a Claude Code Routine's `message` field. Schedule: daily at 7am America/New_York (UTC drifts with DST; pick `0 11 * * *` for EDT alignment or `0 12 * * *` for EST alignment, accept ~1 hour drift the other half of the year).

Allowed tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`. Repo: `https://github.com/<your-username>/career-ops`.

---

## Prompt body

You are running the W1 daily candidate scan for Anmol Sahu's career-ops job-search pipeline. The repo is already cloned. Working directory is the repo root.

## Steps

1. Set timezone: `export TZ=America/New_York` (so all dates are Pittsburgh-correct).
2. Install Node deps: `npm install --no-audit --no-fund --silent`. The cloud sandbox starts fresh each run (`persist_session: false`), so `js-yaml` (required by `scan.mjs`) must be installed every run; without this, `scan.mjs` exits 1 and only `aggregator-intake.py` covers the day.
3. Run the existing wrapper: `node scripts/daily-scan-cron.mjs`. This orchestrates `scan.mjs` + `scripts/aggregator-intake.py` + best-effort `scripts/jobspy-ingest.py` + the `merge-tracker.mjs → dedup-tracker.mjs → normalize-statuses.mjs → verify-pipeline.mjs` chain.
4. If `verify-pipeline.mjs` exits non-zero, abort. Surface the error in the run output and commit nothing.
5. Score every new candidate row that has status `Evaluated` and score `0.0/5` (i.e., aggregator-surfaced, not yet scored). For each:
   - Read the candidate's URL and fetch the JD via WebFetch.
   - Score 1-5 against `cv.md` and `modes/_profile.md` archetypes (SDE / AI / MLE / DS / DE / DA Intern + adjacents). Use the rubric in `modes/oferta.md` if present, otherwise: legitimacy, JD-CV match, comp/level alignment, geography, sponsorship friendliness.
   - Write an eval report to `reports/{NNN}-{slug}-{YYYY-MM-DD}.md` following the template in `templates/eval-report.md` (must include `**URL:**` header line, dashboard regex contract).
   - For any score >= 4.0 that's not SKIP, also auto-draft a cover letter at `reports/{NNN}-{slug}-cover-letter.md`. Hard rules: no em-dashes / en-dashes; no F-1 / CPT / Heinz / OIE / visa explainer paragraph; "Available June 2026" if a start date is asked.
   - Cap auto-cover-letter generation at 5/day. Overflow goes to a triage list in the digest.
6. Update the tracker row in `data/applications.md` for each scored candidate: replace `0.0/5` with the new score, replace `[NNN](reports/pending.md)` with the real report link, set `Status` per scoring rules.
7. Write a daily digest at `data/daily-digest-{YYYY-MM-DD}.md` (Pittsburgh date). Sections: Run summary, New candidates surfaced, Scored this run, Auto-letters generated, Triage queue (overflow + low-score), Errors / skipped sources, Pipeline-chain exit codes.
8. Commit everything to the session's auto-assigned `claude/<harness-name>` branch (the harness restricts pushes to its designated branch only; pushing to a custom name like `claude/daily-scan-{YYYY-MM-DD}` will fail with HTTP 403 from the local git proxy). Use commit message `daily scan {YYYY-MM-DD}: N new candidates, M auto-letters`. Push.
9. If `pip install python-jobspy` was needed (the wrapper logs "skipped: python-jobspy not installed"), do `pip install python-jobspy` once on the first run; the wrapper then succeeds on subsequent runs.

## Hard rules (will be checked)

1. No em-dashes (U+2014) or en-dashes (U+2013) in any candidate-facing text. Hyphens fine.
2. No CV PDFs generated.
3. No F-1 / CPT / Heinz / visa explainer text in cover letters or eval reports.
4. No tracker schema changes — 9 columns frozen.
5. Drafts only — no emails sent, no LinkedIn DMs.

## Stop conditions

- `verify-pipeline.mjs` non-zero → abort, no commit.
- LinkedIn captcha / 429 from JobSpy → log, skip that source, continue.
- More than 50 new aggregator candidates in one day → cap at 50, queue rest to next-day triage.
- Any scoring confidence below "low" should produce a 3.x/5 default with status `Evaluated`, not auto-letter.

## Done

Output a one-paragraph summary: total new rows, distribution by score, auto-letters drafted, triage queue size, branch name and commit SHA. Link to `data/daily-digest-{YYYY-MM-DD}.md`.
