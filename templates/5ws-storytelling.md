# 5 Ws Storytelling Framework

A complementary frame to STAR plus R. Source: cassidoo's getting-a-gig storytelling pattern. Where STAR plus R asks "what happened and what did I learn", the 5 Ws (What, Why, How, When, Who) optimize for "can I survive a deep technical probe without fabricating depth".

## Why this file matters

Anmol's Byju's resume bullets are, by self-rating, around 5/10 on real proficiency. A senior interviewer who probes past the bullet will quickly find a gap unless the answer is grounded in what actually happened. The ground truth is in `/Users/anmolsahu2k/Stuff/Create/Amazon/Work experience-Project based 19a056360b5280798943fb0c02aef26c.md`. This template extracts the real technical detail per bullet and pre-computes 2 to 3 levels of probing answers so the conversation can go deep honestly.

**Honesty rule.** When the bullet inflates what you owned, the 5W answer should:

1. State the bullet's framing once at the top (what the resume says).
2. Then, in the "How" and "Who" sections, narrow to your actual contribution.
3. In "deep-dive prep", pre-rehearse the answers to "what did you actually build" so you do not stumble.

You are not lying by leading with the bullet. You are lying if you double down when probed. Pre-rehearsed deep-dive answers prevent the second.

## The five Ws

- **What** -- the artifact or change in one sentence.
- **Why** -- business or technical motivation.
- **How** -- the mechanism. This is where the real technical detail lives. Be specific to YOUR contribution.
- **When** -- timeline, scale, sequencing.
- **Who** -- you, your team, downstream owners. This is where collaboration honesty lives.

Each bullet below has 5 Ws plus a "Deep-dive prep" section with probing Q and A pairs.

## Cross-reference: story bank

Before adding a new entry below, check `career-ops/interview-prep/story-bank.md`. If a story already exists there, link to it from the relevant section instead of restating. As of this template's creation, the story bank is empty (no `### [Theme]` entries committed yet), so all seven entries below are written in full. When the story bank is populated by future evaluations, future updates to this template should replace the in-line story with a one-line link plus the deep-dive prep block.

---

## 1. Byju's Exam Rank Prediction

**Resume bullet (as written):** "Built a ML-based prediction system using historical performance and student metrics, delivering 90 percent plus accuracy for data-driven guidance."

**Honesty caveat.** This was NOT a machine-learning model. The category team supplied an if-else / threshold logic based on "estimated attempts" and "correct responses". I implemented the rules and the surrounding plumbing. Treat it as rule-based scoring, not ML. Do not say "I trained a model" if probed. The work-experience file confirms: "Calculated rank based on logic given by category team (based on estimated attempts and correct responses)".

### 5 Ws

- **What.** A rank-prediction CTA on the Byju's free-user journey for national-level entrance exams. Given a student's self-reported attempt count and correct-response count, the system mapped them to a predicted rank band and surfaced a tailored message and CTA.
- **Why.** Two business goals: (1) collect data on top scorers (rankers) and underperformers for the 2025 course lead pipeline, and (2) drive lead conversion via personalized messaging on the post-attempt page.
- **How.** I implemented the rank-mapping function as a thresholded if-else on (estimated attempts, correct responses), with the threshold table provided by the category / content team. I wired the input form, the calculation, and the CTA-surfacing into the existing free-user journey on the Next.js / Express stack. Events flowed to GTM and forward to LeadSquared for marketing follow-up.
- **When.** Built during my Byju's FTE tenure. Served alongside the broader e-commerce portal that had 200K plus daily users, so the same traffic could see the rank-prediction CTA on relevant pages.
- **Who.** Category team owned the rank-mapping rules. Marketing owned the LeadSquared lead pipeline. I owned the implementation: input form, scoring function, CTA placement, GTM event wiring, end-to-end testing.

### Deep-dive prep

Q: How did the rank prediction actually work under the hood? Was it ML?
A: It was not a trained model. The category team gave us a rule table mapping ranges of (estimated attempts, correct responses) to predicted rank bands. I implemented it as a thresholded if-else in the Express backend. The "90 percent plus accuracy" framing on the resume is shorthand for the rule's calibration against historical exam data, which the category team validated, not a model I trained.

