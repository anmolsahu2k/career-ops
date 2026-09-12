# 4320, General Motors | Machine Learning Engineer, AI Inference Solutions (University Grad)

**URL:** https://search-careers.gm.com/en/jobs/jr-202610103/machine-learning-engineer-ai-inference-solutions-university-grad/

**Score:** 3.3/5  **Status:** Evaluated  **Resume:** MLE
**Legitimacy:** High Confidence (GM corporate careers site, req JR-202610103, active)
**Level strategy:** New-grad-only
**Comp research:** $119,250 to $150,850 base annually, stated in the req body, plus an incentive pay program; below the Bay Area new-grad ML band for AI-native peers (Levels.fyi puts Bay Area new-grad ML/infra total comp well above this), consistent with an OEM rather than a tech-company band
**Sponsorship flag:** Y (H1B-HISTORY; General Motors is a long-running, high-volume filer, and the req carries no restriction language)

## Block A, Role Summary

| Field | Value |
|---|---|
| Archetype | ML / Applied Scientist (New Grad) crossed with ML platform and inference infrastructure |
| Domain | GM AV, Model Deployment and Inference Solutions. Takes trained models out of PyTorch and onto autonomous-vehicle silicon under real-time latency and memory budgets, on the critical path for GM's committed 2028 eyes-off launch on the Cadillac Escalade IQ |
| Location | Sunnyvale, CA. Hybrid, at least 3 days a week on site. Relocation benefits may apply |
| TL;DR | Content-wise this is one of the better new-grad ML systems reqs in the batch: deployment platform plus quantization, pruning, distillation, profiling, and explicit agentic-tooling work, which lines up with the Tabhi agent platform and the PSC GPU pipeline. The binding problem is the eligibility window. The req says the degree must be completed by Spring 2026 and, in the About the Role paragraph, "recently or will be completing their degree by August 2026". A December 2026 completion sits outside that window, and the application form will ask for a graduation date. The parenthetical "Degree must be completed before your start date" is the only clause that leaves any room. Treat as a low-cost long shot, and prioritise GM's 2027 university-grad reqs when they open |

## Block B, CV Match

| JD Theme | CV Evidence |
|---|---|
| Contribute production code across an ML deployment platform | Tabhi: architected and productionised an autonomous multi-agent system processing 50,000 flight bookings per day under an event-driven architecture, shipped to production |
| Model-optimization workflows (quantization, pruning, distillation) | EEG project: 11.5K-parameter EEGNet beating a 127.6M-parameter MLP baseline, an 11,000x parameter reduction with +1.31pp accuracy, which is the parameter-efficiency instinct this team is buying, though not quantization or distillation specifically |
| Inference benchmarking and profiling infrastructure | Tabhi: adversarial-eval harness that deprecated a 39-percent-faithful legacy extractor and validated the detector at roughly 99.8 percent precision; the measurement discipline transfers, the GPU-level profiling does not |
| Hands-on AI/ML via coursework, research, internships, or projects | CMU 11-685 Intro to Deep Learning (multi-head CNN plus Transformer over 122-channel EEG, 26,000 trials); Highmark XGBoost pipeline on 6M+ longitudinal claims; Machine Learning for Problem Solving coursework |
| Python and/or C++ proficiency, strong CS fundamentals | Python at production depth across Tabhi, Highmark, and the EEG project; B.Tech CSE at CGPA 3.87 plus CMU MISM-BIDA at CGPA 3.75; C++ appears on the Skills line without a supporting artifact |
| Depth in computer architecture, operating systems, distributed systems, or compilers | Distributed systems is the covered leg: Byju's microservice refactor across 10+ legacy verticals and the AWS to GCP migration worth $400K annual savings. Architecture, OS internals, and compilers are not evidenced |
| Familiarity with PyTorch and modern ML compiler/runtime stacks | PyTorch on the Skills line and used in the EEG project. torch.compile, TensorRT, ONNX, Triton Inference Server, and vLLM are all absent |
| Experience with or strong interest in coding assistants and agents | Direct hit and the strongest differentiator on this req: Cloudify is a multi-agent OpenAI plus Anthropic Claude platform built via the Dedalus SDK, and the Tabhi work is agent orchestration with a governance layer, hash-chained audit ledger, and kill-switches |
| Building agentic or LLM-powered tools or workflows (preferred) | Same two artifacts, plus the "agentic specialists" the req names as platform tooling map almost one-to-one onto the Tabhi validate-dispute-settle agent design |
| Reliability, correctness, and clean abstractions in a large codebase | Byju's: unit-test suite for the Scheduling microservice backend at 100 percent code coverage; 15+ multi-agent review loops at Tabhi |
| Workflow and ML platforms (Airflow, Temporal, Flyte, Ray, Kubeflow) | Closest analogue is the Slurm sbatch pipeline with preflight CUDA and environment checks on the PSC GPU cluster; none of the named platforms |
| GPU programming (CUDA, OpenAI Triton), Nsight profiling | Not on the CV. PSC cluster work is job orchestration, not kernel-level GPU work |
| Safety-critical and on-vehicle software practice | Not on the CV. Nearest adjacency is the DRM-protected reader with OS-level screenshot prevention, which is security hardening, not functional safety |

