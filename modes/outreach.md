# mode: outreach

Draft cold-outreach to founders / hiring managers at companies **already in the pipeline**, across two channels: **email** (staged as a Gmail draft) and **LinkedIn** (a connection note + post-connect DM you paste in). Drafts-only: nothing here sends anything (CLAUDE.md "Send alumni or faculty messages: drafts only; user sends"). No schedules, no auto-send.

## Two lead sources (both feed the same drafter)

1. **Pipeline leads** (`outreach-leads.mjs` → `data/outreach-leads.json`) — one lead per company already in [data/applications.md](../data/applications.md) that cleared the evaluation-score floor, excluding terminal statuses (Rejected / Rejected-at-eval / Purged / Discarded / SKIP / Offer). A reinforcement play on companies Anmol is already evaluating or applied to.
2. **Hiring-post leads** (`outreach-post-lead.mjs` → `data/outreach-post-leads.json`) — a person who publicly posted "we're hiring". **These are the warmest leads available**: the poster is a named human explicitly inviting contact, so the drafter opens by referencing their post instead of pitching cold. Post leads are drafted first.

**They live in separate files on purpose.** `outreach-leads.mjs` regenerates `outreach-leads.json` from the tracker on every run; anything captured by hand there would be wiped. `outreach-draft.mjs` reads both files and concatenates them.

## Data-dir routing (read BEFORE running)

`outreach-leads.mjs`, `outreach-post-lead.mjs`, `outreach-draft.mjs`, `linkedin-hiring-searches.mjs`, and `fit-score.mjs` resolve paths via `CAREER_OPS_DATA_DIR`. Paths written as `data/...` below live under that root: **`ft/` by default** (the live FT funnel), the repo root (frozen intern archive) when `CAREER_OPS_DATA_DIR=.`. Run the commands as written for the FT cycle; the archive has no active outreach need.

If the FT pipeline has no scored rows yet, `outreach-leads.mjs` emits `[]`. That is expected, not a bug; post leads still draft fine on their own.

## Content rules (baked into the drafter, restated here)

- **No visa / OPT / H-1B / sponsorship line** (Rule 3). The drafter never emits one; do not add one when staging.
- **No em-dashes or en-dashes** (Rule 1). The drafter guards this and sanitizes company/role names sourced from the tracker.
- **No proactive availability phrase** ([[feedback_no_availability_phrases]]). Positioning only ("CMU MISM-BIDA, Dec 2026"), never "Available January 2027" unless the recipient asks.
- **Proof points are authored from [cv.md](../cv.md).** Review the drafts before sending.
- **Resume attachment** (Rule 8, email only): attach the **MLE PDF** for `ai-ml` / `data` archetypes, the **SDE PDF** for `backend` / `infra` / `fde`. The email body says "I have attached my resume", so the attachment must actually go on when staging. LinkedIn connection notes carry no attachment (offer the resume in the follow-up DM instead).

## Prerequisites

Gmail draft staging requires the `gmail-personal` MCP to be connected to Codex (same setup as [gmail-sweep](gmail-sweep.md)). Verify with `/mcp` or **Settings > MCP servers**. If it is unavailable, write and review the draft artifacts but do not claim they were staged. This mode never sends the message.

## Workflow (user-triggered)

### 1. Build leads from the pipeline

```bash
node outreach-leads.mjs              # write data/outreach-leads.json (one lead/company, >= 4.0)
node outreach-leads.mjs --dry-run    # preview top companies + counts, no write
node outreach-leads.mjs --min-score 4.5   # raise the evaluation floor
```

Each lead is `{ id, company, role, score, to: null, all_guesses: [] }`. The `score` is the tracker's own `N.N/5` evaluation grade (the `offer`-mode evaluation that read the full JD against the CV), not a keyword heuristic. The floor defaults to **4.0** — outreach is only worth the effort on roles that already cleared a strong evaluation. Rows with no numeric score (`N/A`, blank) are skipped.