Q: Where did the 90 percent number come from then?
A: The category team validated the rule table against past-year exam data they already had. I did not run the validation myself; I trusted their number when wiring it into the product.

Q: What was the failure mode of this approach?
A: Two big ones. First, the rule table treated all students with the same (attempts, correct) as identical, so it could not distinguish a careless top-scorer from a careful average-scorer. Second, it relied on self-reported attempt counts, which students would inflate to game the predicted rank. If I were to redo this as a real ML problem, I would treat self-reported numbers as features alongside actual quiz history on the platform and train a calibrated classifier with proper cross-validation.

Q: Why didn't you push for a real model?
A: Honestly, the business goal was lead generation, not prediction accuracy. A rule table the category team trusted was deployable in a sprint. A model would have been a larger project requiring data-science partnership we did not have. The business value lived in surfacing a believable CTA, not in a tighter rank.

---

## 2. Byju's Content and SEO Migration

**Resume bullet (as written):** "Migrated 10K plus articles to WordPress with SEO/traffic analytics pipelines, boosting organic traffic 2.5x and page speed 30x."

**Honesty caveat.** I wrote and ran Python extraction and import scripts. I did NOT architect the migration end-to-end. The decision to move from ReactJS to WordPress was made above me. Yoast plugin choices, lazy-loading, and minification were standard WordPress moves rather than custom engineering on my part. The 2.5x organic traffic and 30x page speed numbers are real outcomes of the migration as a whole.

### 5 Ws

- **What.** Migrated 10,000 plus static exam-content articles from a ReactJS-on-AWS stack into WordPress on AWS, preserving SEO metadata, URL structure, and content relationships.
- **Why.** The marketing and content teams could not publish without engineering involvement on the React stack. ReactJS is also weak for SEO out of the box (CSR, no SEO-friendly URL structure by default). WordPress with Yoast plus SSR meant marketing could publish without engineering, search engines could crawl, and page-speed optimizations (lazy loading, minification) came nearly free.
- **How.** I wrote a Python extraction script that pulled article data (title, meta description, keywords, body HTML, images, links, URL structure, categories) from the existing PostgreSQL database into a structured JSON intermediate. I cleaned and normalized the data into the WordPress import schema. I built CRUD endpoints over the WordPress REST API and ran a batch-import script that pushed records into the WordPress MySQL (RDS) database. Redirects from old React URLs to new WordPress URLs were handled via .htaccess. Yoast SEO plugin handled meta-tag emission. Cloudflare CDN plus Redis on the WordPress server handled caching.
- **When.** During Byju's FTE. Part of the broader Ogma-CMS-driven website re-architecture.
- **Who.** I owned the extract-clean-import scripts and the WordPress REST API integration. Marketing and content teams owned the editorial workflow on the new system. Infra team owned the WordPress server provisioning and the Cloudflare setup. SEO consultancy validated post-migration rankings.

### Deep-dive prep

Q: Walk me through the migration script. What was its structure?
A: Three phases. Phase one was extraction: a Python script connected to the Postgres source DB and pulled all articles with their metadata into a JSON file per article, plus a manifest. Phase two was transformation: I normalized the body HTML (stripped React-specific markup, fixed image paths to point at the new WordPress media library), preserved the URL slug for SEO continuity, and mapped categories from the React schema to WordPress taxonomies. Phase three was load: I posted records in batches via the WordPress REST API, with retry on rate-limit and idempotency keyed on the original article ID.

Q: What broke during the migration and how did you handle it?
A: Image paths broke first. The React app served images via a CDN URL pattern WordPress did not understand, so the import wrote articles with broken image refs. I added a rewrite step in the transform phase. URL slugs with non-ASCII characters also broke; WordPress slug-sanitized them differently from React, so I had to pre-sanitize and add explicit redirects from the old slugs to the new sanitized ones to preserve SEO.

Q: Where did the 2.5x and 30x numbers come from?
A: 2.5x organic traffic was measured by the SEO and marketing teams over the months following the migration, comparing Google Search Console impressions and clicks. 30x page speed was Lighthouse score on representative pages, before and after. I did not generate those numbers personally; I trust the team's measurement. The page-speed gain came from SSR (WordPress renders HTML server-side, React was CSR), Yoast SEO emitting structured data, and Cloudflare plus Redis caching. The migration removed the React JS bundle from the critical render path entirely on these static pages.

