# Eval Report Template

Canonical header structure for files under `career-ops/reports/{company-slug}/{NN}-{role-slug}-{date}.md`.

## Why this template exists

Three workstream needs collide in the report header:

1. The Go TUI dashboard parses each report when the user hits `O` (open URL). Its regex is:
   ```
   ^\*\*URL:\*\*\s*(https?://\S+)
   ```
   Any drift on the `**URL:**` line silently breaks the dashboard.
2. The career-ops contract (see `career-ops/CLAUDE.md` section 3.5 / Pipeline Integrity) requires `**URL:**` and `**Legitimacy:**` to live in the header. Stale `**Apply:**` lines from earlier reports are artifacts and must not be re-introduced.
3. Three forward-planning fields make every applied role carry a level strategy, comp expectations, and a sponsorship signal.

## Hard rules (do not violate)

- **Full Block A-G body, always.** Every eval report contains all seven blocks (A Role Summary, B CV Match, C Level and Strategy, D Comp and Demand, E Personalization Plan, F Interview Plan, G Posting Legitimacy) per `modes/offer.md`. The compact wave format (Block A + Fit + Recommendation) is retired as of 2026-07-27; no eval path, including mass backlog/aggregator waves, may write it. Block H (application answers) remains on-explicit-request only (CLAUDE.md Rule 4).
- Keep `**URL:**` on its own line, exactly as `**URL:** {single-url}` with no trailing characters. The dashboard regex `^\*\*URL:\*\*\s*(https?://\S+)` must continue to match.
- Do not add `**Apply:**` lines. The URL field is canonical.
- No em-dashes or en-dashes anywhere in the report (rule 1, project CLAUDE.md). Use hyphens, commas, periods, colons.
- Do not embed F-1, OPT, H-1B, Heinz, or OIE explainers anywhere in the report (rule 3). The sponsorship signal lives in the `**Sponsorship flag:**` field only.
- Do not generate or reference a CV PDF artifact you produced; the user submits their own SDE or MLE PDF (rule 2).

## Canonical header (paste-ready)

```
# {NNN}, {Company} | {Role}

**URL:** {single canonical apply URL}

**Score:** {X.X}/5  **Status:** {canonical status from templates/states.yml}  **Resume:** {SDE|MLE}
**Legitimacy:** {High Confidence | Medium | Low} ({source, e.g. Greenhouse, active})
**Level strategy:** {New-grad-only | New-grad + experienced | Mixed}
**Comp research:** {salary range, e.g. "$150k-$180k/yr (Levels.fyi)" or "unknown"}
**Sponsorship flag:** {Y | N | Unknown}

## Block A, Role Summary
...
## Block B, CV Match
...
## Block C, Level and Strategy
...
## Block D, Comp and Demand
...
## Block E, Personalization Plan
...
## Block F, Interview Plan
...
## Block G, Legitimacy
...
## Recommendation
...
```

## Field semantics

| Field | Allowed values | Notes |
|---|---|---|
| `**URL:**` | exactly one `https://` URL | Dashboard O-key regex parses this; do not add prefix labels, do not add a second URL on the same line. |
| `**Score:**` | `X.X/5` (e.g. `4.4/5`) | Two spaces separate `Score`, `Status`, `Resume` on one line. |
| `**Status:**` | canonical state from `templates/states.yml` (Evaluated, Applied, Responded, Interview, Offer, Rejected, Rejected-at-eval, Purged, SKIP) | No bold around the state value, no dates, no extra text. An eval that lands on DO NOT APPLY writes **`Rejected-at-eval`**, never `Discarded` — `Discarded` is reserved for the user's own d-key call. |
| `**Resume:**` | `SDE` or `MLE` | SDE for SWE/backend/infra/platform roles, MLE for AI/ML/DS/applied-scientist roles. |
| `**Legitimacy:**` | `High Confidence`, `Medium`, `Low`, optionally with parenthetical source | Source examples: `(Greenhouse, active)`, `(Lever, active)`, `(careers page only, unverified)`. |
| `**Level strategy:**` | `New-grad-only`, `New-grad + experienced`, `Mixed` | Whether the JD or job family covers other levels. Mixed = posting groups multiple seniorities. |
| `**Comp research:**` | salary range with source, or `unknown` | Prefer Levels.fyi annual new-grad band, then Glassdoor, then peer-company triangulation. Note source in parens. |
| `**Sponsorship flag:**` | `Y`, `N`, `Unknown` | Y if JD is sponsorship-friendly OR the company has H-1B filing history. N if explicit "no sponsorship / no visa support" or citizen-only. Unknown otherwise. Optionally tag the driver in Notes: `VISA-SPONSORSHIP`, `CITIZEN-ONLY`, `H1B-HISTORY`. |

