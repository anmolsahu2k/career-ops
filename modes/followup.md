# Mode: followup -- Follow-up Cadence Tracker

> **Data-dir note:** All `data/` and `reports/` paths here resolve under `$CAREER_OPS_DATA_DIR`, default `ft/` (the live FT funnel). `data/applications.md` means `ft/data/applications.md`, `data/follow-ups.md` means `ft/data/follow-ups.md`, `reports/` means `ft/reports/`. `followup-cadence.mjs` resolves these via `lib/paths.mjs`.

## Purpose

Track follow-up cadence for active applications. Flag overdue follow-ups, extract contacts from notes, and generate tailored follow-up email/LinkedIn drafts using report context.

## Inputs

- `data/applications.md` — Application tracker
- `data/follow-ups.md` — Follow-up history (created on first use)
- `reports/` — Evaluation reports (for context in drafts)
- `config/profile.yml` — User profile (name, identity)
- `cv.md` — CV for proof points in drafts

## Step 1 — Run Cadence Script

Execute:

```bash
node followup-cadence.mjs
```

Parse the JSON output. It contains:

| Key | Contents |
|-----|----------|
| `metadata` | Analysis date, total tracked, actionable count, overdue/urgent/cold/waiting counts |
| `entries` | Per-application: company, role, status, days since application, follow-up count, urgency, next follow-up date, extracted contacts, report path |
| `cadenceConfig` | Cadence rules (applied: 7 days, responded: 3 days, interview: 1 day) |

If no actionable entries, tell the user:
> "No active applications to follow up on. Apply to some roles first with `/career-ops` and come back when they're aging."

## Step 2 — Display Dashboard

Show a cadence dashboard sorted by urgency (urgent > overdue > waiting > cold):

```
Follow-up Cadence Dashboard — {date}
{N} applications tracked, {N} actionable

| # | Company | Role | Status | Days | Follow-ups | Next | Urgency | Contact |
```

Use visual indicators:
- **URGENT** — respond within 24 hours (company replied)
- **OVERDUE** — follow-up is past due
- **waiting (X days)** — on track, follow-up scheduled
- **COLD** — 2+ follow-ups sent, suggest closing

## Step 3 — Generate Follow-up Drafts

For each **overdue** or **urgent** entry only:

1. Read the linked report (`reportPath` from JSON) for company context
2. Read `cv.md` for proof points
3. Read `config/profile.yml` for candidate name and identity

### Email Follow-up Framework (first follow-up, followupCount == 0)

Generate a 3-4 sentence email:

1. **Sentence 1:** Reference the specific role + when you applied. Be specific — mention the company name and role title.
2. **Sentence 2:** One concrete value-add from the report's Block B match or a proof point from cv.md. Quantify if possible.
3. **Sentence 3:** Soft ask + availability. Offer a specific time window ("this week" or "next Tuesday").
4. **Sentence 4 (optional):** Brief mention of a relevant recent project or achievement.

**Rules:**
- **NO NEW CLAIMS (hard rule).** Every substantive statement must trace to something already submitted: the application itself, the resume PDF that was sent (`Submit SDE resume` / `Submit MLE resume` in the tracker Notes), the cover letter if one exists, or `cv.md`. A follow-up is a fabrication vector precisely because it feels like small talk. A skill, metric, or project that was not in the submitted materials does not appear here.
- **Target 60-120 words** for the body (the 150-word ceiling below is a hard cap, not the goal). Short reads as confident; long reads as anxious.
- Professional but warm, NOT desperate
- **NEVER** use "just checking in", "just following up", "touching base", or "circling back"
- Lead with value, not with the ask
- Reference something specific to THAT company (from report Block A)
- Keep under 150 words
- Include a subject line
- Use the candidate's name from `config/profile.yml`

**Example tone:**
> Subject: Re: Senior PHP/Laravel Developer — IxDF
>
> Hi [contact name or "team"],
>
> I submitted my application for the Senior PHP/Laravel Developer role on April 7th. I wanted to share that my production Laravel app (Barbeiro.app — 120 models, 315 API endpoints, full test suite) closely mirrors the TDD-driven culture described in the posting.
>
> I'd love to discuss how my 15 years of PHP experience and hands-on AI tooling workflow could contribute to IxDF's platform. Would any time this week work for a brief conversation?
>
> Best,
> [Name]

### LinkedIn Follow-up (if no email contact found)

Reuse the contact framework: 3 sentences, 300 character max.
- Hook specific to company → proof point → soft ask
- Suggest the user run `/career-ops contact {company}` to find the right person first