Q: Did you architect this from scratch?
A: No. The decision to use WordPress was made above me. I owned the migration scripts and the API integration. I did contribute to deciding how to preserve URL slugs and how to handle redirects, which were the SEO-critical engineering calls.

---

## 3. Byju's AWS to GCP Cloud Migration

**Resume bullet (as written):** "Contributed to AWS-to-Google Cloud migration with cost/resource analytics dashboards, achieving $400K annual savings."

**Honesty caveat.** I did NOT architect the cloud migration. My contribution was specifically: monitoring pods on Kubernetes (Grafana, Loki), building container images and pushing to Artifact Registry for the migrated services, and running post-migration functional testing. The cost-savings target and the architectural decisions were made by the platform / infra leads. The work-experience source is explicit: "I did monitoring of pods on kubernetes, created container images for different microservices on google cloud, wrote functional testcases for post migration testing, did functional testing post migration".

### 5 Ws

- **What.** Migration of 5 plus core services (ogma, studio, photon, website, wordpress) from AWS to Google Cloud Platform, ending in $400K annual cost savings.
- **Why.** GCP offered better unit pricing for the workload mix, and the platform team wanted to consolidate monitoring under a single cloud.
- **How.** My piece had three parts. (1) Monitoring: I set up dashboards in Grafana and Loki for pod health, restart counts, error logs, and latency on the migrated services. (2) Image build: I built container images for each migrated service, tagged and published GitHub releases of the source repos, and pushed images to GCP Artifact Registry. (3) Functional testing: I wrote and executed post-migration test cases covering API correctness, data integrity (source vs destination), UI / UX smoke, authentication and authorization, and full business-workflow walks.
- **When.** During Byju's FTE, alongside the e-commerce portal work.
- **Who.** Platform and infra leadership owned the migration architecture, the cost model, and the cutover strategy. I owned my three pieces above. SRE owned alerting once dashboards were in place. Service owners owned their domain-specific test cases.

### Deep-dive prep

Q: Walk me through one of the dashboards you built.
A: Take the ogma (CMS) service. I built a Grafana dashboard against Loki for application logs and against the GKE Prometheus scrape for pod metrics. Panels included: pod-restart count by deployment, p95 and p99 request latency, error rate (4xx and 5xx), and a Loki panel showing the most-recent error logs filtered by severity. The dashboard was the on-call's first stop during the cutover window.

Q: How did you build the container images? What was in the Dockerfile?
A: For each service I worked from the team's existing Dockerfile (some services already had one for AWS, others I had to write from scratch). For Node.js services it was a multi-stage build: a builder stage running npm install and npm run build, then a slim runtime stage copying only the build artifacts and node_modules. WordPress was special because of the PHP runtime and the Apache config; I had to bake in the WP plugin set we depended on. I tagged each image with the GitHub release tag plus a short git SHA, pushed to Artifact Registry, and the platform team handled the GKE deployment via their CI.

Q: What did your post-migration functional testing actually catch?
A: A handful of authentication issues where JWT secrets had not been propagated to the new cluster, one data-integrity issue on the ogma side where a column default differed between the source MySQL and the destination MySQL, and several UI smoke failures from CDN cache settings differing between AWS CloudFront and GCP Cloud CDN.

Q: Where does the $400K number come from?
A: The platform team's cost model. I did not compute it myself; it came from their pre- and post-migration GCP versus AWS billing comparison after a few months of stable run on GCP. I trust the number, but it is not my number.

---

## 4. Byju's Scheduling Service 100 Percent Test Coverage

**Resume bullet (as written):** "Developed comprehensive unit tests for the Scheduling service backend, ensuring 100 percent code reliability and coverage."

**Honesty status.** Fully accurate. I wrote these tests, hit 100 percent line and branch coverage, and the technical depth is real. Less hedging needed. This is the strongest Byju's bullet to lead with on a phone screen.

### 5 Ws

