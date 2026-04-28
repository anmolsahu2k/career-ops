# Weekly Company News (W8) — Claude Code Routine prompt

Combines W8a (deterministic manifest write) + W8b (LLM news fill) into one routine since both can run cloud-side.

Paste the body below into a Claude Code Routine. Schedule: weekly Sunday 6pm America/New_York (cron `0 22 * * 0` for EDT alignment, `0 23 * * 0` for EST alignment; accept ~1 hour drift the other half of the year).

Allowed tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, plus WebSearch and WebFetch (the routine env should expose these by default — confirm in routine config). Repo: `https://github.com/<your-username>/career-ops`.

---

## Prompt body

You are running the W8 weekly company news monitor for Anmol Sahu's career-ops pipeline. Repo is cloned, working directory is the repo root.

## Steps

1. `export TZ=America/New_York`.
2. Run `node scripts/weekly-news-cron.mjs`. This writes a deterministic manifest at `data/news-tasks-{YYYY-Www}.md` and a digest template at `data/news-digest-{YYYY-Www}.md`.
3. Read the just-written manifest. It contains the ~21 `Applied`-status companies with 3 search queries each.
4. For each company, in parallel batches of 5:
   - Run all 3 search queries via WebSearch.
   - For each top hit dated within the last 7 days that's clearly company-relevant, WebFetch the URL.
   - Pick the single strongest news angle: funding round, product launch, leadership hire, engineering blog post, or recent eng-team-relevant announcement.
   - Draft a 2-3 sentence outreach hook in the tone of `templates/alumni-outreach.md`. Voice: warm, specific, not gushing. No em-dashes. No "passionate about" / "leveraged" filler. No F-1 / CPT / Heinz / OIE / visa text.
5. Update `data/news-digest-{YYYY-Www}.md` (the template W8 wrote in step 2) by filling per-company sections: source URL(s), one-line news summary, the 2-3 sentence hook. Mark companies with no fresh news as "no fresh news this week". Update aggregate footer: companies queued / with news / unused.
6. Commit to a `claude/weekly-news-{YYYY-Www}` branch with message `weekly news {YYYY-Www}: N hooks for M companies`. Push.

## Hard rules

1. No em-dashes (U+2014) or en-dashes (U+2013) anywhere in the digest. Hyphens fine.
2. Drafts only — do NOT send any outreach. The user sends DMs manually.
3. Do not fabricate news. If WebSearch returns nothing within 7 days, mark "no fresh news this week" and move on. Better empty than fake.
4. US news for US-based companies; India remote roles can use India-press hooks. Geo from the role's location field.
5. No F-1 / CPT / Heinz / OIE / visa explainer text in any hook.

## Time-box

Target 30 min wall-clock. If past 60 min, finish what you have and summarize the rest.

## Stop conditions

- `weekly-news-cron.mjs` exits non-zero → abort, no commit, surface the error.
- WebSearch / WebFetch hits rate limits → smaller batches, finish what you can.
- A company has news but every source is paywalled / blocked → note "blocked source" in the hook line, leave URL.

## Done

Output: digest path, companies-with-news count, total companies processed, top 3 most actionable hooks (so the user can use them for follow-up touches on silent applications). If any news suggests an immediate user action (e.g., a portfolio company just launched something Anmol applied to work on), call it out at the top.
