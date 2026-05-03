# Auto-Apply / Job Application Tools — GitHub Research (2026-04-25)

## Bottom line

| Use case | Recommended tool | Why |
|---|---|---|
| **End-to-end auto-apply** | [Pickle-Pixel/ApplyPilot](https://github.com/Pickle-Pixel/ApplyPilot) (877★, Feb 2026) | Only OSS tool using Claude Code CLI + Playwright MCP; covers Indeed, LinkedIn, Glassdoor, ZipRecruiter, Google + 48 Workday portals + 30+ careers pages |
| **LLM-driven adaptive form-fill** | [beatwad/LinkedIn-AI-Job-Applier-Ultimate](https://github.com/beatwad/LinkedIn-AI-Job-Applier-Ultimate) (79★, v1.2 Apr 17 2026) | Patchright bypasses LinkedIn bot detection; applies to ALL LinkedIn jobs not just Easy Apply; multi-LLM (Gemini/OpenAI/Claude/Ollama) |
| **Sheer volume on LinkedIn** | [AIHawk-FOSS/Auto_Jobs_Applier_AI_Agent](https://github.com/AIHawk-FOSS/Auto_Jobs_Applier_AI_Agent) (community fork) | Original AIHawk archived 2026-04-16; this is the canonical successor |
| **Workday + iCIMS specifically** | [berellevy/job_app_filler](https://github.com/berellevy/job_app_filler) (24★) | Only good OSS autofill for Workday/iCIMS — exactly what big-tech intern apps use |
| **Privacy-preserving (local-only)** | [lookr-fyi/JobHuntr](https://github.com/lookr-fyi/job-application-bot-by-ollama-ai) (433★) | Fully local Ollama; nothing sent to OpenAI/Gemini |
| **Just scraping, no apply** | [speedyapply/JobSpy](https://github.com/speedyapply/JobSpy) (3.2k★) | `pip install python-jobspy`; LinkedIn + Indeed + Glassdoor + Google + ZipRecruiter + Bayt + Naukri + BDJobs |

## Hidden gems (low-star, recently created)

- **[Cimerherd/auto-apply-bot](https://github.com/Cimerherd/auto-apply-bot)** (4★) — TypeScript + Gemini + Playwright MCP; LinkedIn/Indeed/Gupy/ZipRecruiter
- **[Dinesh-Satram/job_application_agent_SL](https://github.com/Dinesh-Satram/job_application_agent_SL)** (20★) — uses `browser-use` framework, cleanest agent architecture in the space
- **[sainikhil1605/ApplyEase](https://github.com/sainikhil1605/ApplyEase)** (9★) — Chrome ext + FastAPI + local Ollama; works on any site
- **[imon333/Job-apply-AI-agent](https://github.com/imon333/Job-apply-AI-agent)** (133★) — n8n + Selenium + OpenAI; for those who like workflow tools

## Companion repos to layer on top

- **[SimplifyJobs/Summer2026-Internships](https://github.com/SimplifyJobs/Summer2026-Internships)** — feed direct-apply links into JobSpy or ApplyPilot
- **[jobright-ai/Daily-H1B-Jobs-In-Tech](https://github.com/jobright-ai/Daily-H1B-Jobs-In-Tech)** — F-1/sponsorship filter; **none of the auto-appliers do this natively** so you must dedupe yourself
- **[speedyapply/2026-SWE-College-Jobs](https://github.com/speedyapply/2026-SWE-College-Jobs)** + its `INTERN_INTL.md` — international-friendly intern list

## Critical risk warnings (read before running ANY of these)

1. **LinkedIn ToS §8.2** — every LinkedIn bot here is a ToS violation. **Permanent account bans are reported regularly** in AIHawk's issues. Losing your LinkedIn means losing CMU alumni network access during recruiting cycles. **Do not point any LinkedIn-automation tool at your real account.**
2. **Easy Apply quality penalty** — recruiters at FAANG-tier companies heavily downweight Easy Apply submissions. Volume ≠ value.
3. **CAPTCHA / Cloudflare** — Indeed and Workday increasingly break Selenium-based tools. Patchright (used by beatwad's tool) helps but isn't bulletproof.
4. **Resume PII leakage** — ApplyPilot, AIHawk send full resume to OpenAI/Gemini. Use ApplyEase or JobHuntr for local-only.
5. **AIHawk upstream is archived (read-only since 2026-04-16)** — any tutorial older than 2 weeks points at a dead repo. Use AIHawk-FOSS fork.
6. **No tool natively filters F-1/sponsorship** — you'll auto-apply to citizen-only roles unless you pre-filter.
7. **No tool handles HackerRank/CodeSignal OAs** — "end-to-end" stops at submit; OAs are still on you.

## Pragmatic stack for your use case

Given (a) you don't want to risk LinkedIn ban, (b) most CMU/FAANG/quality intern apps go through Workday/Greenhouse/Lever/iCIMS direct, and (c) you need sponsorship filtering:

```
                    SimplifyJobs/Summer2026-Internships  ←  source of links
                              │
                              ▼
              jobright-ai/Daily-H1B-Jobs-In-Tech  ←  F-1 filter (manual dedupe)
                              │
                              ▼
                          JobSpy (scrape)  ←  enrich with metadata
                              │
                              ▼
              ┌────────────────┴────────────────┐
              ▼                                 ▼
        ApplyPilot              berellevy/job_app_filler
       (Workday + careers)      (Workday + iCIMS Chrome ext)
              │                                 │
              └────────────┬────────────────────┘
                           ▼
                  Manual review of every submission
                  before clicking final "Submit"
```

**Why this stack:**
- No LinkedIn automation — your account stays safe
- Greenhouse/Lever/Workday/iCIMS are where the real intern reqs live anyway
- ApplyPilot's Workday coverage (48 portals hard-coded) handles the most common big-company case
- berellevy's Chrome extension is a manual-but-fast complement when ApplyPilot fails on a specific Workday tenant
- JobSpy gives you a daily email of new postings without applying

## Setup time estimate

- ApplyPilot: ~2 hours (config + Gemini/Claude API key + resume YAML)
- berellevy Chrome extension: ~10 min (clone + load unpacked)
- JobSpy: ~5 min (`pip install python-jobspy`)
- Total before first auto-apply: half a day

## What's missing in this space (as of Apr 2026)

1. No tool natively filters sponsorship/F-1 friendliness
2. No tool handles OAs after submission
3. Workday coverage outside ApplyPilot's 48 portals is poor
4. No multi-tenant tool for student career centers (CMU CPDC could deploy)
5. No tool warns about cross-company recruiter-pattern flagging from mass apply

## My honest recommendation

**Don't auto-apply at all if you can avoid it.** For CMU MISM with your background (Highmark + Cloudify + $22K hackathons), each application matters more than volume. Auto-apply is a tool for candidates whose resume needs raw shotgun-coverage to find a hit; yours doesn't.

**Where auto-apply DOES make sense for you**:
- The bottom of your funnel: tier-3 companies where you're applying "just in case"
- Workday-based applications you'd never finish manually (the "fill out 47 fields about your previous job" bullshit)
- India-side applications where speed > polish

**Where you should still apply manually**:
- Every Tier 1 company (Anthropic, OpenAI, Stripe, Databricks, etc.)
- Every CMU spinoff (Duolingo, Abridge, Skild AI)
- Every faculty-routed application
- Anywhere your CMU alumni network has a referrer

**Suggested split**: 80% manual (high-quality), 20% auto-applied tail. Use ApplyPilot for the tail. Skip every LinkedIn bot.
