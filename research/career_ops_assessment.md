# Career-Ops Tool Assessment (santifer/career-ops)

## What it is

NOT an auto-applier. A Claude Code-powered career operations tool that:
- Evaluates jobs against your CV using A-F scoring on 10 weighted dimensions
- Generates ATS-optimized PDF resumes tailored per job description
- Tracks applications through a Go TUI dashboard
- Builds a STAR+Reflection interview story bank as you apply
- Pre-configured portal scanning for 45+ AI/SaaS companies
- 14 skill modes including batch eval, deep company research, LinkedIn outreach
- **Human-in-the-loop**: never auto-submits; you click final submit

## Repo metadata (per WebFetch, verify yourself)

- **URL**: https://github.com/santifer/career-ops
- **Stars**: ~39.6k (claimed; verify)
- **Forks**: ~8.1k (claimed)
- **License**: MIT
- **Last release**: v1.5.0 (April 14, 2026)
- **Languages**: JavaScript 54.7%, Go 32.9%, Shell 6.9%
- **Tech stack**: Claude Code, Node.js, Playwright, Go, Bubble Tea UI

## Pre-configured companies (45+)

| Category | Companies |
|---|---|
| **AI Labs** | Anthropic, OpenAI, Mistral, Cohere, LangChain, Pinecone |
| **Voice AI** | ElevenLabs, PolyAI, Parloa, Hume AI, Deepgram, Vapi, Bland AI |
| **AI Platforms** | Retool, Airtable, Vercel, Temporal, Glean, Arize AI |
| **Contact Center AI** | Ada, LivePerson, Sierra, Decagon, Talkdesk, Genesys |
| **Enterprise** | Salesforce, Twilio, Gong, Dialpad |
| **LLMOps** | Langfuse, Weights & Biases, Lindy, Cognigy, Speechmatics |
| **Automation** | n8n, Zapier, Make.com |
| **European** | Factorial, Attio, Tinybird, Clarity AI, Travelperk |
| **Job boards** | Ashby, Greenhouse, Lever, Wellfound, Workable, RemoteFront |

Notably missing: Amazon, Google, Meta, Microsoft, FAANG broadly (no big-tech Workday tenants).

## Fit for Anmol's profile

**Excellent fit**, specifically because:

- Cloudify (multi-agent cloud migration via OpenAI + Claude APIs) maps directly to almost every AI Lab / AI Platform / LLMOps company on the pre-configured list
- Anthropic, OpenAI, Cohere, LangChain, Pinecone, Vercel, Temporal, Glean — these are companies Anmol's profile is ABOVE-AVERAGE for, given Cloudify
- Anmol already has Claude Code installed; near-zero friction to start
- AI/SaaS startups hire interns later in cycle than big tech — late-April timing actually works
- Heinz MISM + healthcare ML (Highmark) gives a credible secondary profile for vertical-AI companies (Decagon, Sierra, Glean for enterprise AI)

## Workflow

```
1. Paste job URL or description → Auto-detection
2. Archetype classification (LLMOps, Agentic, PM, SA, FDE, Transformation)
3. A-F evaluation against cv.md
4. Generate ATS-optimized PDF tailored per role
5. Update tracker with results
6. STAR story added to interview prep bank
7. User submits final application manually
```

## Setup (10 min)

```bash
git clone https://github.com/santifer/career-ops.git
cd career-ops && npm install
npx playwright install chromium
npm run doctor
cp config/profile.example.yml config/profile.yml
cp templates/portals.example.yml portals.yml
# Then: create cv.md from existing resume content
# Then: customize via Claude Code
```

## Limitations

1. **No internship-specific framing** — eval framework built for full-time; you'll adjust prompts manually
2. **No F-1/sponsorship filter** — layer jobright-ai/Daily-H1B-Jobs-In-Tech separately
3. **No big-tech Workday configs** — Amazon, Google, Meta, Microsoft would need custom portal setup
4. **Star count and release date unverified** — single WebFetch source; verify on GitHub before deep investment

## How this changes the auto-apply tools recommendation

| Use case | Old recommendation | New (with Career-Ops) |
|---|---|---|
| Tier 1 quality apps (Anthropic, OpenAI, etc.) | Manual, slow | Career-Ops, 5x faster, same quality |
| Tier 1 quality apps (FAANG) | Manual, slow | Manual (no FAANG configs in Career-Ops) |
| Tier 3 Workday tail | ApplyPilot auto-apply | ApplyPilot stays |
| LinkedIn-heavy auto-apply | Don't do it (ban risk) | Don't do it (ban risk) |
| Application tracking | Manual spreadsheet | Career-Ops Go TUI dashboard |
| Interview prep | Scattered notes | Career-Ops STAR story bank |

## Recommended action

If pursuing this:

1. Clone repo to workspace
2. Convert existing `SDE Anmol's Resume(28-02-26)_v3-FINAL.pdf` and `MLE Anmol's Resume(28-02-26)_v3.pdf` into a unified `cv.md` (Career-Ops uses one source-of-truth CV and adapts per job)
3. Add CMU spinoffs + Pittsburgh-local + Hackathon-sponsor companies to portals.yml
4. Run first batch eval against the AI Lab pre-configured set: Anthropic, OpenAI, Cohere, LangChain, Pinecone — these are likely your highest fit-score companies
5. Use generated PDFs + STAR stories for actual applications

## Honest caveat

This tool is exciting but **untested by me directly**. Star counts can be inflated; recently-released projects can be unstable. Spend 30 minutes verifying:
- Real activity in the issues/PRs
- Recent commits (within last 2 weeks)
- Issues that match the official feature claims (especially around Playwright stability)

If the verification checks out, this is the best-fit tool I've seen for your specific situation.
