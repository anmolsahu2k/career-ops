# 4364, Handshake | Associate Software Engineer, Operator Experience

**URL:** https://jobs.ashbyhq.com/handshake/fe319ff8-87e1-46d9-b23e-4b78cf6086f8

**Score:** 4.4/5  **Status:** Evaluated  **Resume:** SDE
**Legitimacy:** High Confidence (Ashby, active, employer-hosted board with live compensation disclosure)
**Level strategy:** New-grad + experienced (0-2 years band, explicitly early-career)
**Comp research:** $135,000-$150,000 base plus equity (stated in the Ashby compensation field on the posting itself)
**Sponsorship flag:** Y (H1B-HISTORY; no restrictive language in the JD, and the perks block scopes benefits to full-time US employees without a citizenship or authorization gate)

## Block A, Role Summary

| Field | Value |
|---|---|
| Archetype | Software Engineer (New Grad), with a Forward-Deployed / embedded-engineering flavor |
| Domain | Handshake AI internal operations tooling: automation and workflow systems for the operator org running the frontier-lab data business |
| Location | San Francisco, CA (in person, SF office with free lunch and gym in the perks block) |
| TL;DR | The single best fit in this batch. A 0-2 years req that asks for exactly what Anmol did at Tabhi: sit next to operators, learn their workflow, and turn it into reliable internal automation. Comp clears the mid-tier target band. |

## Block B, CV Match

| JD Theme | CV Evidence |
|---|---|
| Partner directly with operators, learn their workflows, translate into technical requirements | Tabhi Office of the CEO: collaborated with the CEO to translate core operational workflows into AI products and deliver production systems for operations teams. This is a near-verbatim match to the JD's primary duty. |
| Build internal tools, automations, and workflows that improve operational throughput, accuracy, and visibility | Tabhi: autonomous multi-agent QC system processing 50,000 flight bookings per day, plus a dedicated agent to validate, dispute, and settle Airline Debit Memos, which is exactly an internal ops-throughput tool |
| Own well-scoped projects end to end: implementation, testing, rollout, iteration | Byju's: built and owned the Batching service frontend end to end, cut bug-resolution time 25%, shipped ahead of sprint deadlines |
| Write maintainable, well-tested code, follow established engineering practices | Byju's: authored the unit-test suite for the Scheduling microservice backend to 100% code coverage, eliminating a class of regression bugs across production deploys |
| Operational analytics, instrumentation, dashboards, QA (extra credit) | Tabhi: governance layer with a hash-chained audit ledger and kill-switches, and an adversarial-eval harness that validated the detector at ~99.8% precision. Data-quality tooling is literally the extra-credit bullet. |
| Review and approval flows, case management, data-quality tooling (extra credit) | Tabhi ADM dispute-and-settle agent is a review-and-approval workflow with permission-bounded control loops |
| 0-2 years, growing engineering judgment, clean scalable code with guidance | 2.5 years SDE at Byju's before the master's gives more production discipline than the band assumes, without overshooting into senior territory |
| Curiosity and adaptability in ambiguous environments, incremental shipping | 6 hackathon wins totaling roughly $22,000 including 1st of 200+ at Red Hat Hack APAC; Cloudify built at TartanHacks 2026 |
| Communication with non-engineering stakeholders, good EQ | Founder-direct delivery at Tabhi; cross-vertical coordination across 10+ legacy verticals at Byju's |

## Block C, Level and Strategy

The req is titled Associate Software Engineer and asks for 0-2 years, which is the cleanest possible new-grad landing zone: senior enough to expect real ownership, junior enough that Anmol is not competing against staff engineers. Handshake separately runs a Senior Software Engineer, Operator Tooling req on the same team (HAI Engineering), which confirms the ladder is real and this is the deliberate bottom rung rather than a downlevelled senior slot.

Positioning: apply as an early-career engineer with prior production experience, not as a career-changer. The differentiator to lead with is that Anmol has already done the embedded-with-operators job. The JD says the team "functions like an embedded/consulting engineering group" and that success needs "solid technical fundamentals plus good EQ". Tabhi's Office of the CEO placement is the proof, and very few 0-2 years candidates can claim it.

Second positioning note: the JD says "clearly-scoped operational needs" and "with guidance on discovery and technical design". Do not oversell autonomy or architecture ownership; oversell reliability, throughput, and working well with non-engineers. Matching the stated altitude matters more here than maximizing seniority signal.

The one thing to be careful about: Anmol's strongest recent work is agentic AI, and Handshake AI is an AI data business, so there is a pull toward pitching this as an AI-engineering role. It is not. It is internal tooling for the operator org. Frame the Tabhi agents as operational automation that made an ops team faster and more accurate, not as frontier model work.

## Block D, Comp and Demand

The posting discloses $135,000-$150,000 base with equity. That sits above Anmol's mid-tier growth-startup target of $120,000-$140,000 base and comfortably above the $100,000 acceptable floor, and it is in the same band as top-tier new-grad software offers. San Francisco cost of living absorbs part of that premium, but the number is honest for the level and the equity is on a company the posting describes as having gone from $0 to roughly a $1B run rate.

