# Alumni Outreach Priority List (Track A2)

Per-company action plan for finding CMU alumni and sending warm-intro / referral requests. Covers all 20 tracker entries plus a few high-priority companies you may want to add.

**Templates**: `career-ops/templates/alumni-outreach.md`
**Where to search**:
- LinkedIn: People search filter `"Carnegie Mellon" + [Company] + [Role]`
- CMU Alumni Online Community: [community.cmu.edu/s/](https://community.cmu.edu/s/)
- Tartan Connect (linked from main CMU careers site)

---

## Tier 1, send within 48 hours (these are companies you've ALREADY APPLIED to)

These get **Variant A** ("just applied, asking for advocacy"). Highest ROI per message.

| Company | Search query | Variant | Notes |
|---|---|---|---|
| Sierra | `"Sierra" "Carnegie Mellon"` then filter SF eng | A | SF-based; aim for 2-3 messages |
| Lindy | `"Lindy" "Carnegie Mellon" engineer` | A | Small startup; might be 1-2 alumni only. CEO Flo Crivello is on Twitter and LinkedIn — separate (careful) outreach if no alumni found |
| Cohere | `"Cohere" "Carnegie Mellon" SF OR NY` | A | **Filter by SF/NY only** (avoid Toronto-based alumni, they can't help with US placement) |
| Stripe | `"Stripe" "Carnegie Mellon"` | A | Stripe has heavy CMU pipeline; aim for 3-5 messages |
| Airbnb | `"Airbnb" "Carnegie Mellon" "Data Scien"` | A | Filter for DS/ML engineers specifically |

## Tier 2, send within 5 days (companies with cover letter ready, you'll apply to soon)

Use **Variant 2** ("haven't applied yet, asking for warm intro before submission") since user hasn't applied to these yet.

| Company | Search query | Variant | Notes |
|---|---|---|---|
| **Hippocratic AI** | `"Hippocratic AI" "Carnegie Mellon"` | 2 | **Apply this FIRST** (4.8 score). Healthcare-AI startup, Palo Alto. Small alumni pool likely. |
| Microsoft Research | `"Microsoft Research" "Carnegie Mellon"` filter Redmond | 2 | Heavy CMU pipeline; many MSR alumni from CMU. Target 3-5 messages |
| TikTok | `"TikTok" OR "ByteDance" "Carnegie Mellon" "Software Engineer" OR "ML"` | 2 | Filter for SF/Mountain View/Bay Area only (avoid Beijing-based) |
| Adobe | `"Adobe" "Carnegie Mellon" "AI" OR "ML"` filter San Jose | 2 | Adobe has strong CMU pipeline; target Adobe Research / Firefly engineers |
| Cloudflare | `"Cloudflare" "Carnegie Mellon"` filter Austin/SF | 2 | Austin-based intern role; target Austin or SF alumni |
| Twilio | `"Twilio" "Carnegie Mellon" engineer` | 2 | Remote-US role; alumni location flexible |
| Brex | `"Brex" "Carnegie Mellon"` | 2 | Strong CMU pipeline at Brex. Already drafted full outreach guide at `_REVIEW/006-brex-alumni-outreach.md` |
| Cerebras | `"Cerebras" "Carnegie Mellon"` filter Sunnyvale | 2 | Smaller pool; target Sunnyvale Growth team if findable |
| Palantir | `"Palantir" "Carnegie Mellon" NYC` | 2 | Heavy CMU pipeline at Palantir. Apply Variant 2 |
| Match Group / Tinder | `"Match Group" OR "Tinder" "Carnegie Mellon"` filter Palo Alto | 2 | Smaller pool; pair with #017 + #018 messaging |
| Zoox | `"Zoox" "Carnegie Mellon"` filter Foster City | 2 | Robotics + CMU has overlap; might find solid alumni |
| Adobe Applied Scientist (R161660) | (same as Adobe MLE search; same alumni) | 2 | Same alumni pool as #14 Adobe MLE |
| Scale AI | `"Scale AI" "Carnegie Mellon"` filter NY | 2 | **Verify role is F-1 friendly first.** Don't message before confirming |

## Tier 3, deferred (companies you're NOT applying to, lower priority)

| Company | When to outreach | Why |
|---|---|---|
| Pinterest | Skip (Fall conflict) | n/a |

---

## Specific contact strategy

### For each Tier 1 company (3-5 alumni each = ~15 messages total)

1. Run LinkedIn search with the query above
2. Filter for **currently at company**, **engineering or data role**, **not "ex-"**
3. Sort by mutual connections (1st-degree first, then 2nd-degree)
4. Pick 3-5 candidates to message
5. Use **Variant A** template from `career-ops/templates/alumni-outreach.md`
6. Customize: their name, what specific team they're on (if visible), and one sentence acknowledging something specific about their work

### For each Tier 2 company (2-3 alumni each = ~25 messages total)

1. Same LinkedIn search + filter
2. Use **Variant 2** template (warm intro before submission)
3. If you find a particularly good targeted match (specific engineer in your space), use **Variant B** instead

### Specific high-value outreach moves

1. **Hippocratic AI** (highest fit at 4.8) — search the team page on hippocraticai.com or LinkedIn, look for "Founding Engineer" or "Member of Technical Staff" titles. Smaller team = each message has higher relative weight. Even 2-3 messages here is high-leverage.

2. **Stripe** — Stripe has many CMU MISM alums in DS/PM roles in addition to engineers. Don't filter too narrowly; include MISM-program-specific alums who can advocate based on shared program.

3. **Brex** — full outreach guide already at `_REVIEW/006-brex-alumni-outreach.md`. Use Variants 1, 2, or 3 from that file based on which contact you're messaging.

4. **Adobe** — Adobe Research has its own internal recruiting; target Adobe Research alumni distinctly from Adobe Engineering for the Applied Scientist role.

5. **Microsoft Research** — MSR has its own recruiting separate from main MS Careers. Target Research Software Engineers, not just researchers; they often have more time to advocate.

---

## Realistic volume target

- Total messages to send: **~35-40** across all 20 companies (3-5 for Tier 1, 2-3 for Tier 2)
- Realistic response rate (CMU-to-CMU): **25-30%** = **9-12 useful conversations**
- Realistic referral rate among responses: **30-50%** = **3-6 internal referrals**
- Realistic conversion (referral → interview): doubles your odds at that company

## Pacing

- **Saturday morning Apr 26**: send 10 messages (Tier 1 priority — companies you've applied to)
- **Saturday afternoon Apr 26**: send 10 more (top Tier 2 — Hippocratic, MSR, Brex, Stripe, Adobe)
- **Sunday Apr 27**: send 10-15 more (remaining Tier 2)
- **Mon-Tue follow-up**: respond to anyone who replies; don't bulk-follow-up no-replies until 7-10 days later

## Tracking

For each message sent, append to the relevant company's Notes field in `data/applications.md`:
```
A2 sent 2026-04-26 to [Name] ([linkedin.com/in/...]); status: pending/replied/declined.
```

## Don't send

- More than 5 messages to any single company in week 1 (looks spammy, alumni talk to each other)
- Generic copy-paste messages (CMU alumni notice; signal homework done)
- Anything before verifying the person is currently at the target company
- During US business hours from a personal LinkedIn profile if your Brex employer search is being noticed (may be relevant for active job-search confidentiality)
