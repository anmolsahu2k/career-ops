# Career-Ops

A Codex-first, model-agnostic job-search command center that evaluates roles, scans sources, and tracks applications. Antigravity CLI supplies Google and partner-model review; Claude Code, Gemini CLI, and OpenCode files remain only as compatibility adapters. Private fork of [santifer/career-ops](https://github.com/santifer/career-ops) with upstream marketing assets removed.

## What Is This

Career-Ops turns any AI coding CLI into a full job search command center. Instead of manually tracking applications in a spreadsheet, you get an AI-powered pipeline that:

- **Evaluates roles** with the full structured Block A-G report format
- **Selects the right resume** from the user's maintained SDE and MLE PDFs without generating a new CV
- **Scans sources on demand** (Greenhouse, Ashby, Lever, Workday, company pages, and configured aggregators)
- **Processes in batch** with parallel subagents and collision-safe report numbering
- **Tracks everything** in a single source of truth with integrity checks

> **Important: This is NOT a spray-and-pray tool.** Career-ops is a filter -- it helps you find the few offers worth your time out of hundreds. The system strongly recommends against applying to anything scoring below 4.0/5. Your time is valuable, and so is the recruiter's. Always review before submitting.

Career-ops is agentic: Codex verifies career pages, evaluates fit by reasoning about your CV versus the job description, writes a full report, selects the appropriate submission resume, and updates the tracker through the guarded TSV merge flow.

> **Heads up: the first evaluations won't be great.** The system doesn't know you yet. Feed it context -- your CV, your career story, your proof points, your preferences, what you're good at, what you want to avoid. The more you nurture it, the better it gets. Think of it as onboarding a new recruiter: the first week they need to learn about you, then they become invaluable.

## Features

| Feature | Description |
|---------|-------------|
| **Auto-Pipeline** | Paste a URL, get a full evaluation, report, resume selection, and tracker entry |
| **7-Block Evaluation** | Role summary, CV match, level strategy, comp research, personalization, interview prep, and posting legitimacy |
| **Interview Story Bank** | Accumulates STAR+Reflection stories across evaluations -- 5-10 master stories that answer any behavioral question |
| **Negotiation Scripts** | Salary negotiation frameworks, geographic discount pushback, competing offer leverage |
| **Resume Selection** | Chooses the maintained SDE or MLE resume; this fork never generates CV PDFs |
| **Portal Scanner** | 45+ companies pre-configured (Anthropic, OpenAI, ElevenLabs, Retool, n8n...) + custom queries across Ashby, Greenhouse, Lever, Wellfound |
| **Batch Processing** | Parallel evaluation with Codex subagents; legacy agent adapters remain isolated |
| **Dashboard TUI** | Terminal UI to browse, filter, and sort your pipeline |
| **Human-in-the-Loop** | AI evaluates and recommends, you decide and act. The system never submits an application -- you always have the final call |
| **Pipeline Integrity** | Automated merge, dedup, status normalization, health checks |

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/santifer/career-ops.git
cd career-ops && npm install
npx playwright install chromium   # Required for liveness and job-page verification

# 2. Check setup
npm run doctor                     # Validates all prerequisites

# 3. Configure
cp config/profile.example.yml config/profile.yml  # Edit with your details
cp templates/portals.example.yml portals.yml       # Customize companies

# 4. Add your CV
# Create cv.md in the project root with your CV in markdown

# 5. Open this folder in the ChatGPT desktop app with Codex
# Or run `codex` after the Codex CLI is installed and working

# Then ask Codex to adapt the system to you:
# "Change the archetypes to backend engineering roles"
# "Add these 5 companies to portals.yml"
# "Update my profile with this CV I'm pasting"

# 6. Start using
# Paste a job URL or invoke $career-ops
```

Playwright Chromium is used for liveness checks and job-page verification, not for resume generation.

> **The system is designed to be customized by the coding agent itself.** Modes, archetypes, scoring weights, and negotiation scripts are plain repository files, so Codex can update the same logic it executes.

See [docs/CODEX.md](docs/CODEX.md) for Codex usage and [docs/SETUP.md](docs/SETUP.md) for the full setup guide.

## Antigravity CLI Integration

Career-Ops routes Google and partner models through Antigravity CLI (`agy`).
Model names and effort levels live only in runtime configuration; policy,
validation, rendering, and persistence remain provider-neutral.

```bash
agy models
node bin/career-ops.mjs doctor --config config/runtime.example.yml
```

The example providers are disabled by default. Copy the runtime config locally,
enable only the Antigravity routes you intend to qualify, and acknowledge quota
explicitly for shadow runs. The optional HTTP Gemini adapter remains disabled
unless API billing is deliberately enabled. `GEMINI.md` and `.gemini/` are
legacy adapters, not an active execution path.

## Usage

In Codex, Career-Ops is a repository skill with multiple modes:

```
$career-ops                → Show all available modes
$career-ops {paste a JD}   → Full auto-pipeline (evaluate + report + tracker)
$career-ops scan           → Scan configured sources and evaluate survivors
$career-ops offer          → Full A-G evaluation of one role
$career-ops offers         → Compare multiple roles
$career-ops batch          → Batch evaluate with Codex subagents
$career-ops tracker        → View application status
$career-ops apply          → Assist with an application form
$career-ops contact        → Research a contact and draft outreach
$career-ops deep           → Deep company research
$career-ops training       → Evaluate a course or certification
$career-ops project        → Evaluate a portfolio project
```

You can also paste a job URL or description directly. The skill can be selected implicitly and routes it to the full pipeline. Claude, Gemini, and OpenCode retain their existing slash-command adapters.

## How It Works

```
You paste a job URL or description
        │
        ▼
┌──────────────────┐
│  Archetype       │  Classifies: LLMOps / Agentic / PM / SA / FDE / Transformation
│  Detection       │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  A-G Evaluation  │  Match, gaps, comp, STAR stories, legitimacy
│  (reads cv.md)   │
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
 Report Resume Tracker
  .md    pick   .tsv
```

## Pre-configured Portals

The scanner comes with **45+ companies** ready to scan and **19 search queries** across major job boards. Copy `templates/portals.example.yml` to `portals.yml` and add your own:

**AI Labs:** Anthropic, OpenAI, Mistral, Cohere, LangChain, Pinecone
**Voice AI:** ElevenLabs, PolyAI, Parloa, Hume AI, Deepgram, Vapi, Bland AI
**AI Platforms:** Retool, Airtable, Vercel, Temporal, Glean, Arize AI
**Contact Center:** Ada, LivePerson, Sierra, Decagon, Talkdesk, Genesys
**Enterprise:** Salesforce, Twilio, Gong, Dialpad
**LLMOps:** Langfuse, Weights & Biases, Lindy, Cognigy, Speechmatics
**Automation:** n8n, Zapier, Make.com
**European:** Factorial, Attio, Tinybird, Clarity AI, Travelperk

**Job boards searched:** Ashby, Greenhouse, Lever, Wellfound, Workable, RemoteFront

## Dashboard TUI

The built-in terminal dashboard lets you browse your pipeline visually:

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard --path ../ft   # live FT funnel (this workspace's default)
# ./career-dashboard --path ..    # opens the read-only intern archive at the repo root
```

Features: 6 filter tabs, 4 sort modes, grouped/flat view, lazy-loaded previews, inline status changes.

> **Note:** CV PDF generation is deprecated in this fork. The user submits their own resume PDFs; career-ops provides evaluations, form answers, and cover letters only.

## Project Structure

```
career-ops/
├── AGENTS.md                    # Codex entry point
├── CLAUDE.md                    # Shared legacy-named rules contract
├── .agents/skills/career-ops/   # Native Codex skill router
├── cv.md                        # Your CV (create this)
├── article-digest.md            # Your proof points (optional)
├── config/
│   └── profile.example.yml      # Template for your profile
├── modes/                       # 14 skill modes
│   ├── _shared.md               # Shared context (customize this)
│   ├── offer.md                 # Single evaluation
│   ├── pdf.md                   # Legacy formatting reference; generation disabled
│   ├── scan.md                  # Portal scanner
│   ├── batch.md                 # Batch processing
│   └── ...
├── templates/
│   ├── cv-template.html         # ATS-optimized CV template
│   ├── portals.example.yml      # Scanner config template
│   └── states.yml               # Canonical statuses
├── batch/
│   ├── batch-prompt.md          # Self-contained worker prompt
│   └── batch-runner.sh          # Orchestrator script
├── dashboard/                   # Go TUI pipeline viewer
├── data/                        # Your tracking data (gitignored)
├── reports/                     # Evaluation reports (gitignored)
├── output/                      # Legacy generated artifacts (gitignored)
├── fonts/                       # Legacy resume-template fonts
└── docs/                        # Setup, customization, architecture
```

## Tech Stack

![OpenAI Codex](https://img.shields.io/badge/OpenAI_Codex-000?style=flat&logo=openai&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![Go](https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white)
![Bubble Tea](https://img.shields.io/badge/Bubble_Tea-FF75B5?style=flat&logo=go&logoColor=white)

- **Agent**: Codex with a repository skill and shared mode files
- **Compatibility**: Antigravity is active; Claude Code, Gemini CLI, and OpenCode files are legacy adapters
- **Scanner**: Playwright + public ATS APIs + live web research
- **Dashboard**: Go + Bubble Tea + Lipgloss (Catppuccin Mocha theme)
- **Data**: Markdown tables + YAML config + TSV batch files

## Disclaimer

**career-ops is a local, open-source tool — NOT a hosted service.** By using this software, you acknowledge:

1. **You control your data.** Your CV, contact info, and personal data stay on your machine and are sent directly to the AI provider you choose (Anthropic, OpenAI, etc.). We do not collect, store, or have access to any of your data.
2. **You control the AI.** The default prompts instruct the AI not to auto-submit applications, but AI models can behave unpredictably. If you modify the prompts or use different models, you do so at your own risk. **Always review AI-generated content for accuracy before submitting.**
3. **You comply with third-party ToS.** You must use this tool in accordance with the Terms of Service of the career portals you interact with (Greenhouse, Lever, Workday, LinkedIn, etc.). Do not use this tool to spam employers or overwhelm ATS systems.
4. **No guarantees.** Evaluations are recommendations, not truth. AI models may hallucinate skills or experience. The authors are not liable for employment outcomes, rejected applications, account restrictions, or any other consequences.

See [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) for full details. This software is provided under the [MIT License](LICENSE) "as is", without warranty of any kind.

## License

MIT
