# Faculty Cold-Email Playbook

Distilled from a corpus the user collected: 5+ YouTube creators, 4 high-engagement Reddit threads (including the 15-yr-old who got Princeton + ASU replies on 5 sends), institutional resources (UNC, OSU, Rice, MIT UROP, Tufts, UVA, UT-Austin, Princeton PCUR, Tulane), GitHub corpora (mak-raiaan/ColdEmailPhDMSc, jakec007, danialebrat/ProfMailer, shaily99/advice, da03 gist), and one direct piece of guidance from a faculty member ("existing proj, PhD-student vibe, GPA, IDL, 2 yrs exp, AI tools, literature reviews, work").

This is the playbook for [Anmol's batch of 12 PIs](../faculty_emails/). Use it for any future faculty outreach.

This file supersedes the prior 4-paragraph / 150-word template (2026-05-03), which had drifted into Claude-tells (em-dashes, parallel structure) and proactive availability phrases that violate `feedback_no_availability_phrases.md`. See CHANGELOG 2026-05-06.

---

## What every source agrees on

### Rules that get the email read

1. **Sound human, not AI.** This is the #1 complaint across every source. The tells faculty pattern-match: em-dashes, semicolon-stitched clauses, parallel structure overload, "the closest framing I've found," "the concrete question I'd love to work on," over-balanced sentences, perfect transitions, hedging adverbs ("genuinely," "particularly"). Write it in one pass, read it aloud, then cut the polish back. If it sounds like a finished essay, rewrite it like a Slack message.
2. **Personalize on a recent paper (1-2 years old).** Older work signals "you didn't read what I do now." Quote a specific finding, method, or limitation, not just the title. Faculty know the difference between name-dropping and engagement.
3. **Three short paragraphs, ~200 words.** Anything longer gets skimmed.
4. **Subject line: purpose + term + level. No your name.** Example: `Summer 2026 RA inquiry — MISM master's, multi-agent + healthcare ML`. Avoid blank subjects, "Hi Professor", or anything generic.
5. **Send Tuesday or Wednesday morning.** Mondays drown in the weekend backlog; Friday afternoon dies in the inbox.
6. **Professional email + signature.** Use `@andrew.cmu.edu`, not gmail. Signature: name, program/year, institution, phone, LinkedIn, project URL if relevant.

### Rules that get the email replied to

7. **Lead with YOU, not them.** Open with your story (what you've shipped, why this field), not "I read your fascinating paper." Faculty want to know what you bring; the paper-engagement comes second.
8. **Be direct. Just ask.** "Would you have an open position in your lab?" beats "I would love to discuss your work." Saves time, signals seriousness, doesn't read like sales.
9. **Ask one specific question about their paper.** Detail-level. Example: not "your retrieval work is interesting" but "in [paper], you used the fact-aware retrieval objective for radiology grounding — would the same loss transfer to claim-sequence-to-NCCN-pathway grounding?" This is the single highest signal of "actually read it" vs "name-dropped."
10. **Referral closer (cited by 4+ sources).** "If you're not taking students this term, is there a postdoc or PhD student in your group you'd recommend I reach out to?" Opens a referral path; faculty are flattered to refer. (The companion "ask for volunteer or course-credit" closer used in earlier drafts has been DROPPED for Anmol's batch — see CHANGELOG 2026-05-06. The user is not taking volunteer or course credit, and proactively naming funding terms reads as either over-eager or as a backdoor F-1 hint, both of which hurt response rate.)
11. **Tiny ask first.** A 10- or 15-minute call to learn about their work, not "an RA position." The position is the close of the call, not the open of the email.
12. **Lead with evidence, calibrate the tone DOWN.** People decide first, rationalize after, but performative excitement *hurts* you when the timing betrays the claim. Anmol is sending this batch on May 6 for a Summer 2026 start — every prof on the list will infer this is a late-cycle outreach, not a first choice. Phrases like "is what I keep coming back to," "I came to CMU specifically to," or "is the closest framing I've found" register as overclaim against that timing. Use matter-of-fact framing: "overlaps with a problem I'm stuck on," "Cloudify exposes but does not solve." Let the project specifics carry the signal; do not editorialize about the paper.

---

## The Ladder Method (high-leverage, optional)

Instead of emailing the PI cold:

1. Email a grad student or postdoc in the lab first. They reply 3-5x more often (they aren't drowning in undergrad pings, and they run the day-to-day).
2. After they reply, ask whether their PI takes master's/PhD-track students or who else in the department to talk to.
3. Email the PI referencing the grad student by name in line 1: "Your PhD student [Name] suggested I reach out about [topic]." This single line raises response rates more than any other tactic. No PI ignores someone vetted by their own team.
4. Close with the tiny ask (15-min call), come prepared with paper-specific questions, pitch the actual position only at the end of the call.

**Cost:** 1-2 weeks of upstream work per lab.
**Verdict for Anmol's batch:** skipped by default for the initial 12 — the labs are pre-researched with specific paper hooks and the time-to-summer is short. **Use as the fallback for any prof who doesn't reply within 7 days:** instead of a follow-up to the PI, ladder via a named grad student in their group.

---

## What NOT to do

- Generic templates / mass-emailing
- AI-detectable prose (em-dashes, semicolon stitches, "I'd love to explore...", over-balanced parallels, "the cleanest framing I've found")
- Glazing the prof's CV ("Your work is fascinating and I deeply admire...")
- Long bios up front (3-line CV summary at most; rest goes in the attachment)
- CC'ing multiple profs or mentioning you're emailing other faculty
- Lying about year, GPA, status, or credentials (kills relationships when discovered)
- Persuading the prof. Skills + paper-fit either land or they don't.
- Sending on weekends or holidays
- Following up before 7 days

---

## The template

```
Subject: Summer 2026 RA inquiry — [your level], [topic in 4-6 words]

Dear Professor [LastName],

[Paragraph 1 — YOU. 2-3 sentences. Story, not bio. How you got into this
field, what you're working on right now, what you've shipped recently. Anchor
in a specific concrete project. Surface IDL coursework + GPA + 2 yrs prior
SDE experience where they fit naturally (the faculty-direct guidance flagged
these as the things to lead with).]

[Paragraph 2 — THEIR PAPER + YOUR QUESTION. 3-4 sentences. Name one specific
recent (1-2 yr) paper. State ONE detailed, paper-specific question that ties
to a problem you've actually hit in your own work. Not abstract — concrete.]

[Paragraph 3 — THE ASK. 2-3 sentences. (1) Direct ask for a 15-min call
this week or next. (2) Referral closer: "If you're not taking students this
term, is there a postdoc or PhD student in [lab/group] you'd recommend I
reach out to?" (3) CV attached, plus an offer to share notebooks /
project artifact if useful. NO funding language — no "volunteer," no
"course credit," no "paid." Do NOT say "Available June 2026" or any other
proactive availability statement (memory feedback_no_availability_phrases.md).]

Thanks for your time,
[Name]
[Program · year · institution]
[phone · @andrew email · LinkedIn · github URL of relevant project]
```

Target word count: **180-230**. Anything over 250 = cut.

---

## Anmol-specific anchors (apply to all 12 in this batch)

- **Story:** 2.5 yrs SDE Byju's → CMU MISM Heinz BIDA → 3 active projects (Highmark cancer-staging XGBoost on 6M+ claims / Cloudify multi-agent OpenAI+Claude / EEG classification CMU 11-685 multi-head CNN+Transformer + CLIP retrieval).
- **Coursework signals to surface where relevant:** IDL (11-485/785), CGPA 3.75. The faculty-direct guidance flagged IDL + GPA + 2 yrs exp + AI-tools fluency + lit-review skill + existing project as the things to lead with.
- **Resume routing:** SDE PDF for agent/systems labs (Neubig, Fried, Welleck, Sap, Bisk); MLE PDF for ML/healthcare labs (Padman, Dubrawski, Lipton, Perer, Beibei Li, Heidari, Xiong).
- **Hard rules to honor:** no em-dashes or en-dashes (Rule 1); no F-1/CPT/Heinz/OIE/sponsorship explainer (Rule 3); no proactive "Available June 2026" / "Available for Summer 2026" (memory `feedback_no_availability_phrases.md`); no funding-term mention, neither "paid" nor "volunteer" nor "course credit" (turn-5 user directive 2026-05-06); drafts only, user sends (CLAUDE.md "What I am NOT to do without explicit ask").
- **Tone:** matter-of-fact, not performative. Late-cycle reality means overclaiming reads as false. Banned phrases: "is what I keep coming back to," "I came to CMU specifically to," "is the closest framing I've found," "fellow [program] student," "to round out the [X] side." Use instead: "overlaps with a problem I'm stuck on," "exposes but does not solve," "I have not figured out / not solved cleanly."

---

## Iteration loop

| Day | Action |
|---|---|
| 0 (Tue/Wed AM) | Send. Add tracker row in [data/applications.md](../data/applications.md) with Status `Outreach`. |
| +7 | No reply → either follow-up email (3-line, "wanted to bump this up — happy to share the Highmark notebooks if useful") OR pivot to laddering via a named grad student in the group. |
| +14 | Still nothing → mark `No-Response` and move on. Don't spam. |
| Reply asking for more | Pivot to scheduling. Bring 3-5 paper-specific questions to the call. Pitch the position at the end, not the open. |
| Post-call | Within 24h, send a 4-line thank-you note that names a specific thing they said + reaffirms the ask. |

---

## Why this works (model)

Faculty receive 50+ emails/day. Mental triage is: spam → student template → maybe interesting → reply.

- Rules 1-6 get past the spam and template filters.
- Rules 7-9 get into "maybe interesting" — they signal you read their work and have your own substance to bring.
- Rules 10-12 lower the cost of replying, which is what actually converts "interesting" into "I'll write back."
- The Ladder is a different vector entirely: it bypasses the cold pile by giving the PI a pre-vetted intro from their own team.

The "100% response rate" framing is aspirational. Realistic for a careful 12-batch is **30-50% reply, 10-20% calls, 5-10% offers**. The 15-yr-old's 2/5 (40%) was an outlier on volume but consistent with the rate.

---

## One-bump follow-up (Day +7, only if no ladder option)

```
Hi Prof. [Last Name],

Bumping this up in case it got buried. I added a short demo of [Cloudify /
the Highmark NCCN encoding pipeline] to the GitHub repo this week — link
below, less than 2 minutes. Happy to send notebooks if useful, or 15 minutes
any time the next two weeks.

Thanks,
Anmol
```

Move on if silent for another 7 days.