**Gaps:** GPU kernels and profiling tooling, ML compiler and runtime stacks (TensorRT, ONNX, torch.compile), quantization and distillation as a practised technique, and any automotive or functional-safety exposure. None of these are stated as required; they are the preferred list, and the required list is satisfied except for the graduation window.

## Block C, Level and Strategy

New-grad-only, and unusually well scoped for one: the responsibilities are written as "pair with senior engineers", "under the guidance of senior engineers", "with technical guidance and code review support", with a stated onboarding plan and structured mentorship. That is a genuine early-career req, not a mid-level req wearing a university-grad label.

The level problem is not seniority, it is timing. Two clauses in the req define the window:

1. Required qualification: "Recently completed or completing a Bachelor's or Master's degree by Spring 2026 ... (Degree must be completed before your start date.)"
2. About the Role: "This is an early-career / new graduate role designed for candidates who have recently or will be completing their degree by August 2026."

The req was posted Aug 13 2026, so the plain reading is that GM wants someone available now, from the class that finished in the first half of 2026. A December 2026 completion misses both clauses. The only counter-reading is the parenthetical, which sets the real gate at "degree complete before start date" and is trivially satisfied by a January 2027 start. Reqs do carry internal tension like this, and GM AV has been hiring continuously against the 2028 launch, so the recruiter may simply be reusing a spring template.

Strategy if applying: answer the graduation-date field truthfully as December 2026, state January 2027 availability in the first line of any free-text field so the recruiter can route rather than reject, and treat this as a channel into the GM AV university pipeline rather than as a live shot at this specific req. The higher-yield move is to watch search-careers.gm.com for the same team's next cycle posting, which should carry a 2027 window.

## Block D, Comp and Demand

Base range $119,250 to $150,850, stated in the req, plus an incentive pay program tied to company, level, and individual performance, plus the standard GM benefits stack and possible relocation. Against the profile's comp targets this clears the mid-tier band floor and reaches the lower half of the big-tech band at the top of the range, but for Sunnyvale specifically it is an OEM band, not a Bay Area AI band: peer new-grad ML-systems roles at AI-native companies and at the autonomy pure-plays run materially higher on total compensation once equity is counted, and the Nuro req evaluated in this same batch posts a base range starting above GM's ceiling. GM offsets some of that with hybrid rather than fully on site and with relocation support.

Demand signal is strong and specific. GM has publicly committed to eyes-off autonomy in 2028 on a named vehicle, and this team sits on the critical path for it, with named sister teams for kernels, compiler, reduced precision, and parity. That is a funded, staffed org with a delivery date, which is the opposite of a speculative AV team. The counterweight is that GM has restructured its autonomy organisation before, so the team is durable but the corporate context has churn history.

## Block E, Personalization Plan

Lead with the agentic angle, because it is the rarest thing on the CV relative to this applicant pool and the req asks for it twice (required: experience with or strong interest in coding assistants and agents; preferred: building agentic or LLM-powered tools). Cloudify is the clean public artifact, and the Tabhi platform is the production one: a governance layer with a hash-chained audit ledger and kill-switches is exactly the shape of the "validators, performance probes, parity and sensitivity analyzers, agentic specialists" the req lists as platform tooling.