### Second Follow-up (followupCount == 1)

Shorter than first (2-3 sentences). Take a **new angle**:
- Share a relevant insight, article, or project update
- Don't repeat the first follow-up's content
- Still reference the role specifically

### Cold Application (followupCount >= 2)

Do NOT generate another follow-up. Instead suggest:
> "This application has had {N} follow-ups with no response. Consider:
> - Updating status to `Discarded` if the role seems filled
> - Trying a different contact via `/career-ops contact`
> - Keeping in `Applied` status but deprioritizing"

## Source Discipline (applies to every draft in this mode)

Follow-ups, thank-you notes, and nudges are candidate-facing text the user will send under their own name. They inherit every hard rule in `CLAUDE.md` and `modes/_shared.md`, and add one of their own:

1. **No new claims.** See the rule above. Before sending a draft, name (to yourself) the submitted artifact each claim came from. If a claim has no source, cut it. The archived posting at `reports/{company-slug}/{NN}-{role-slug}-jd.md` (written at apply time) is the reference for what the role actually asked for; the report's Block B match is the reference for what was offered against it.
2. **No visa, OPT, H-1B, or sponsorship content** (CLAUDE.md Rule 3). If asked about start date, "Available January 2027." Nothing more.
3. **No em-dashes or en-dashes** (CLAUDE.md Rule 1). Run the scrub pass before presenting.
4. **No internal jargon** — no `on_site`, `remote_us`, archetype names, block letters, or scores leak into a message.
5. **Draft only, never send.** This mode produces text for the user. It never emails, messages, or submits. It must not be wired to a tool that does.
6. **Maximum two follow-ups per application.** After the second silence, the honest move is recording the outcome, not persistence. See the Cold Application branch above.

## Thank-You Notes (triggered by recording an interview stage)

The trigger is **recording the stage, not scanning for one**. The moment an application's status moves to `Interview` (or a new round is logged), offer in the same turn:

> "Want a short thank-you note for the interviewer? Sending one within 24 hours is standard practice."

If accepted, draft it under this mode's Source Discipline rules, with one addition: a thank-you note may reference **what was discussed in the interview**, which the user supplies. Ask what came up rather than inventing it. Keep it to 60-100 words: thanks, one specific thing from the conversation, one sentence of continued interest. Log it in `data/follow-ups.md` with Channel `Email` and a note naming the round, so the cadence math stays correct.

## Step 4 — Present Drafts

For each draft, show:

```
## Follow-up: {Company} — {Role} (#{num})

**To:** {email or "No contact found — run `/career-ops contact` first"}
**Subject:** {subject line}
**Days since application:** {N}
**Follow-ups sent:** {N}
**Channel:** Email / LinkedIn

{draft text}
```

## Step 5 — Record Follow-ups

After the user reviews and says they've sent a follow-up, record it:

1. If `data/follow-ups.md` doesn't exist, create it:
   ```markdown
   # Follow-up History

   | # | App# | Date | Company | Role | Channel | Contact | Notes |
   |---|------|------|---------|------|---------|---------|-------|
   ```

2. Append a row with:
   - `#` = next sequential number in the follow-ups table
   - `App#` = application number from tracker
   - `Date` = today's date
   - `Company` = company name
   - `Role` = role title
   - `Channel` = Email / LinkedIn / Other
   - `Contact` = who it was sent to
   - `Notes` = brief note (e.g., "First follow-up, referenced Barbeiro.app")

3. Optionally update the Notes column in `data/applications.md` with "Follow-up {N} sent {YYYY-MM-DD}"

**IMPORTANT:** Only record follow-ups the user confirms they actually sent. Never record a draft as sent.

## Step 6 — Summary

After showing all drafts, summarize:

> **Follow-up Dashboard** ({date})
> - {N} applications being tracked
> - {N} overdue — drafts generated above
> - {N} urgent — respond today
> - {N} waiting — next follow-up dates shown
> - {N} cold — consider closing
>
> Review the drafts above and tell me which ones you've sent so I can record them.

## Cadence Rules Reference

| Status | First follow-up | Subsequent | Max attempts |
|--------|----------------|------------|-------------|
| Applied | 7 days after application | Every 7 days | 2 (then mark cold) |
| Responded | 1 day (urgent reply) | Every 3 days | No limit |
| Interview | 1 day after (thank-you) | Every 3 days | No limit |

These defaults can be overridden via `node followup-cadence.mjs --applied-days N`.