### 1b. Capture LinkedIn hiring posts (optional, highest-yield)

**Why not an API:** LinkedIn's official Developer API exposes no post/content search (Posts API only creates posts and reads ones you own), so there is nothing sanctioned to call. Plain web search is also weak here: search engines index LinkedIn's `/jobs/` SEO pages heavily and individual `/posts/` sparsely, so a Google-style sweep returns mostly job-board pages. What works is driving LinkedIn's OWN search UI, which is just browsing (no scraping, no ToS exposure, no account risk).

Generate tuned content-search URLs, then capture the good posts:

```bash
node linkedin-hiring-searches.mjs                   # all archetypes, past week
node linkedin-hiring-searches.mjs --since past-24h  # past-24h | past-week | past-month
node linkedin-hiring-searches.mjs --role ai-ml      # backend|ai-ml|data|fde|sponsorship|general
```

That writes a clickable `data/linkedin-hiring-searches.md`. Open a search, skim for **real posts** (skip the job-board pages), then record a poster:

```bash
node outreach-post-lead.mjs --company "Acme" --role "Software Engineer, New Grad" \
  --name "Jane Doe" --profile https://www.linkedin.com/in/janedoe/ \
  --post https://www.linkedin.com/posts/janedoe_hiring-activity-123 \
  [--to jane@acme.com] [--hook "one line on why this company"]

node outreach-post-lead.mjs --list    # show captured post leads
```

The drafter then opens with "Saw your post about the {role} opening at {company}" and carries `post_url` through, so you can also comment on the thread (often better than a DM: public, and the poster gets notified).

### 2. Add contacts

The pipeline gives companies + roles but not people. Attach a contact by writing these fields onto the lead in `data/outreach-leads.json`, then re-run the drafter:

- `contact_name` — the person's name (the drafter greets by first name instead of `{name}`)
- `contact_title` — their role (e.g. "Talent Strategist", "Founder & CTO")
- `linkedin_profile` — their profile URL (surfaces in the draft as `linkedin.profile_url`)
- `to` — their email if one is found; clear `all_guesses` once a real address is set
- `enrichment_confidence` (`verified`/`high`/`medium`/`low`/`none`/`stale-lead`) + `enrichment_note` (record the SOURCE here)

These are preserved across rebuilds: `outreach-leads.mjs` carries a `PRESERVED` field list (including all of the above plus `hook`, `custom_subject`, `custom_body`) from the existing file onto the tracker-refresh, and hard-exits rather than overwrite if it cannot parse the existing file. It prints `Preserved enrichment on N existing lead(s)`. (This exists because a plain rebuild once wiped the whole enrichment layer; see CHANGELOG 2026-07-20.)

### Enrichment sources, best first

**0. What is already on disk (ALWAYS check first, before any search).** Leads are keyed by **company, not tracker row**, so an existing lead for one req at a company covers every other req at that company. Before spending a single WebSearch call, read all four:

```bash
python3 -c "import json;[print(json.dumps(l,indent=2)) for l in json.load(open('ft/data/outreach-leads.json')) if 'ACME' in l['company'].lower()]"
ls ft/data/outreach-ready/ | grep -i acme          # already-rendered drafts
grep -i -A15 '^## ACME' ft/data/cmu-alumni-referrals.md   # CareerShift alumni sweep
grep -ril acme ft/reports/*/                       # prior outreach packs for this company
```

Skipping this is the known failure mode, not a hypothetical: on 2026-07-27, outreach for row 140 (Akuna Capital) was drafted from scratch via WebSearch while `outreach-leads.json` already carried the identical three recruiters and `cmu-alumni-referrals.md` already carried **11** CareerShift alumni. The rebuild found 4 of the 11, mislabeled two titles, and missed **Quincy Hughes, Junior Quantitative Developer**, the exact-title peer and the single best target on the list. Search-snippet enrichment is strictly worse than the unlocked CareerShift record already sitting on disk.