Demand context: the posting states Handshake AI pays roughly $60M monthly to over 30,000 individuals and works with frontier AI labs on evaluation and benchmark data. An operator org at that scale generates continuous internal-tooling demand, which is a good sign for both headcount stability and scope growth. Treat the range as real rather than aspirational, since Ashby is rendering it from a structured compensation tier, not from prose.

Comp posture at offer time: this is at target, so lead with fit and do not negotiate base first. If there is a conversation, equity and the learning stipend are the levers.

## Block E, Personalization Plan

1. **Open on the operator match, not on AI.** One line: shipped internal automation for an operations team from inside the Office of the CEO, processing 50,000 bookings per day, with the operators as the users. That is the whole pitch.
2. **Second beat, reliability.** The governance layer (hash-chained audit ledger, kill-switches) and the 100% coverage test suite at Byju's answer "write maintainable, well-tested code" and "reliable, well-built systems" with hard evidence rather than adjectives.
3. **Third beat, EQ.** Name the cross-functional pattern explicitly: operators described a workflow, the workflow was wrong in three places, and the fix was iterating with them rather than shipping the first spec. The JD flags communication twice, so it is a scored dimension.
4. **Extra-credit hook.** The ADM validate-dispute-settle agent is a case-management and review-approval flow, which is one of the named extra-credit areas. Say those words.
5. **Resume choice.** SDE PDF. This is internal tools and product engineering, not modeling work; the MLE framing would misread the role.
6. **Do not** frame the Tabhi work primarily as multi-agent LLM research. Frame it as operations throughput and accuracy.

## Block F, Interview Plan

Expected loop for an associate SWE at a company of this stage: recruiter screen, technical phone screen (data structures and algorithms or a practical coding exercise), a practical or take-home internal-tools build, a systems and design discussion scoped to internal tooling, and a cross-functional or values round with an operator partner.

Prepare:
- **Practical coding.** Expect CRUD-plus-workflow rather than exotic algorithms: intake queues, state machines for approval flows, idempotency, retries, pagination over messy data. Byju's e-commerce work at 200,000+ daily users and the Scheduling microservice are the reference stories.
- **Internal-tools design question.** Rehearse a design for a review-queue tool: intake, assignment, SLA tracking, audit trail, and a quality-sampling loop. The Tabhi ADM agent is a ready-made answer if reframed away from agents and toward workflow.
- **Instrumentation.** Be ready to say how you would measure whether a tool actually improved operator throughput and accuracy, since the JD names throughput, accuracy, and visibility as the goals. Use the ~99.8% precision validation and the 39%-to-validated extractor replacement as evidence of measuring rather than assuming.
- **Stakeholder story.** One story where the requirement as stated was not the real need, and how that was discovered by watching the work rather than reading the ticket. This team scores EQ.
- **Growth framing.** The JD says "seek feedback proactively" and "grow through code review and pairing". Have a genuine example of changing an approach after review; the 15+ multi-agent review loops at Tabhi work if told as a learning story.
- **Company question to ask.** How the embedded model works in practice: are engineers assigned to an operator pod for a quarter, or rotated per project? That question signals you read the role correctly.

## Block G, Legitimacy

Employer-hosted Ashby board (`jobs.ashbyhq.com/handshake`), posting id fe319ff8-87e1-46d9-b23e-4b78cf6086f8, `isListed: true`, `employmentType: FullTime`, structured address San Francisco, California, United States, live apply URL, and a structured compensation tier rendering $135,000-$150,000 plus equity. The board carries 79 live postings including a matching senior req on the same team, so this is a functioning recruiting funnel, not a one-off ad. Handshake is a widely known company (25 million job seekers, 1 million+ employers, 1,600 educational institutions per the posting).

**TRUE-AGE: 3d** (Ashby `publishedAt` 2026-08-11T22:39Z, read against 2026-08-14). **FRESHNESS: FRESH** (0-7d band).

No clearance, ITAR, export-control, "US person", or citizen-only language anywhere in the posting. No PhD requirement. No text aimed at automated screeners. Compensation is disclosed voluntarily and precisely, which is a positive integrity signal.

Two minor notes, neither disqualifying: the posting title says "Operator Experience" while the body says "Software Engineer on Operating Tooling", which is ordinary internal naming drift; and the growth claims in the About section ($0 to roughly $1B run rate) are company marketing copy and are treated as unverified context rather than fact. **High Confidence.**

## Recommendation

**APPLY within 48 hours.** Submit the SDE resume. This is the strongest role in the batch on every axis that matters: the level band is exactly right (0-2 years), the comp is disclosed and above target, the posting is three days old, the board is employer-hosted and clean, and the core duty (embed with operators, turn their workflow into reliable internal tooling) is the same job Anmol just did at Tabhi from inside the Office of the CEO. Lead with the operator-facing automation story and the 100% test-coverage and audit-ledger reliability evidence; deliberately downplay the frontier-AI framing, because the team buys internal-tools engineering and good judgment, not model work. Ship the application before the fresh window closes.