## Sponsorship flag heuristics

Evaluate through the OPT / H-1B lens: Anmol works on OPT after the December 2026 graduation, and will need H-1B sponsorship in the future. There is no CPT carve-out on a full-time req, so an ambiguous "must be authorized to work" is NOT auto-safe the way it was in the intern cycle; it needs an OPT/H-1B read.

- **Y signals (`VISA-SPONSORSHIP` / `H1B-HISTORY`):** "sponsors H-1B", "open to international candidates", company has H-1B filing history (H1BGrader or myvisajobs.com), prior hires from international universities visible on LinkedIn.
- **N signals (`CITIZEN-ONLY`):** "must be authorized to work without sponsorship now or in the future", "no sponsorship available", "US citizens or green card holders only", roles gated by security clearance / ITAR / export-control.
- **Unknown signals:** silent JD, ambiguous "must be authorized to work in the US" (needs an OPT/H-1B evaluation, no CPT carve-out for full-time), small startup with no visible H-1B history. When in doubt, check H1BGrader for the company's filing history before flagging.

## Fully-worked example

The example below is abbreviated to the header-relevant blocks (A, B, G). Real reports contain the full Block A-G body per the hard rule above.

```
# 021, Nuro | Software Engineer, New Grad (AI Platform)

**URL:** https://nuro.ai/careersitem?gh_jid=7351061

**Score:** 4.4/5  **Status:** Evaluated  **Resume:** SDE
**Legitimacy:** High Confidence (Greenhouse, active)
**Level strategy:** New-grad-only
**Comp research:** $150k-$180k/yr base (Levels.fyi autonomy peer comps; Nuro new-grad band not directly listed, triangulated from Cruise/Zoox/Waymo new-grad pay)
**Sponsorship flag:** Y (H1B-HISTORY; Nuro has prior H-1B filings on H1BGrader)

## Block A, Role Summary

| Field | Value |
|---|---|
| Archetype | New-grad SWE, ML Platform / AI infrastructure |
| Domain | Nuro autonomy stack (autonomous delivery, robotics platform) |
| Location | Mountain View, CA (in person) |
| TL;DR | AI platform / infrastructure engineering at an autonomy company. Multi-agent LLM orchestration (Cloudify) plus Byju's microservices is a direct fit for ML platform infra work. Dec 2026 grad, available January 2027. |

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

**Apply within 48 hours.** Submit SDE resume. Lead with Cloudify (agent orchestration) plus Byju's microservices (production scale). ML Platform infra is a great fit for the production-engineering-at-scale narrative. Sponsorship-safe: H-1B filing history on record.
```

## Verification

After editing any report, run:

```bash
cd career-ops && node verify-pipeline.mjs
```

It must exit 0. The dashboard O-key regex must continue to match the `**URL:**` line. To sanity-check the regex locally:

```bash
grep -nP '^\*\*URL:\*\*\s*(https?://\S+)' reports/{company-slug}/{NN}-{role-slug}-{date}.md
```

A single match with the URL captured means the contract holds.

## What NOT to add to the header

- `**Apply:**` lines (artifact from older reports; only `**URL:**` is canonical).
- F-1 / OPT / H-1B / Heinz / OIE / start-date explainers (project CLAUDE.md rule 3).
- Em-dashes (`U+2014`) or en-dashes (`U+2013`).
- A second URL on the `**URL:**` line.
- Bold formatting on the `**Status:**` value (e.g. `**Status:** **Applied**` is wrong; the verifier's "No bold in scores/statuses" check trips on it).

## Related references

- `career-ops/CLAUDE.md` -- Pipeline Integrity rules (URL header mandatory, canonical states, etc.).
- `career-ops/templates/states.yml` -- canonical status enum.
- `career-ops/verify-pipeline.mjs` -- the linter you must keep green.
- `career-ops/dashboard/` -- Go TUI consuming the 9-col tracker and the report URL line.