Second beat: parameter efficiency as a discipline. The 11,000x parameter reduction with a small accuracy gain on the EEG task is the single most on-topic line for a team whose job is fitting models inside latency and memory budgets, and it reads as an instinct rather than a course exercise.

Third beat: production reliability. Byju's 100 percent coverage on the Scheduling microservice and the 10+ vertical microservice refactor answer the "reliability, correctness, and clean abstractions in a large-scale codebase" requirement directly.

Address the timing head on rather than hoping it is missed: state a December 2026 completion and January 2027 availability plainly and early. Do not overclaim on GPU kernels, TensorRT, or quantization; the honest framing is that the ML systems fundamentals and the measurement discipline are there and the vendor-specific runtime stack is the learnable part.

Submit the MLE resume: the title is Machine Learning Engineer and the top of the req is model deployment and optimization, so the MLE framing leads with Tabhi detection-model validation and the Highmark and EEG work, with Byju's underneath as the production-engineering floor.

## Block F, Interview Plan

Expect a screen weighted toward CS fundamentals in Python or C++, then a systems or ML-systems round, then behavioural.

Likely technical ground:
- Data structures and algorithms in Python, standard new-grad difficulty. This is the stated bar.
- ML systems reasoning: how a trained PyTorch model gets to a target device, where latency comes from, what you measure first when inference regresses. Prepare a clean mental model of the graph capture, compile, quantize, deploy, validate path even without hands-on TensorRT.
- Numerical parity: what "parity" means between a training-framework model and its optimized on-device counterpart, why it drifts, and how you would build a validator for it. The req names a parity sister team, so this will come up.
- Quantization tradeoffs: post-training versus quantization-aware, where accuracy is lost, how to bound it. Read enough to answer honestly without claiming production experience.
- Distributed and pipeline reasoning: the Slurm and PSC pipeline and the Byju's microservice refactor are the two anchors.

Behavioural stories, mapped to the profile's STAR guidance:
- Rigour and measurement: the Tabhi adversarial-eval harness deprecating a 39-percent-faithful legacy extractor and validating the detector at roughly 99.8 percent precision.
- Ownership: the Byju's microservice refactor across 10+ verticals.
- Ambiguity: the Highmark staging work under 40 to 51 percent missingness in the primary staging fields.
- Speed: Cloudify at TartanHacks, and the broader record of 6 hackathon wins.

Questions to ask: how the deployment platform and the optimization workstreams split day to day for an early-career engineer; how parity failures get triaged across the kernels, compiler, and reduced-precision teams; what the on-vehicle validation loop looks like before a model reaches the Super Cruise fleet; and directly, what graduation windows the team is considering for this req and for the next cycle.

## Block G, Legitimacy

Posted on GM's own corporate careers site under requisition JR-202610103, with a full compensation disclosure, a named team, a named product programme, and a stated hybrid policy. The LinkedIn row that surfaced this was a mirror; the employer req resolves cleanly and is used as the canonical URL here. Nothing in the posting is aimed at automated screeners, and there is no recruiter-agency intermediary.

TRUE-AGE: 1d (posted Aug 13 2026, read from the "Posted" field on the GM req page). FRESHNESS: FRESH.

One neutral observation worth recording: the req contradicts itself on the graduation window, requiring a degree by Spring 2026 in the qualifications and "by August 2026" in the role summary while also saying only that the degree must precede the start date. That is sloppy req authoring rather than a legitimacy problem, but it is the single fact that governs whether an application here is worth the time.

**High Confidence.**

## Recommendation

**CONSIDER, low priority, apply only as a cheap long shot.** Submit the MLE resume. The work itself is a good match and the agentic-tooling requirement is a rare place where this CV is genuinely differentiated, but the stated graduation window excludes a December 2026 completion and the application form will ask for that date directly. If applying, state December 2026 and January 2027 availability up front so a recruiter can redirect rather than screen out, and lead with Cloudify plus the Tabhi agent platform, then the EEG parameter-efficiency result. The better use of effort is to track GM AV's next university-grad cycle on search-careers.gm.com, where the same team should post a 2027-window version of this req.
