# 4356, Snap | Software Engineer, ML Infrastructure, Level 4

**URL:** https://snapchat.wd1.myworkdayjobs.com/en-US/snap/job/Los-Angeles-California/Software-Engineer--ML-Infrastructure--Level-4_R0045604

**Score:** 4.4/5  **Status:** Evaluated  **Resume:** SDE
**Legitimacy:** High Confidence (Snap Workday tenant, active, canApply true)
**Level strategy:** New-grad + experienced
**Comp research:** $157,000-$235,000/yr base Zone A (CA, WA, NYC), $149,000-$223,000 Zone B, $133,000-$200,000 Zone C, plus RSUs (published in the req)
**Sponsorship flag:** Y (H1B-HISTORY)

## Block A, Role Summary

| Field | Value |
|---|---|
| Archetype | Software Engineer, ML Platform and Infrastructure, with a heavy AI Engineer / agent overlay |
| Domain | Snap ML Platform Experience team inside the core ML Platform organization, building the agentic user experience for building, managing, and operating foundational models at Snapchat |
| Location | Los Angeles, CA primary; also Palo Alto, CA and Bellevue, WA. Default Together policy, 4+ days per week in office |
| TL;DR | The single best archetype match in this batch. The team is explicitly AI native, builds agents on ADK, langfuse, and frontier LLM models, and owns model lineage, model orchestration, and model data quality. That is a near one-to-one restatement of the Tabhi agentic QC platform, sitting on top of ML infrastructure work that the Byju's production record covers. Qualification path is satisfied through Bachelor's plus 2+ years post-Bachelor's. |

## Block B, CV Match

| JD Theme | CV Evidence |
|---|---|
| AI native team building agents on frontier LLM models | Tabhi autonomous multi-agent system processing 50,000 flight bookings/day via permission-bounded control loops; Cloudify multi-agent platform on OpenAI and Anthropic Claude APIs via Dedalus SDK |
| Model lineage, model orchestration, model data quality | Tabhi governance layer with hash-chained audit ledger and kill-switches, plus a verifiability layer whose adversarial-eval harness deprecated a 39%-faithful legacy extractor and validated the detector at ~99.8% precision |
| Strong programming skills in Python, Java | Python and Java both first-class on the CV: Byju's Spring Boot and Mockito work, Heinz Object Oriented Programming in Java, Python across Highmark, EEG, and Tabhi |
| Feature generation and serving pipelines for online inferencing and offline training data | Highmark feature pipeline over 6M+ longitudinal claims with NCCN treatment-pathway encoding, biomarker proxies, and procedure-code clustering |
| High-performance inference systems, fast and efficient model serving | Tabhi LLM infrastructure work: PII-safe context pipelines, intelligent model routing, just-in-time cache-to-live retrieval, RAG over fine-tuned models, with measured inference-cost reduction |
| Infrastructure for scalable ML training, evaluation, and inference in the cloud | EEG project HPC pipeline on the PSC GPU cluster: Slurm sbatch jobs, preflight CUDA and env checks, one-command job-status dashboard for distributed training |
| Distributed systems and infrastructure components of large-scale ML | Byju's microservice refactor across 10+ legacy verticals into a unified horizontal topology; AWS to GCP migration delivering $400K annual savings |
| Proven track record of operating highly-available systems at significant scale | Byju's e-commerce portal serving 200,000+ daily users, sales cost down 15%, ARPU up 20%; Byju's DRM e-book viewer securing content for 400K+ paid subscribers |
| Rigorous standards for code correctness and production-ready quality | Byju's Scheduling microservice unit-test suite at 100% code coverage; Tabhi hardened through 15+ multi-agent review loops |
| ML frameworks (PyTorch, scikit-learn) preferred | PyTorch on the EEG multi-head CNN plus Transformer across 26,000 trials; XGBoost and scikit-learn on Highmark |
| Big data frameworks: Spark, Flink, or Ray | Gap. Pandas, NumPy, and SQL at scale are on the CV; no Spark, Flink, or Ray. Closest transferable evidence is the Slurm distributed-training pipeline and the 6M+ record claims processing |

## Block C, Level and Strategy

Snap Level 4 is the step above the entry level, and the minimum qualifications offer three parallel paths: Bachelor's plus 2+ years of post-Bachelor's software development, or Master's plus 1+ year of post-graduate software development, or a PhD. The first path is satisfied cleanly: B.Tech from VIT completed May 2023, then January 2023 to July 2025 at Byju's, which is roughly 2.5 years of post-Bachelor's professional software development. The Master's path is not the one to lead with, because the Byju's tenure predates the Heinz program.

The req also asks for experience building large-scale production machine learning systems, distributed systems, or big data processing. That is an "or" list, and both the distributed-systems clause (Byju's microservice topology, AWS to GCP migration) and the production ML clause (Byju's rank prediction model in production, Highmark pipeline) are answerable.

