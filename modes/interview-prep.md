# Mode: interview-prep — Company-Specific Interview Intelligence

When the user asks to prep for an interview at a specific company+role, or when an evaluation scores 4.0+ and the user updates status to `Interview`, run this mode.

> **Data-dir note:** `reports/` here resolves under `$CAREER_OPS_DATA_DIR`, default `ft/` (so `reports/` means `ft/reports/`). `interview-prep/` (story-bank + output files), `templates/`, `cv.md`, and `config/` are NOT resolver-relative; they always live at the repo root.

## Inputs

1. **Company name** and **role title** (required)
2. **Evaluation report** in `reports/` (if exists) — read for archetype, gaps, matched proof points
3. **Story bank** at `interview-prep/story-bank.md` — read for existing prepared stories
4. **STAR+R framework** at `templates/star-plus-r-framework.md` — canonical scaffold for behavioral answers; the forced Reflection step is non-negotiable
5. **CV** at `cv.md` + `article-digest.md` — read for proof points
6. **Profile** at `config/profile.yml` + `modes/_profile.md` — read for candidate context

## Step 1 — Research

Run these WebSearch queries. Extract structured data, not summaries. Cite sources for every claim.

| Query | What to extract |
|-------|-----------------|
| `"{company} {role} interview questions site:glassdoor.com"` | Actual questions asked, difficulty rating, experience rating, process timeline, number of rounds, offer/reject ratio |
| `"{company} interview process site:teamblind.com"` | Candid process descriptions, recent data points, comp negotiation details, hiring bar |
| `"{company} {role} interview site:leetcode.com/discuss"` | Specific coding/technical problems, system design topics, round structure |
| `"{company} engineering blog"` | Tech stack, values, what they publish about, technical priorities |
| `"{company} interview process {role}"` (general) | Fills gaps from above — blog posts, YouTube, prep guides, candidate write-ups |

If the company is small or obscure and yields few results, broaden: search for the role archetype at similar-stage companies, and note that intel is sparse.

**Interviewer-angle mapping.** When interviewer names are known (from the tracker Notes, the scheduling email, or the user), look up their public professional profile and note the angle each is likely to probe. Do not speculate beyond public information, and do not put personal details in the prep doc.

| Who | What they are usually probing | What to bring |
|-----|-------------------------------|---------------|
| Recruiter / HR screen | CV timeline, motivation, logistics, comp range | A clean 90-second narrative and a consistent timeline |
| Hiring manager | Team fit, ownership, "why us", how you handle ambiguity | The "why this company" answer built on verified hooks |
| Senior / staff engineer | Technical depth on ONE thing you claimed | The deepest project on the submitted resume, defensible three questions down |
| Cross-functional peer | Communication, collaboration, how you explain your work | A STAR+R story about working across a boundary |
| Executive / final round | Judgment, values, long-term intent | Questions that show you evaluated THEM |

**Do NOT fabricate questions.** If a source says "they asked about distributed systems," report that. Do not invent a specific distributed systems question. When generating likely questions from JD analysis, label them clearly as `[inferred from JD]` not sourced from candidates.

## Step 2 — Process Overview

```markdown
## Process Overview
- **Rounds:** {N} rounds, ~{X} days end-to-end
- **Format:** {e.g., recruiter screen → technical phone → take-home → onsite (4 rounds) → hiring manager}
- **Difficulty:** {X}/5 (Glassdoor avg, N reviews)
- **Positive experience rate:** {X}%
- **Known quirks:** {e.g., "pair programming instead of whiteboard", "no LeetCode, all practical", "take-home is 4 hours"}
- **Sources:** {links}
```

If data is insufficient for any field, write "unknown — not enough data" rather than guessing.

## Step 3 — Round-by-Round Breakdown

For each round discovered in research:

```markdown
### Round {N}: {Type}
- **Duration:** {X} min
- **Conducted by:** {peer / manager / skip-level / recruiter — if known}
- **What they evaluate:** {specific skills or traits}
- **Reported questions:**
  - {question} — [source: Glassdoor 2026-Q1]
  - {question} — [source: Blind]
- **How to prepare:** {1-2 concrete actions}
```

If round structure is unknown, state that and provide the best available intel on what types of rounds to expect based on company size, stage, and role level.

## Step 4 — Likely Questions

**Source priority (highest first).** Research is not the top source once a process is underway:

1. **Recorded feedback from earlier rounds** — anything an interviewer flagged, doubted, or left unresolved WILL come back in the next round. Read the tracker Notes and `data/follow-ups.md` for this application, and ask the user directly what came up in rounds already completed. This outranks every Glassdoor thread.
2. **The evaluation report's gaps** (Block B/E) — the requirements where the CV is weakest are the likeliest probes. Each gets an honest bridge answer: acknowledge the gap, connect the nearest adjacent experience, name the learning path. **Never prepare an answer that invents experience** — that is CLAUDE.md's no-fabrication rule applied to speech instead of paper.
3. **Sourced research** from Step 1 (labeled with its source).
4. **The JD's stated requirements**, competency by competency (labeled `[inferred from JD]`).
5. **The stage type** — screens probe motivation and timeline; technical rounds probe the stack; final rounds probe values, comp, and "any reservations".