- **What.** Brought the Scheduling service backend (tutor scheduling and class batch scheduling, Java Spring Boot) to 100 percent line and branch unit-test coverage.
- **Why.** The service had recurring regressions when async batch flows changed, and the existing partial coverage left the exception paths and edge cases untested. CI flake on the suite had also become a blocker for releases.
- **How.** I added JUnit plus Mockito tests covering every branch and every exception handler. For corner cases I wrote tests against empty inputs, null values, and boundary timestamps. For the asynchronous batch flow I used Mockito's doAnswer plus a CountDownLatch to deterministically wait for worker callbacks instead of using Thread.sleep, which was the source of CI flake. I mocked the database and downstream APIs so tests were hermetic. Two methods that were structurally untestable (mixed side-effect and pure logic) I refactored, splitting the side-effect into a wrapper and unit-testing the pure half directly.
- **When.** During Byju's FTE, on the Scheduling team.
- **Who.** I owned the testing work end to end. The on-call team gave feedback on which CI flakes were most painful so I could prioritize.

### Deep-dive prep

Q: What was the trickiest test you wrote?
A: The async batch-scheduling flow. The production code used a thread pool to dispatch batch-creation work, and the existing test was using Thread.sleep(2000) hoping the worker had finished. Sometimes it had, sometimes not, depending on CI load. I rewrote it using Mockito's doAnswer to capture the callback the worker would invoke on completion, paired with a CountDownLatch the test thread waited on. The test became deterministic, the flake disappeared, and the test ran in milliseconds instead of seconds.

Q: How do you handle 100 percent coverage on code that is not really testable as written?
A: You refactor. Two cases on Scheduling. One method was doing a database write and then computing the next-batch ID off the result; I split the DB write into a wrapper and unit-tested the next-batch-ID computation against a mocked write. Another method was a 200-line orchestration that grew over time; I extracted the validation logic into pure functions and tested those independently of the orchestration. The point is the tests forced the refactor, and the refactor made the code better.

Q: Did you actually catch any bugs while pushing for 100 percent?
A: Two latent bugs. One null-pointer in the exception handler that fired when a downstream returned an unexpected error format. One off-by-one in batch-boundary calculation that would have created an extra empty batch every Monday at midnight if no one had noticed. Both fixed before they hit prod.

Q: Coverage versus mutation testing -- do you trust line coverage?
A: Honestly, no. Line coverage tells you the line ran, not that the assertion meant anything. I have since learned about mutation testing tools like PIT for Java; if I redid this project, I would gate on mutation coverage, not just line coverage. Line coverage is a necessary but not sufficient signal.

---

## 5. Cloudify (TartanHacks 2026)

**Resume bullet status.** Anmol DID architect this end to end. Multi-agent OpenAI plus Claude orchestration for cloud migration assistance. TartanHacks 2026 entry.

### 5 Ws

- **What.** Cloudify is a multi-agent system that helps engineers migrate applications between cloud providers (e.g., AWS to GCP) by orchestrating a planner agent, a code-translation agent, and a verification agent over Dedalus, OpenAI, and Anthropic Claude APIs.
- **Why.** Cloud migrations are tedious because the work splits unevenly between high-judgment planning (which services map to what target services, what to refactor) and high-volume mechanical translation (rewriting IAM policies, updating SDK calls, adjusting Dockerfiles). Multi-agent orchestration lets each agent specialize.
- **How.** A Dedalus skill graph defines the agent topology: planner produces a migration plan, code-translation agents (parallelized per file) rewrite source code per the plan, and a verifier agent runs static checks plus a dry-run on the translated output. I implemented the skill-graph definition, the agent prompts, the OpenAI and Claude routing logic (which model handles which step based on cost and latency), and the verification harness. State passes between agents via a shared scratchpad object.
- **When.** Built during TartanHacks 2026.
- **Who.** I led the architecture and most of the implementation. Hackathon teammates contributed UI and demo-data scripting.

### Deep-dive prep

Q: Why multi-agent? Why not a single big prompt?
A: Single prompts blow up on long migration codebases because the model loses track of the plan when it is also doing per-file rewrites. Splitting plan from translation lets the planner produce a stable artifact (the plan) that translation agents reference but do not regenerate. It also lets me parallelize per-file translation, which a monolithic prompt cannot do.

