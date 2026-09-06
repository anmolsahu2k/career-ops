# Mode: contact -- LinkedIn Power Move

> **Read [outreach.md](outreach.md) first if this is outreach for a tracker row.** That mode owns target-finding: existing enriched leads in `data/outreach-leads.json`, the CareerShift contact + CMU-alumni queries, and already-staged drafts. This file is the message-format layer only (3-sentence framework, 300-char cap) and has no memory of prior enrichment, so starting here re-derives worse targets from search snippets. Step 1 below is the **fallback** for when outreach.md's ladder comes up empty.

1. **Identify targets** via WebSearch:
   - The team's hiring manager
   - Assigned recruiter
   - 2-3 team peers (people in a similar role)
   - Interviewer (if the candidate already has an interview scheduled)

2. **Classify the contact type** -- ask the candidate or infer from context:
   - **Recruiter** -- someone whose role is talent acquisition, sourcing, or recruiting
   - **Hiring Manager** -- the person leading the hiring team
   - **Peer** -- someone in a similar role on the team (indirect referral)
   - **Interviewer** -- someone who will interview the candidate (known date)

3. **Select the primary target**: the person who would benefit most from the candidate being there

4. **Generate the message** with a 3-sentence framework adapted to the contact type:

   ### Recruiter
   - **Sentence 1 (Fit)**: Direct match criteria -- role, relevant experience, availability or location
   - **Sentence 2 (Proof)**: A fact that answers their screening questions before they ask (e.g., "5 years building ML pipelines, currently in Berlin, available immediately")
   - **Sentence 3 (CTA)**: "Happy to share my CV if this aligns with what you're looking for"

   ### Hiring Manager
   - **Sentence 1 (Hook)**: A specific challenge their team faces (pulled from the JD, company blog, or news)
   - **Sentence 2 (Proof)**: The candidate's biggest quantifiable achievement showing they have solved similar problems
   - **Sentence 3 (CTA)**: "Would love to hear how your team is approaching [specific challenge]"

   ### Peer (referral)
   - **Sentence 1 (Interest)**: A genuine reference to their work -- blog post, talk, open source project, or publication
   - **Sentence 2 (Connection)**: Something the candidate is doing in the same space (NOT a job pitch)
   - **Sentence 3 (CTA)**: "I've been working on similar problems at [company], would love to hear your take on [topic]"
   - **Note**: Do NOT ask for a job. The referral happens naturally if the conversation flows.

   ### Interviewer (pre-interview)
   - **Sentence 1 (Research)**: A reference to something specific in their work or career
   - **Sentence 2 (Context)**: A light connection to the candidate's experience with that topic
   - **Sentence 3 (CTA)**: "Looking forward to our conversation on [date]"
   - **Note**: Light tone, not desperate. The goal is for them to know you prepared.

5. **Versions**:
   - EN (default)
   - ES (if the company is Spanish)

6. **Alternative targets** with justification for why they are good second choices

**Message rules:**
- Maximum 300 characters (LinkedIn connection request limit)
- NO corporate-speak
- NO "I'm passionate about..."
- Something that makes them want to reply
- NEVER share a phone number
- The contact type changes the EMPHASIS, not the structure