Categorize all discovered and inferred questions:

### Technical
Questions about system design, coding, architecture, domain knowledge.
For each: the question, source, and what a strong answer looks like for this candidate specifically (reference CV proof points).

### Behavioral
Questions about leadership, conflict, collaboration, failure.
For each: the question, source, and which story from `story-bank.md` maps best.

### Role-Specific
Questions tied to the specific job description (archetype-aware).
For each: the question, why they're likely asking it (what JD requirement it maps to), and the candidate's best angle.

### Background Red Flags
Questions the interviewer will probably ask about gaps, transitions, or unusual elements in the candidate's background. Read `_profile.md` and `cv.md` to identify what might raise questions.
For each: the likely question, why it comes up, and a recommended framing (honest, specific, forward-looking — never defensive).

## Step 4.5 — Consistency Brief

The interviewer has read the resume that was actually submitted, and the cover letter if one was sent. That is the contract for the conversation:

> **No claim in the room that isn't on the paper, and every claim on the paper defensible in depth.**

Build a short list of the specific claims the submitted materials make that this interviewer is most likely to probe:

1. Read the tracker Notes for which resume was submitted (`Submit SDE resume` / `Submit MLE resume`) and read that resume's content from `cv.md` plus the master resume (see CLAUDE.md for its location outside the repo). The SDE and MLE PDFs carry **different bullet sets** — prepping against the wrong one is how a candidate gets asked about a bullet they cannot see. `node verify-resume-ats.mjs` prints the exact text layer of each PDF if you need to confirm what a given bullet actually says.
2. Read the cover letter, if the Notes carry a `CL:` pointer.
2b. Read the archived posting at `reports/{company-slug}/{NN}-{role-slug}-jd.md` (written at apply time by `modes/apply.md`). This is the exact text the candidate applied against — prefer it over refetching the URL, which by interview time has often expired. If no archive exists, say so plainly rather than reconstructing the posting from the evaluation report's summary.
3. List the metrics, technologies, and outcomes claimed — each with the answer to "and how exactly did you do that?" one level deeper than the bullet.
4. Flag any claim the user cannot currently defend in depth. That is the highest-value prep item on the page, above any Glassdoor question.


## Step 5 — Story Bank Mapping

| # | Likely question/topic | Best story from story-bank.md | Fit | Gap? |
|---|----------------------|-------------------------------|-----|------|
| 1 | ... | [Story Title] | strong/partial/none | |

- **strong**: story directly answers the question
- **partial**: story is adjacent, needs reframing
- **none**: no existing story — flag for the user

For each gap, suggest: "You need a story about {topic}. Consider: {specific experience from cv.md that could become a STAR+R story}."

If the user wants to draft missing stories, help them build STAR+R format and append to `interview-prep/story-bank.md`.

## Step 6 — Technical Prep Checklist

Based on what the company actually tests, not generic advice:

```markdown
- [ ] {topic} — why: "{evidence from research}"
- [ ] {topic} — why: "{their blog/product suggests this matters}"
- [ ] {topic} — why: "{asked in N/M recent Glassdoor reviews}"
```

Prioritize by frequency and relevance to the role. Max 10 items.

## Step 7 — Company Signals

Things to say, do, and avoid based on research:

- **Values they screen for:** name them, cite source (careers page, blog, Glassdoor reviews)
- **Vocabulary to use:** terms the company uses internally — shows homework (e.g., Stripe says "increase the GDP of the internet", Anthropic says "safety" not "alignment")
- **Things to avoid:** specific anti-patterns flagged in interview reviews
- **Questions to ask them:** 2-3 sharp questions that demonstrate you've researched the company, tied to recent news or blog posts discovered in Step 1

## Output

Save the full report to `interview-prep/{company-slug}-{role-slug}.md` with this header:

```markdown
# Interview Intel: {Company} — {Role}

**Report:** {link to evaluation report if exists, or "N/A"}
**Researched:** {YYYY-MM-DD}
**Sources:** {N} Glassdoor reviews, {N} Blind posts, {N} other
```

## Post-Research

After delivering the report:

1. Ask the user if they want to draft stories for any gaps found in Step 5
2. If they have a scheduled interview date, note it: "Your interview is in {X} days. Want me to set a reminder to review this prep?"
3. Suggest running `deep` mode if the company research in Step 1 was thin — deep mode covers strategy, culture, and competitive landscape in more depth

## Rules

- **NEVER invent interview questions and attribute them to sources.** Inferred questions must be labeled `[inferred from JD]`.
- **NEVER coach a claim beyond the submitted documents.** Prep must be consistent with the resume and cover letter the interviewer read (Step 4.5). Gaps get bridge answers, never invented experience.
- **Verify before use.** Every company specific that lands in the prep pack must be independently confirmed. An unverified "fact" delivered confidently in an interview is worse than no fact at all.
- **NEVER fabricate Glassdoor ratings or statistics.** If the data isn't there, say so.
- **Cite everything.** Every question, every stat, every claim gets a source or an `[inferred]` tag.
- Generate in the language of the JD (EN default).
- Be direct. This is a working prep document, not a pep talk.