Q: Why both OpenAI and Claude? Why not pick one?
A: Cost and capability split. OpenAI's GPT-4-class is faster and cheaper for the structured per-file translation step where I have a tight schema. Claude is stronger at the planner step where I need long-context reasoning over the whole repo and a good plan as the output. Routing is per-step, not per-call.

Q: What is Dedalus and why use it?
A: Dedalus is the skill-graph runtime we used. It lets you express agents as nodes, the data flow between them as edges, and execution semantics (parallel, retry, conditional) as graph metadata. Versus rolling my own orchestrator, Dedalus gave me retry and parallelism for free and made the topology declarative. I would have spent a day writing that machinery otherwise.

Q: What is the failure mode of this architecture?
A: Two big ones. First, plan drift: if the planner produces a vague plan, downstream translation agents fill in the gaps with their own assumptions and the translation diverges. I mitigate by structuring the plan as JSON with explicit per-file directives. Second, verifier under-coverage: a static-check verifier is much weaker than an actual integration test, so the system can ship a plausible-looking but broken translation. The next iteration would replace the verifier with a sandboxed dry-run against test fixtures.

---

## 6. Highmark Cancer Staging XGBoost

**Resume bullet status.** Active CMU project. XGBoost on 6M plus claims for cancer-stage prediction with NCCN encoding. Real ground truth.

### 5 Ws

- **What.** A cancer-stage prediction model trained on 6 million plus health-insurance claims from Highmark, predicting NCCN-aligned cancer stage at the patient level from claims-feature inputs.
- **Why.** Cancer stage at diagnosis is a strong driver of treatment cost and outcome, but is not a structured field on a claim. Stage is in chart notes, ICD codes hint at stage but inconsistently. Predicting stage from claims data lets the payer route care-management resources where they matter most.
- **How.** I encoded claims into NCCN-aligned features (cancer site, treatment-modality flags, biomarker signals, comorbidity bundles), engineered patient-trajectory features (sequencing of diagnoses and procedures over time), and trained an XGBoost classifier with stratified cross-validation. I tuned hyperparameters with Bayesian optimization and evaluated against a held-out test set. Class imbalance was handled with a combination of stratified sampling and scale_pos_weight tuning.
- **When.** Ongoing CMU MISM capstone-style project.
- **Who.** I lead the modeling. CMU faculty advise on methodology. Highmark provides the data and clinical-stage ground truth.

### Deep-dive prep

