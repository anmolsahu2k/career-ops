# Job Search Hacks Playbook (Full-Time / New-Grad)

Self-contained brief for an agent picking up Anmol's FT / new-grad search. Read top-to-bottom, then act against the Action Checklist. Tactics are from r/jobsearchhacks (secondary citations), 2026 data studies, and tooling reviews; key sources at the end.

## 1. Who you are working for

- **Anmol Sahu**, CMU MISM-BIDA (Heinz, Dec 2026 grad, ~Jan 2027 start). F-1, OPT-eligible after graduation, needs H-1B sponsorship long-term. 2.5 yrs SDE at Byju's, then AI Engineer Intern at Tabhi (agentic AI). Projects: Highmark cancer-staging XGBoost, Cloudify multi-agent migration, EEG Classification (CMU 11-685). 6 hackathon wins.
- **Target roles (Rule 5)**: SDE / SWE (New Grad), AI Engineer, MLE, Data Scientist, Data Engineer, Data Analyst, Forward-Deployed / Solutions Engineer. **US-only** (in-person or remote-US); no India-remote.
- **Source-of-truth CV**: [career-ops/cv.md](../cv.md). Submission resumes are the user's PDFs in `Stuff/Resume/` (never generate PDFs). Append-only master at `Stuff/Resume/master-resume-source.md`.
- **Tracker**: `ft/data/applications.md`, 9 columns, parsed by the Go dashboard. Do not change the schema.

## 2. Hard rules (DO NOT violate)

1. No em-dashes or en-dashes in candidate-facing content.
2. No CV PDF generation. Provide evals + form answers + cover letters (on request) only.
3. No F-1 / OPT / H-1B / sponsorship explainer anywhere candidate-facing. If a start date is asked: "Available January 2027."
4. **Cover letters ONLY on explicit user request. Do NOT auto-draft one during evaluation, even for a top-tier (>= 4.0) role.** Application-question files follow the same on-request rule.
5. Don't push commits, send emails, or send LinkedIn messages. Drafts only; the user sends.
6. Don't change the tracker schema. Embed the cover-letter pointer in Notes with the `CL:` prefix only. Eval reports must include a `**URL:**` line (not `**Apply:**`).

## 3. Tactics, ranked by leverage

### Tier 1 (do first)

**A. Be in the first 25-50 applicants.** First-50 applicants get 4-8x the callback rate of applicant 247.
- LinkedIn URL trick: swap `&f_TPR=r86400` (24h) for `&f_TPR=r3600` (1h), append `&sortBy=DD` (newest first). Other params: `f_AL=true` (actively hiring), `f_VJ=true` (verified, filters scams), `f_JIYN=true` (in your network).
- Bookmark (US geo), check 2x daily AM + early-PM EDT: `software engineer new grad 2026`, `machine learning engineer new grad`, `data scientist new grad`, `new grad software engineer 2027`.
- Best windows: Tue-Thu, 6-11 AM employer-local (Tuesday gets ~22-27% of weekly postings and the highest callback rate).

**B. Direct hiring-manager outreach (Apollo.io free tier).** One documented hack: 3 HM emails, 2 interviews, an offer.
- Find the hiring/eng manager on LinkedIn, get a verified email via Apollo (or Hunter.io / RocketReach), send a 50-125 word email (25w who you are / 40w why them / 30w specific ask), follow up once at 5-7 days.
- Response benchmarks: alumni 30%, cold 10%, recruiter DM 8-30%. Subject 6-10 words naming the role or a signal you noticed (3.2x open rate).

**C. Apply on company career pages, not aggregators.** Google Jobs 11.29% vs LinkedIn 3.10% response (2026 600k-application study); career pages + referrals 15-30%.

### Tier 2: tooling

**D. Aggregators.** SimplifyJobs/New-Grad-Positions, vanshb03/New-Grad-2027, speedyapply/2026-SWE-College-Jobs, HiringCafe, TrueUp.io, Levels.fyi /jobs, BuiltIn. Sponsorship filter: jobright-ai/Daily-H1B-Jobs-In-Tech, myvisajobs.com, immihelp.com/h1b-visa-sponsors. (These are the same feeds the career-ops aggregator ingests; see [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).)
**E. Simplify Copilot (free).** Autofills Workday/Greenhouse/Lever/iCIMS/Taleo/SmartRecruiters + 100+ portals, no limit. The only auto-apply tool worth using.
**F. Skip mass-apply bots** (LazyApply/Sonara/AiApply): sub-5% callback, CAPTCHA-walled, ATS systems fingerprint bot submissions.