**Also read [contact.md](contact.md) as a message-format reference only.** It is the older LinkedIn-only mode: a 3-sentence framework and a 300-char cap, with no lead pipeline, no CareerShift step, and no memory of prior enrichment. Any request phrased as "outreach for {row}" belongs in **this** mode; borrow contact.md's message skeleton if useful, but do the target-finding here.

1. **CareerShift (primary, `verified`):** Anmol has a CMU-licensed CareerShift account (ZoomInfo-backed contact database). This is the highest-confidence source: it returns real recruiter / founder names, titles, and direct email addresses, not guesses. It is auth-walled, so the flow is: **Anmol logs in**, then the skill drives it with Playwright (`schoolAttended=Carnegie+Mellon` + company also surfaces CMU alumni for referral angles, see `ft/data/cmu-alumni-referrals.md`).

   **Drive it with the project-scoped `playwright` MCP server (`mcp__playwright__*`), not an isolated plugin browser.** The isolated server keeps its profile only in memory, so login state disappears when it stops. Copy [.mcp.example.json](../.mcp.example.json) to the ignored `.mcp.json`; it uses a persistent profile below `$HOME/.career-ops/browser-profile`. When both servers are connected, select the project-scoped server explicitly.

   **Sign in at `https://app.careershift.com/signin/cmu`** (the CMU SSO entry point). Not `careershift.com/Account/Login`, which is the generic member login and will not carry the CMU license. A live session lands on `/dashboard`; if the sign-in form renders instead, the session has expired and only Anmol can restore it. Tick **"Keep me logged in"**, and tick DUO's **"Remember me for 30 days"** on the 2FA prompt, so the next run does not need him. Contact search is driven entirely by URL params, no form typing needed:

   - `https://app.careershift.com/contacts/search?companyName=<Company>&jobTitle=<title>` (e.g. `jobTitle=recruiter`, `jobTitle=data%20science`)
   - `https://app.careershift.com/contacts/search?companyName=<Company>&schoolAttended=Carnegie%20Mellon`

   Every result card is masked with **placeholder data** until unlocked: the email reads `email@example.com` and the bio reads "Senior Software Engineer at TechCorp Inc". That is a paywall skeleton, not the record. Click the contact, then click the `a[href="#unlock"]` link to reveal the real email, location, tenure, and education. **Never transcribe an un-unlocked card**, or you will write TechCorp into a lead. **Correction to the 2026-07-20 note in `ft/data/cmu-alumni-referrals.md`:** CMU alumni records *do* carry work email addresses; the earlier "no emails on record" conclusion came from reading masked cards. Contacts sourced here get `enrichment_confidence: verified`, a real `to`, cleared `all_guesses`, and an `enrichment_note` that names CareerShift + the date. **The two queries are independent: a `companyName` contact miss does NOT mean the alumni query is empty.** `companyName=X&jobTitle=recruiter` and `companyName=X&schoolAttended=Carnegie%20Mellon` hit different slices of the database and must both be run. Akuna is the proof: zero contact hits, **11 CMU alumni**. Treat a contact no-match as "no cold email address here, go find the alumni," never as "CareerShift has nothing on this company."

   **Sweep record, 2026-07-20** (do not re-query these blind; check `cmu-alumni-referrals.md` first, and re-run only if the record is stale for your purpose):
   - Contacts, 9 verified emails: Palantir, Eulerity, Built, NewsBreak, Optiver, Northslope, Unum, Pylon, WHOOP.
   - Contacts, no match: Notion, StubHub, **Akuna**, Waymark, NCR Voyix.
   - Alumni, results written to [ft/data/cmu-alumni-referrals.md](../ft/data/cmu-alumni-referrals.md): Quora (6), **Akuna Capital (11)**, Notion (6), Scopely (~10), and the rest of the no-email set. LinkedIn referral list, not an email list.