Q: Why XGBoost and not a deep model?
A: Three reasons. First, the feature representation is tabular plus engineered trajectory aggregates; deep models do not buy much over GBM on this kind of input. Second, XGBoost handles missing values natively, which matters because claims data has structural missingness (a procedure's absence is itself signal). Third, interpretability: payer use cases need feature-importance and per-prediction explanations, and XGBoost plus SHAP delivers that out of the box. A deep model would have been a research win but a deployment loss.

Q: How did you encode NCCN guidelines into features?
A: NCCN publishes stage-defining criteria per cancer site (e.g., for breast cancer: tumor size, lymph-node involvement, metastasis indicators each map to T, N, M categories). I built per-site feature templates that hunt for the procedure codes, ICD-10-CM codes, and biomarker test patterns NCCN cites as stage-defining. Then I aggregated those features per patient with windowing logic, e.g., "any T3-suggesting procedure within 90 days of the index diagnosis date".

Q: What is your held-out evaluation strategy?
A: Patient-level stratified split, not claim-level. Splitting at the claim level would leak the same patient across train and test. I stratified on cancer site and on stage to keep class balance comparable across folds.

Q: What is the failure mode?
A: Stage drift over time. The NCCN criteria evolve, and historical data was coded against older NCCN versions. I mitigate by versioning my feature templates against NCCN release year and only training on claims whose service date matches the version. This caps the training set and is a real cost.

---

## 7. EEG Classification (CMU 11-685)

**Resume bullet status.** Real ground truth. Multi-head CNN plus Transformer for EEG classification, plus a Task 2 CLIP-style retrieval head with 6 loss-function variants. Trained on PSC Bridges-2 HPC.

### 5 Ws

- **What.** A neural architecture that classifies EEG (electroencephalography) trials and, in a separate task, retrieves matching visual stimuli from EEG signal via a CLIP-style contrastive embedding. Built for CMU 11-685 (Intro to Deep Learning).
- **Why.** EEG signal is high-dimensional and low signal-to-noise. Classical ML over hand-engineered EEG features caps out below where end-to-end deep architectures can go. The Task 2 CLIP-style retrieval addresses brain-decoding: given an EEG trial, recover what stimulus the subject saw.
- **How.** Task 1 is a classifier with a multi-head CNN front-end (parallel convolutional branches at different temporal resolutions to capture both fast and slow EEG dynamics) feeding a Transformer encoder for temporal aggregation and a classification head. Task 2 keeps the same EEG encoder, adds a vision encoder for the stimulus image, and trains a contrastive objective so EEG and image embeddings of paired (trial, stimulus) pairs land close in shared space. I trained six loss-function variants for Task 2 (InfoNCE, supervised contrastive, NT-Xent with different temperature schedules, triplet, and two custom variants) to find the best retrieval Recall at K. Training ran on PSC Bridges-2, with Slurm job scripts, multi-GPU data-parallel via PyTorch DDP.
- **When.** Spring 2026 semester at CMU.
- **Who.** Solo project (per course rules). Course staff provided dataset access, baseline performance targets, and Slurm allocation guidance.

### Deep-dive prep

Q: Why a multi-head CNN front-end? Why not a single conv stack?
A: EEG dynamics live at multiple temporal scales: gamma-band oscillations are 30-80 Hz, alpha is 8-12 Hz, theta is 4-8 Hz, delta is below 4 Hz. A single conv stack with one receptive-field size compromises across these. The multi-head design has parallel branches with different kernel sizes and dilations, each tuned for one band. Their outputs concatenate before the Transformer.

Q: Why a Transformer on top? Why not just more conv?
A: After the conv front-end, we have a sequence of time-step embeddings. The Transformer captures long-range dependencies across the trial (e.g., a pre-stimulus baseline shift that predicts the post-stimulus response). Conv layers can do this in principle with deep stacks, but the Transformer is more parameter-efficient at this length.

Q: Walk me through the six loss variants for the retrieval task.
A: Variant 1: standard InfoNCE with a fixed temperature. Variant 2: supervised contrastive (Khosla et al., 2020) using class labels as supervision. Variant 3: NT-Xent with a learned temperature parameter. Variant 4: NT-Xent with a cosine-annealed temperature schedule. Variant 5: triplet loss with semi-hard negative mining. Variant 6: a custom hybrid that combines InfoNCE on EEG-to-image direction with supervised contrastive on image-to-image direction within the batch. I evaluated on Recall at 1, Recall at 5, and Recall at 10. The cosine-annealed NT-Xent and the custom hybrid were the top performers; the supervised contrastive variant was strong on R at 10 but weaker on R at 1.

Q: Slurm job scripts -- what did your training pipeline look like?
A: Each Slurm job requested 2 to 4 V100 or A100 GPUs depending on availability, 32 to 64 GB CPU memory, and a 12 to 24 hour wall-clock window. The job script set up the conda env, exported the right CUDA module, and launched torchrun with the DDP-aware training entry. Checkpoints went to the project's PSC scratch space, with a sync step to permanent storage every N epochs. I had a separate eval-job template that picked the best checkpoint by validation metric and ran the held-out test set.

Q: Failure modes?
A: Two. First, EEG subject-shift: training on subjects 1 to 80 and testing on subjects 81 to 100 dropped accuracy noticeably; the encoder over-fits to per-subject electrode-impedance patterns. Subject-aware normalization and per-subject calibration in fine-tuning would help. Second, the retrieval task's batch size sensitivity: contrastive losses scale with batch size (more negatives), and at PSC's per-GPU memory ceiling I capped at 256 effective batch size, which is below the literature's 1024 plus. Gradient accumulation plus memory bank (MoCo-style) would address this.

---

## How to use this template before an interview

1. Read the relevant entries above out loud, with a stopwatch. Cap each story at 2 minutes 30 seconds.
2. Have a partner or a recording app probe with the deep-dive Q's. Watch for places you stumble or invent.
3. If you stumble on a Q, return to the work-experience source file and re-ground the answer in real detail. Do not paper over the gap.
4. Update `career-ops/interview-prep/story-bank.md` after each interview with anything new you learned about how to tell the story.