Strategy: apply at the posted level rather than looking for a separate new-grad req. The posting is a single level but is not new-grad-only, so the framing should be the industry-tested engineer angle rather than the student angle. Position the Heinz degree as the applied-ML bridge, not as the primary credential.

The one real strategic consideration is the Default Together policy: 4+ days per week in office at Los Angeles, Palo Alto, or Bellevue. That is a full relocation with no remote fallback, which the location policy accepts but should be entered with eyes open.

## Block D, Comp and Demand

The req publishes the full zone structure: $157,000 to $235,000 base in Zone A (CA, WA, NYC), $149,000 to $223,000 in Zone B, $133,000 to $200,000 in Zone C, all with RSU eligibility. Every listed location for this req sits in Zone A, so the operative band is $157,000 to $235,000. That clears the Big Tech target band at the bottom of the range, before equity. This is a strong comp outcome even at the low end.

Demand signal is solid. ML Platform and ML Infrastructure hiring is one of the more durable segments of the current market, and Snap framing the team as AI native with agentic tooling suggests an active build-out rather than backfill. Snap has recent H-1B filing history in the local H1BGrader cache.

## Block E, Personalization Plan

Submit the SDE resume. The title, the level, and the responsibility list are infrastructure and systems work, so the SDE PDF is the right base, and the AI content still lands because the Tabhi bullets appear on it.

Open with the Tabhi agentic QC platform, because the JD's own framing (agentic user experience for building, managing, and operating foundational models, plus model lineage, orchestration, and data quality) is the closest match in this entire batch to work already shipped: permission-bounded control loops, an event-driven architecture, a hash-chained audit ledger, kill-switches, and an adversarial-eval harness. Model data quality on their side is the eval harness on ours.

Second, use the model-routing and cache-to-live retrieval work to answer "develop high-performance inference systems," which the req lists twice and therefore clearly cares about.

Third, close on Byju's for the scale and reliability bar: 200,000+ DAU, the 10+ vertical microservice refactor, and 100% test coverage.

Do not overclaim on Spark, Flink, or Ray. Name the gap once, pair it with the PSC Slurm HPC pipeline and the 6M+ record processing, and move on.

## Block F, Interview Plan

- Recruiter screen, then a technical phone screen, then an onsite loop that typically mixes coding, systems design, and a team-fit round.
- Coding: Python primary, Java as backup, matching the team's stated language mix. Standard data structures and algorithms.
- ML infrastructure design: prepare a feature store design (offline training generation plus online serving, point-in-time correctness, skew between training and serving) and a model-serving design (batching, caching, autoscaling, latency budget). Both are directly on the responsibility list.
- Agentic systems depth: this is the differentiating round. Be ready to walk through the Tabhi control-loop design, how permissions were bounded, how the kill-switch worked, how the hash-chained ledger made runs auditable, and how the adversarial-eval harness caught the 39%-faithful extractor. Expect follow-ups on evaluation methodology since the team owns model data quality.
- Distributed data processing: refresh Spark fundamentals (partitioning, shuffles, broadcast joins) even without production Spark on the CV, because it is called out explicitly in the skills list.
- Culture: Snap emphasizes moving fast with precision and privacy at the forefront. The PII-safe context pipeline work at Tabhi is the natural answer to the privacy prompt.
- Have a clear answer ready on relocation and on the 4+ days per week in-office expectation.

## Block G, Legitimacy

Snap's own Workday tenant (snapchat.wd1.myworkdayjobs.com), fetched directly from the tenant JSON endpoint. The record returns canApply true and posted true, carries a full structured description, three named office locations, and a statutory pay range across three zones. Requisition R0045604. Snap Inc is a publicly traded company. There is no aggregator or mirror in the chain.

**TRUE-AGE: 3d** (Workday startDate 2026-08-11, postedOn "Posted 3 Days Ago"). **FRESHNESS: FRESH.**

No embedded instructions aimed at automated screeners were present in the posting body. No clearance, ITAR, export-control, or citizen-only language. **High confidence.**

## Recommendation

**APPLY within 48 hours.** Submit the SDE resume. This is the strongest role in the batch: the ML Platform Experience team's charter (agentic tooling over foundational models, model lineage, orchestration, and data quality) restates the Tabhi platform almost line for line, the ML infrastructure half is covered by the Byju's production record, the qualification path is satisfied through Bachelor's plus 2+ years, comp clears the target band before equity, and the posting is three days old on Snap's own Workday tenant. Lead with Tabhi, follow with the inference and model-routing work, close with Byju's scale. Name the Spark, Flink, and Ray gap once and pair it with the PSC Slurm pipeline. Budget for relocation to Los Angeles, Palo Alto, or Bellevue with a 4+ day in-office expectation.
