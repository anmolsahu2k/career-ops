# Weekly W8 News-Manifest Fill-In

This prompt is invoked by system cron each Sunday at 6:43pm Pittsburgh, ~30min after W8's deterministic system cron writes the manifest at 6:13pm. It does the LLM step that the W8 wrapper can't do (no LLM available inside the .mjs cron).

Working directory: `/Users/anmolsahu2k/Stuff/Create/Amazon/`

## Steps

1. List `career-ops/data/news-tasks-*.md` and pick the most recent file. Read it. (If today is Sunday, today's file should exist; if it's missing, the W8 cron may have failed. Check `career-ops/data/cron-stdout.log` and stop.)
2. For each "needs research" company in the manifest (typically the ~21 Applied companies in the tracker), run the 3 listed search queries via WebSearch in parallel batches of ~5 companies at a time to cap concurrency. For each top hit that is clearly company-relevant and dated within the last 7 days, WebFetch the URL.
3. Write a 2-3 sentence outreach hook in the alumni-outreach.md tone (see `career-ops/templates/alumni-outreach.md`). One hook per company that has news; mark others "no fresh news this week".
4. Update the digest at `career-ops/data/news-digest-{YYYY-Www}.md` (created by W8 as a template) by filling per-company sections with: source URL(s), one-line news summary, the 2-3 sentence hook. Append a "Re-fill on {timestamp}" stanza if the digest already has filled content.
5. Update the aggregate footer: companies queued, companies with news (count), unused-this-week count.

## Hard rules

1. No em-dashes or en-dashes (U+2014, U+2013) in the digest output. Use commas, periods, colons. Hyphens are fine.
2. Drafts only. Do not send hooks anywhere. Do not push commits.
3. Do not include F-1, CPT, Heinz, OIE, or visa explainer text in any hook.
4. Do not fabricate news. If WebSearch returns nothing within 7 days for a company, mark it "no fresh news this week" and move on. Better empty than fake.
5. US news only for US-based companies; India remote roles can use India-press hooks.

## Time-box

Target 30 min wall-clock. If past 60 min, finish what you have and surface the rest in the digest summary.

## When done

Append a one-paragraph summary to `career-ops/data/cron-stdout.log` with: digest path, companies-with-news count, total companies processed, top 3 most actionable hooks. If any news suggests an immediate user action (e.g., a portfolio company just announced a relevant launch), update `career-ops/STATUS.md` "Outstanding user actions" list with that item and the date.
