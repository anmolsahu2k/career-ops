# Eval Report Template

Canonical header structure for files under `career-ops/reports/{NNN}-{slug}-{date}.md`.

## Why this template exists

Three workstream needs collide in the report header:

1. The Go TUI dashboard parses each report when the user hits `O` (open URL). Its regex is:
   ```
   ^\*\*URL:\*\*\s*(https?://\S+)
   ```
   Any drift on the `**URL:**` line silently breaks the dashboard.
2. The career-ops contract (see `career-ops/CLAUDE.md` section 3.5 / Pipeline Integrity) requires `**URL:**` and `**Legitimacy:**` to live in the header. Stale `**Apply:**` lines from earlier reports are artifacts and must not be re-introduced.
3. Workstream W11 adds three forward-planning fields so every applied role carries level strategy, comp expectations, and a sponsorship signal.

## Hard rules (do not violate)

- Keep `**URL:**` on its own line, exactly as `**URL:** {single-url}` with no trailing characters. The dashboard regex `^\*\*URL:\*\*\s*(https?://\S+)` must continue to match.
- Do not add `**Apply:**` lines. The URL field is canonical.
- No em-dashes or en-dashes anywhere in the report (rule 1, project CLAUDE.md). Use hyphens, commas, periods, colons.
- Do not embed F-1, CPT, Heinz, OIE, May 12, or June 1 explainers anywhere in the report (rule 3).
- Do not generate or reference a CV PDF artifact you produced; the user submits their own SDE or MLE PDF (rule 2).

## Canonical header (paste-ready)

```
# {NNN}, {Company} | {Role}

**URL:** {single canonical apply URL}

**Score:** {X.X}/5  **Status:** {canonical status from templates/states.yml}  **Resume:** {SDE|MLE}
**Legitimacy:** {High Confidence | Medium | Low} ({source, e.g. Greenhouse, active})
**Level strategy:** {Intern-only | Intern + new-grad | Mixed}
**Comp research:** {salary range, e.g. "$9k-$12k/mo (Levels.fyi)" or "unknown"}
**Sponsorship flag:** {Y | N | Unknown}

## Block A, Role Summary
...
```

## Field semantics

| Field | Allowed values | Notes |
|---|---|---|
| `**URL:**` | exactly one `https://` URL | Dashboard O-key regex parses this; do not add prefix labels, do not add a second URL on the same line. |
| `**Score:**` | `X.X/5` (e.g. `4.4/5`) | Two spaces separate `Score`, `Status`, `Resume` on one line. |
| `**Status:**` | canonical state from `templates/states.yml` (Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP) | No bold around the state value, no dates, no extra text. |
| `**Resume:**` | `SDE` or `MLE` | SDE for SWE/backend/infra/platform roles, MLE for AI/ML/DS/applied-scientist roles. |
| `**Legitimacy:**` | `High Confidence`, `Medium`, `Low`, optionally with parenthetical source | Source examples: `(Greenhouse, active)`, `(Lever, active)`, `(careers page only, unverified)`. |
| `**Level strategy:**` | `Intern-only`, `Intern + new-grad`, `Mixed` | Whether the JD or job family covers other levels. Mixed = posting groups multiple seniorities. |
| `**Comp research:**` | salary range with source, or `unknown` | Prefer Levels.fyi monthly intern band, then Glassdoor, then peer-company triangulation. Note source in parens. |
| `**Sponsorship flag:**` | `Y`, `N`, `Unknown` | Y if JD says sponsorship-friendly OR company is on a known F-1-friendly list. N if explicit "no sponsorship / no visa support". Unknown otherwise. |

## Sponsorship flag heuristics

- **Y signals:** "sponsors H-1B / OPT / CPT", "open to international candidates", company is on the H-1B sponsor list (myvisajobs.com top employers), prior interns from international universities visible on LinkedIn.
- **N signals:** "must be authorized to work without sponsorship now or in the future", "no sponsorship available", "US citizens or green card holders only" (with no separate intern carve-out).
- **Unknown signals:** silent JD, ambiguous "must be authorized to work in the US" (interns on CPT may qualify), small startup with no visible sponsorship history.

## Fully-worked example

```
# 021, Nuro | Software Engineer, AI Platform - Intern

**URL:** https://nuro.ai/careersitem?gh_jid=7351061

**Score:** 4.4/5  **Status:** Evaluated  **Resume:** SDE
**Legitimacy:** High Confidence (Greenhouse, active)
**Level strategy:** Intern-only
**Comp research:** $9k-$12k/mo (Levels.fyi autonomy peer comps; Nuro intern band not directly listed, triangulated from Cruise/Zoox/Waymo intern pay)
**Sponsorship flag:** Unknown

## Block A, Role Summary

| Field | Value |
|---|---|
| Archetype | SWE Intern, ML Platform / AI infrastructure |
| Domain | Nuro autonomy stack (autonomous delivery, robotics platform) |
| Location | Mountain View, CA (in-person) |
| TL;DR | AI platform / infrastructure engineering at autonomy company. Multi-agent LLM orchestration (Cloudify) plus Byju's microservices is a direct fit for ML platform infra work. |

## Block B, CV Match

| JD Theme | CV Evidence |
|---|---|
| ML platform / infrastructure engineering | Cloudify multi-agent skill graph (Dedalus + OpenAI + Claude); Byju's 10+ vertical microservice refactor |
| Distributed systems | $400K AWS to GCP migration delivering production stability |
| Production engineering at scale | Byju's: 200K+ DAU e-commerce, 100% test coverage Scheduling microservice |
| Applied ML pipelines | Highmark XGBoost on 6M+ claims, multimodal stock prediction |

## Block G, Legitimacy

Greenhouse, active. Nuro is well-funded (Series D+). **High confidence.**

## Recommendation

**Apply within 48 hours.** Submit SDE resume. Lead with Cloudify (agent orchestration) plus Byju's microservices (production scale). ML Platform infra is a great fit for the production-engineering-at-scale narrative.
```

## Verification

After editing any report, run:

```bash
cd career-ops && node verify-pipeline.mjs
```

It must exit 0. The dashboard O-key regex must continue to match the `**URL:**` line. To sanity-check the regex locally:

```bash
grep -nP '^\*\*URL:\*\*\s*(https?://\S+)' reports/{NNN}-{slug}-{date}.md
```

A single match with the URL captured means the contract holds.

## What NOT to add to the header

- `**Apply:**` lines (artifact from older reports; only `**URL:**` is canonical).
- F-1 / CPT / Heinz / OIE / start-date explainers (project CLAUDE.md rule 3).
- Em-dashes (`U+2014`) or en-dashes (`U+2013`).
- A second URL on the `**URL:**` line.
- Bold formatting on the `**Status:**` value (e.g. `**Status:** **Applied**` is wrong; the verifier's "No bold in scores/statuses" check trips on it).

## Related references

- `career-ops/CLAUDE.md` -- Pipeline Integrity rules (URL header mandatory, canonical states, etc.).
- `career-ops/templates/states.yml` -- canonical status enum.
- `career-ops/verify-pipeline.mjs` -- the linter you must keep green.
- `career-ops/dashboard/` -- Go TUI consuming the 9-col tracker and the report URL line.