2. **Agent WebSearch (fallback, `medium`/`low`):** when CareerShift has no match, WebSearch a hiring contact (recruiter / talent / hiring manager / founder), same idea as [contact](contact.md). Lower confidence: search can return a wrong handle, a stale role, or a dead company (a "Definitive Intelligence" lead is actually Groq post-2024 acquisition). No email usually, so LinkedIn is the channel.
3. **Manual** — Anmol drops in a `to` / profile he already has.

**Always eyeball enrichment before messaging**, including CareerShift hits: a ZoomInfo record can be stale on role or address. Confidence tiers rank the shortlist; they are not a guarantee.

### 3. Render drafts (both channels)

```bash
node outreach-draft.mjs              # render every lead to data/outreach-ready/{id}.json
node outreach-draft.mjs --limit 10   # cap this run
node outreach-draft.mjs --dry-run    # print one sample draft (email + LinkedIn), write nothing
```

Each ready file is `{ id, company, to, role, archetype, subject, htmlBody, linkedin: { connect, dm, search_url }, drafted_at }`. `archetype` is inferred from the role title (`ai-ml` / `data` / `backend` / `fde` / `infra`, else a strong-all-rounder default) and selects the three email proof bullets + the one-line LinkedIn proof.

### 4a. Email: stage into Gmail as drafts (the skill does this; no auto-send)

For each `data/outreach-ready/*.json`, create a Gmail draft via the gmail MCP so Anmol can review and send from his own inbox:

- Tool: `mcp__gmail-personal__draft_email`
- `to`: the file's `to` (skip / flag files still at `null` so Anmol can add the address in Gmail)
- `subject`: the file's `subject`
- body: the file's `htmlBody` (HTML)
- **attachment**: the correct resume PDF per the archetype rule above

This creates a Gmail *draft* only. Anmol opens the draft, confirms the recipient + attachment, and hits send. **Never call a send tool here.**

### 4b. LinkedIn: find the person, then copy-paste (no automation)

The pipeline gives the company, not a person, so each draft carries a `search_url` instead of a fixed profile link:

1. `linkedin.search_url` — open it. It is a LinkedIn people search for that company filtered to recruiter / hiring-manager / talent / founder titles. Pick the right person; their profile is that person's URL to message.
2. `linkedin.connect` — click **Connect > Add a note** on their profile and paste it (kept under LinkedIn's 300-char cap). Replace `{name}` with their first name.
3. `linkedin.dm` — send as a **message after they accept**. Replace `{name}`; offer the resume here since connection notes carry no attachment.

**No auto-connect / auto-message.** LinkedIn is manual and drafts-only by construction, for three reasons that all point the same way: (1) the **official LinkedIn Developer API cannot send connection requests or cold DMs** at all (no invite endpoint; messaging is gated to approved Recruiter/Sales-Navigator partners) so there is nothing sanctioned to wire; (2) the only things that *can* auto-send are third-party automation tools that drive the account, which violate LinkedIn's User Agreement and risk restricting the account Anmol needs; (3) LinkedIn exposes no URL param to pre-fill a connection note anyway. Confirmed 2026-07-17: Anmol's LinkedIn access is the official Developer app (post-to-own-feed + auth only), which does not enable outreach sending.

**Optional - pin a named person:** to replace the search with a specific contact + address, enrich the lead (CareerShift first, then WebSearch) per "Enrichment sources, best first" in step 2, which writes `to` / `contact_name` / `linkedin_profile` onto the lead. Agent work, not the zero-token script, and eyeball the result before use.

After Anmol confirms a batch is sent (either channel), move the staged files to a `data/outreach-sent/` folder (or delete) so they are not re-staged.

## Deferred (not ported from email-outreach)

LLM-personalized drafting (OpenRouter), SMTP deliverability verification, HN-thread lead scraping, suppression lists, and the automated Resend/Gmail sender were intentionally left out. Revisit only if the drafts-only flow proves it needs them.
