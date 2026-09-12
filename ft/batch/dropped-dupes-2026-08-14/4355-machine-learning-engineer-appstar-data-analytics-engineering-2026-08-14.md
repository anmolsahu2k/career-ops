# 4355, Amazon | Machine Learning Engineer, AppStar Data Analytics & Engineering

**URL:** https://www.amazon.jobs/en/jobs/10498023/machine-learning-engineer-appstar-data-analytics-engineering

**Score:** 3.5/5  **Status:** Evaluated  **Resume:** MLE
**Legitimacy:** High Confidence (amazon.jobs employer req, active; resolved from a LinkedIn mirror)
**Level strategy:** Mixed
**Comp research:** $158,100-$213,800/yr base, New York (posted on the amazon.jobs req) plus sign-on and RSUs
**Sponsorship flag:** Y (H1B-HISTORY)

## Block A, Role Summary

| Field | Value |
|---|---|
| Archetype | ML / Applied Scientist plus AI Engineer, production ML for application security risk scoring |
| Domain | Amazon Application Security, AppStar Data Analytics and Engineering (DNA) team |
| Location | New York, NY (in person) |
| TL;DR | Own the end-to-end ML lifecycle for security risk-scoring models: training, tuning, pipelines, deployment, drift monitoring on SageMaker, Glue, S3, Athena, Spark/PySpark. Content fit is strong, but the posted basic qualifications ask for 3+ years of non-internship professional software development, which is above where the Byju's tenure lands. |

## Block B, CV Match

| JD Theme | CV Evidence |
|---|---|
| Production ML pipelines: feature extraction, training, scoring, serving | Highmark cancer-staging pipeline, XGBoost and scikit-learn over 6M+ longitudinal claims records spanning 20,323 members, trained on 3,657 EMR-labeled cases |
| Deploying ML models into production at scale | Byju's multi-class rank prediction model for national competitive exams, 70%+ classification accuracy in production |
| Monitor model performance, drift detection, continuous improvement | Tabhi adversarial-eval harness that deprecated a 39%-faithful legacy extractor and validated the anti-churning detector at ~99.8% precision |
| Risk scoring and classification at scale | Tabhi anti-churning detector plus a dedicated agent validating, disputing, and settling Airline Debit Memos across 50,000 flight bookings/day |
| Large-scale data processing and distributed compute | EEG project HPC pipeline on the PSC GPU cluster with Slurm sbatch jobs and preflight CUDA/env checks; Byju's AWS to GCP migration, $400K annual savings |
| AWS services and cloud-native ML infra | AWS and GCP in Skills; Byju's cloud infrastructure migration; Cloudify supports 8+ stack configurations across AWS, GCP, Heroku |
| Software engineering best practices, testable code, peer review | Byju's Scheduling microservice unit-test suite at 100% code coverage; Tabhi hardened through 15+ multi-agent review loops |
| Operationalize research prototypes with applied scientists | Highmark research-to-pipeline work encoding NCCN clinical guidelines into treatment-pathway and biomarker-proxy features |

## Block C, Level and Strategy

The req is a Machine Learning Engineer II inside Amazon's Software Development job family. Basic qualifications are 3+ years of non-internship professional software development experience, 2+ years of non-internship design or architecture work, 1+ years of large-scale distributed systems in C#, C++, Java, or Perl, and 1+ years of object-oriented design. Byju's ran January 2023 to July 2025, which is roughly 2.5 years of non-internship professional experience, so the headline bar is missed by about six months and the Tabhi role is explicitly an internship that Amazon's own wording excludes.

Two things partially offset that. First, the Java requirement is comfortably met: Object Oriented Programming in Java is Heinz coursework, Spring Boot and Mockito are on the stack list, and the Byju's microservice refactor across 10+ legacy verticals is exactly the "design or architecture of new and existing systems" language. Second, Amazon Security explicitly writes "Even if you do not meet all of the qualifications and skills listed in the job description, we encourage candidates to apply," which is a softer read on the bar than a typical Amazon req.