### Tier 3: resume / ATS

**G. No white-text keyword stuffing.** 2026 ATS detects text-color == background and can flag or do-not-consider you.
**H. Real ATS keyword match:** paste the JD into wordclouds.com, mirror the top 8-10 terms in a Skills block near the top, weave 1-2 into each bullet. Bullet = `[action verb] + [task] + [measurable result] + [timeframe]`. Lifts match ~40-50% to 80-90%; tailored resumes get +40% callbacks. Resume picker: **SDE PDF** for SDE/backend/infra; **MLE PDF** for AI/ML/DS/applied-scientist.

### Tier 4: networking

**I. Alumni cold messages get 30% reply** (vs 10% for strangers). 50-75 words, ask for a 15-min chat not a job. LinkedIn DM Tue-Thu 9-11 AM, under 300 chars, +27% if you reference a shared employer/school; follow up once at 5-7 days. Templates: [templates/alumni-outreach.md](alumni-outreach.md).
**J. Boolean Google:** `site:linkedin.com/jobs ("software engineer" OR "new grad") "2026"`, `("we're hiring" OR "join our team") "hiring manager" Pittsburgh`.

### Tier 5: filtering noise

**K. Ghost-job filter** (18-22% of postings are ghosts): skip 30+ day-old or reposted-every-few-weeks roles, no team/responsibilities, present on aggregators but missing from the company's own careers page, or the same role open in many geos with identical text.
**L. Rejection is not a dead lead.** 26% who reply professionally are reconsidered within 6 months. Set a 45-60 day reconnect reminder for any clean reject with a real recruiter.

## 4. Workflow recipes

### Recipe 1: process a fresh posting
1. Read the JD; verify US or remote-US and not a ghost (Tier 5K).
2. Score 1-5 against [config/profile.yml](../config/profile.yml) `target_roles` + `ft_constraints`.
3. Write `ft/reports/{slug}/{NN}-{slug}-{date}.md` with a mandatory `**URL:**` header, score, and fit narrative.
4. Append a 9-column row to `ft/data/applications.md`. Do NOT auto-draft a cover letter (Rule 4); generate one only if the user asks, into `{NN}-{slug}-cover-letter.md`, and add the `CL:` pointer to Notes.
5. Pick the resume (SDE vs MLE PDF), note it in Notes.

### Recipe 2: hiring-manager outreach for an applied role
1. Pull company + role from `ft/data/applications.md`.
2. LinkedIn: `(hiring manager OR engineering manager OR director) AT {company}` in the target domain.
3. Apollo free tier: name + company domain, get a verified email.
4. Draft a 75-word email: para 1 (25w) who you are + which role/date; para 2 (40w) one specific team reason tied to a project (Tabhi, Highmark, EEG CLIP, Cloudify) plus a public signal (blog/talk/launch); para 3 (10w) offer a 60-second walkthrough. Sign-off + LinkedIn + portfolio.
5. Save as `ft/reports/{slug}/{NN}-{slug}-hiring-manager-email.md` with recipient + send window. Do not send; hand to the user.

### Recipe 3: tailor a bullet to a JD
Prompt: rewrite `{bullet}` for `{JD}` using `[action verb] + [task] + [result] + [timeframe]`, weave in 1-2 JD keywords without inventing facts, keep under 2 lines, no em/en-dashes. Return only the rewritten bullet.

## 5. Action Checklist

Every session:
- [ ] Run the LinkedIn `f_TPR=r3600&sortBy=DD` new-grad queries (SWE/MLE/DS, US), or run `/career-ops scan` (the automated funnel, see [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)). Run Recipe 1 on new fits.
- [ ] Reconcile ATS confirmation + rejection emails into the tracker (or run `/career-ops gmail-sweep`).

Weekly:
- [ ] Run Recipe 2 for Applied roles with no hiring-manager email drafted yet.
- [ ] Pull new fits from the Tier-2 aggregators; run Recipe 1.
- [ ] Draft alumni outreach ([alumni-outreach.md](alumni-outreach.md)) for ghosted applications.

## 6. Sources (key)

scale.jobs (Reddit tips + 2026 job-search statistics), Kondo (LinkedIn URL + cold-message hacks), The Interview Guys (job-search tips, ghost-job detection), FirstSales (cold emails), Simplify Copilot, ResumeHog (LazyApply review), and the aggregator repos in Tier 2D.