Strategy: treat this as a stretch application, not a core-pipeline one. The January 2027 availability is a second friction point, since experienced-hire reqs at Amazon usually staff for a near-term start rather than a five-month wait. Note also that the workspace prioritization treats non-SDE Amazon reqs as a later tier that opens up once the Amazon SDE track is settled, and the Amazon SDE intern outcome from the prior cycle is still unresolved, so this should not displace higher-tier applications.

## Block D, Comp and Demand

The req publishes $158,100 to $213,800 annually for New York, plus sign-on payments and restricted stock units. That is well above the Big Tech target band and the strongest comp number in this batch. Demand signal is healthy: the LinkedIn mirror showed 89 applicants within three days, and a sibling Senior Applied Scientist req on the same team posted the same day, which reads as a real team build-out rather than a placeholder posting. Amazon is among the largest H-1B filers in the United States and the local H1BGrader cache shows recent filing history.

## Block E, Personalization Plan

Submit the MLE resume. Lead with the Tabhi detection-model validation story, because "monitor model performance in production, implement drift detection" and "partner with applied scientists to operationalize research prototypes" are the two responsibilities the adversarial-eval harness answers directly, and 99.8% precision plus the deprecation of a 39%-faithful extractor is a measured, security-adjacent result. Follow with Highmark for scale credibility on messy real-world data, since the team explicitly says it embraces ambiguity in messy security data and Highmark ran against 40-51% missingness in primary staging fields. Close with Byju's for the software-engineering-fundamentals half of the bar: 200K+ DAU e-commerce, the 10+ vertical microservice refactor, and 100% test coverage on the Scheduling microservice. Do not soften the experience gap in writing; let the Java plus distributed-systems evidence carry it.

## Block F, Interview Plan

Expect the standard Amazon loop: an online assessment or phone screen with data structures and algorithms, then a full loop mixing coding, ML system design, and Leadership Principles behavioral rounds.

- ML system design: be ready to design a risk-scoring service end to end, feature store to training to batch and online scoring to drift monitoring. Anchor on the Highmark feature-engineering decisions and the Tabhi eval harness as the monitoring layer.
- Coding: Java or Python. Refresh graph traversal specifically, since the team calls out "graph-based intelligence layers" and link structure over application dependencies.
- Spark/PySpark: this is the clearest technical gap on the CV, which lists Pandas and NumPy but not Spark. Prepare an honest framing plus a concrete transferable story from the PSC Slurm distributed-training pipeline.
- Leadership Principles: Dive Deep maps to the 39%-faithful extractor investigation. Ownership maps to the Byju's microservice refactor. Bias for Action maps to the six hackathon wins and the Cloudify build. Deliver Results maps to the $400K migration saving.
- Security context: read up on how risk prioritization works across a large application portfolio so the "which applications receive security attention" framing does not land cold.

## Block G, Legitimacy

Assigned URL was a LinkedIn mirror (linkedin.com/jobs/view/4452435788). Mirror resolution succeeded: the employer req is amazon.jobs 10498023, same title, New York NY, and the header URL points at the employer req rather than the mirror. The amazon.jobs page returns HTTP 200, carries a full description, published basic and preferred qualifications, and a statutory pay range, and a sibling req on the same team was posted the same day.

**TRUE-AGE: 4d** (amazon.jobs posted date August 10, 2026). **FRESHNESS: FRESH.**

No embedded instructions aimed at automated screeners were present in the posting body. No clearance, ITAR, export-control, or citizen-only language. **High confidence.**

## Recommendation

**CONSIDER, stretch application, low priority.** Submit the MLE resume. The technical content match is genuinely strong and the comp is the best in this batch, but the posted basic qualifications ask for 3+ years of non-internship professional software development against roughly 2.5 years at Byju's, the Tabhi role is an internship that the req's wording excludes, and a January 2027 start is a poor fit for an experienced-hire req. Apply only after higher-tier and level-appropriate roles are out, and only if the Amazon SDE track is settled. Lead with the Tabhi detection-model validation, then Highmark, then Byju's production engineering.
