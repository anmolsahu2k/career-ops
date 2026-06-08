# Design: Pivot career-ops intern → full-time (new-grad) search + separate FT dashboard

**Date:** 2026-06-05
**Status:** Approved design, pre-implementation
**Supersedes:** STATUS.md outstanding action #3

## 1. Context & goal

The career-ops workspace is configured end-to-end for a Summer-2026 **internship** search. That search is concluded (Tabhi internship accepted). The owner graduates Dec 2026 and now wants the system pivoted to a **full-time / new-grad** search targeting a **Jan 2027** start, with a **separate dashboard** so the FT funnel is tracked independently of the frozen intern history.

Goal: stand up an FT search that reuses the existing engine and dashboard binary, keeps the ~2,086-row intern tracker frozen as an archive, and routes all new FT activity (scan, eval, tracker, reports, gmail reconciliation) into a parallel `ft/` data subtree — without commingling.

## 2. Decisions (locked with user)

1. **Data model:** FT applications live in a new separate tracker `ft/data/applications.md` (identical 9-column schema). The intern tracker `data/applications.md` is **frozen** — read-only archive.
2. **Dashboard:** reuse the existing Go binary via its `--path` flag: `dashboard --path ft`. No path-resolution Go changes (the `--path` plumbing already honors this).
3. **`ft/` scope:** holds only the FT tracker, `ft/reports/`, and `ft/batch/` staging. The engine (scan/merge/verify/aggregator scripts + the `/career-ops` skill) stays shared at root.
4. **Engine targeting:** a single env var **`CAREER_OPS_DATA_DIR`** (default `ft`) read by every path-bearing engine script. `CAREER_OPS_DATA_DIR=.` reaches the intern archive for one-off historical tasks. Replaces the rejected "scatter `ft/` hardcodes across 7 files" approach.
5. **FT timing/framing:** target Jan 2027 start, new-grad / "2026 New Grad" / "Class of 2027" / entry-level. Visa framing CPT → OPT + H-1B sponsorship; "Available January 2027" if a start date is asked.
6. **Cover-letter generation in dashboard:** **removed.** The `u` keybinding and all dashboard-side cover-letter generation code are deleted. Cover letters are produced only on explicit user request (Rule 4 trigger a). This removes the need to de-intern the Go prompt.
7. **Config pivot in place at root** (git preserves the prior intern config): CLAUDE.md, profile.yml, portals.yml, modes, discovery_filters.py, aggregator-intake.py, INDEX.md.

## 3. Non-goals / out of scope (unchanged hard rules)

- No CV PDF generation (Rule 2).
- No tracker schema change — still exactly 9 columns (Rule: dashboard breaks on a 10th).
- No commits/pushes without explicit ask.
- No schedules/cron (Rule 6) — everything stays user-triggered.
- Intern tracker + intern reports are never written to by FT runs.
- Sponsorship filtering is **not** added at the discovery/title-scan stage (no data there — see §5.D); it moves to the per-URL eval stage.

## 4. Architecture

### 4.1 `ft/` subtree
```
ft/
  data/applications.md        # 9-col header + |---| separator row, zero data rows to start
  reports/                    # FT eval reports + cover letters, {company-slug}/{NN}-{role-slug}-{date}.md
  batch/
    tracker-additions/        # FT pipeline staging (mirrors root batch/)
    status-flips/
```
Root `data/` and `reports/` are untouched and remain the intern archive.

### 4.2 `CAREER_OPS_DATA_DIR` resolver (the heart of the change)
A shared path helper, one per language, imported by every engine script so the resolution logic lives in exactly one place (no drift):

- **JS** `lib/paths.mjs` exporting `resolveTarget(importMetaUrl)` →
  `target = join(<repo-root>, process.env.CAREER_OPS_DATA_DIR || 'ft')`, plus `appsFile`, `reportsDir`, `batchDir(sub)` getters.
- **Python** `scripts/_paths.py` exporting `target_dir()` / `apps_file()` / `reports_dir()` / `batch_dir()` reading `os.environ.get('CAREER_OPS_DATA_DIR', 'ft')`.

Every script replaces its hardcoded `data/applications.md`, `reports/`, `batch/...` joins with calls into the helper. Default `ft` means all new runs land in `ft/`; `CAREER_OPS_DATA_DIR=.` restores the root archive path for the one-time historical gmail sweep.

The dashboard binary is launched with `--path ft` (it does not read the env var); the engine reads the env var. Both point at the same `ft/` tree.

### 4.3 Dashboard
- FT view: `dashboard --path ft` → reads `ft/data/applications.md`, writes nothing back except status edits (which now target `ft/`).
- Intern archive view: `dashboard --path .` still works for browsing the 2,086 rows.
- `u` keybinding and cover-letter generation: removed (see §5.C).

## 5. Detailed changes (punch list)

### A. New `ft/` scaffold
- Create `ft/data/applications.md` with the **column header row AND the `|---|` separator row** (merge-tracker.mjs inserts after the separator; without it, inserts are silently dropped; dashboard exits if the file is missing entirely).
- Create `ft/reports/.gitkeep`, `ft/batch/tracker-additions/.gitkeep`, `ft/batch/status-flips/.gitkeep`.

### B. Engine path resolver (`CAREER_OPS_DATA_DIR`)
Wire the resolver into every path-bearing script. Verified hardcoded sites:

| File | What to repoint |
|---|---|
| `merge-tracker.mjs` (~26-31) | `APPS_FILE`, `ADDITIONS_DIR`, `MERGED_DIR` |
| `verify-pipeline.mjs` (~21-30) | apps file, `reports/`, `batch/`, `templates/states.yml` (states.yml stays shared at root — read from root, not target) |
| `discovery_filters.py` (~31-35) | `APPS_FILE`, `REPORTS_DIR`, `BATCH_DIR` |
| `aggregator-intake.py` (~49-51) | `DATA_DIR` (inherits discovery_filters constants) |
| `reorg-reports-by-company.py` (~32-34) | `REPORTS` (only if reorg is run on `ft/reports/`) |
| `scan.mjs` (~30-33) | bare cwd-relative `data/...` and `portals.yml` → anchor to root + target; `portals.yml` read from **root** (shared config), scan-results TSV written to **target** |
| `scan-spa.mjs` (~35-38) | same as scan.mjs |
| `check-liveness.mjs` | inspect path idiom; repoint apps-file reads/writes to target |

Note: `portals.yml`, `templates/states.yml`, `config/profile.yml`, `cv.md` are **shared config read from root**, never from `ft/`. Only data/reports/batch are target-relative.

### C. Dashboard `u`-key + cover-letter generation removal (Go)
- `dashboard/internal/ui/screens/pipeline.go`: remove `case "u"` (~411) and the `coverLetterGenerating` state machine (~150-163, 411-426); remove `PipelineGenerateCoverLetterMsg` (~51-54).
- `dashboard/main.go`: remove the `claude -p` shell-out handler for cover-letter generation and `coverLetterGenTimeout`.
- `dashboard/internal/data/cover_letter.go`: remove `BuildCoverLetterPrompt` (~99) and `GenerateCoverLetter` (~146). **Retain** `Slugify`, `CoverLetterPath`, `FindExistingCoverLetter`, `resumeHint` **only if still referenced** by report/Notes enrichment after removal; otherwise remove them too.
- `dashboard/internal/data/cover_letter_test.go`: drop tests for the removed functions; keep tests for any retained helpers.
- Rebuild the binary; `go test ./...` green.

### D. `discovery_filters.py` gate rewrite (not a token swap)
- `role_matches_targets()` (~313-349): the `if not _INTERN_TOKEN_RE.search(role): return False` gate (~319) must change from an **intern gate** to a **new-grad/entry-level gate** (match new grad / new graduate / entry level / university grad / early career / associate SWE, plus the existing target role families minus "intern").
- `SEASON_DENY_RE` (~109, used ~298): currently denies "2027" seasons — **collides with "Class of 2027" FT framing.** Remove/relax the 2027 denial; keep denying clearly-past seasons.
- `_INTERN_TOKEN_RE` (~301-310): repurpose or replace for the new-grad gate.
- `_normalize_role()` (~401): it already strips "new grad"/"early career" as dedup noise — fine, leave.
- **Sponsorship:** do **not** add a discovery-stage sponsorship-negative filter — the row dict at filter time carries only `title, company, url, location, is_remote, age_days`; sponsorship lives in the JD body fetched at eval time. Instead: (1) the per-URL eval agent weighs OPT/H-1B viability (was F-1/CPT); (2) optional cheap title-keyword guard for explicit "US Citizen"/"Security Clearance" in titles.

### E. gmail-sweep routing
- `gmail-sweep-merge.mjs` (~21-25): replace hardcoded absolute `ROOT`/`APPS_FILE`/`ADDITIONS_DIR`/`FLIPS_DIR` with the resolver (default `ft`).
- `apply-status-flips.mjs` (~22-24): same.
- `gmail-sweep.py` (~161): `--out-dir` default → target-relative.
- `modes/gmail-sweep.md`: update path references + intern framing.
- **Operating model:** ongoing FT confirmation/rejection emails reconcile into `ft/` by default. The one-time historical intern-rejection backlog (STATUS outstanding #4) is run once with `CAREER_OPS_DATA_DIR=.` against the frozen archive.

### F. Aggregator sources
- `aggregator-intake.py` `SOURCES` (~70-117): hardcoded list of intern repos. Swap intern repos (speedyapply/Summer2026-Internships, vanshb03/Summer2027-Internships, jobright-ai/2026-*-Internship, SimplifyJobs/Summer2026-Internships) for FT/new-grad/H-1B repos (e.g. speedyapply/2026-SWE-College-Jobs new-grad section, jobright-ai/Daily-H1B-Jobs-In-Tech, SimplifyJobs/New-Grad-Positions). Confirm each parser's column assumptions against the new repo table shapes (~321).

### G. Config + docs pivot (in place at root)
- **CLAUDE.md:** Rule 5 target roles (intern → new-grad/FT); Rule 3 framing (CPT/Heinz/OIE → OPT + H-1B sponsorship; "Available January 2027"); Rule 4 — **remove trigger (b)** (the `u` press) and the "Dashboard `u` keybinding (cover letter)" section; workflow step 9 `u`-reference; "Career-Ops layout" + "Workflow when surfacing new candidates" note the `ft/` target and `CAREER_OPS_DATA_DIR`.
- **config/profile.yml:** not just `internship_constraints` — also the North Star comment (~15), `target_range` (~67), `visa_status` CPT line (~76), `internship_priority_companies` (~88). Convert to FT constraints (full-time comp expectations, OPT/H-1B, new-grad priority companies).
- **portals.yml:** `search_queries` ("intern Summer 2026" → "new grad 2027" / "entry-level SWE" / "2026 new grad") **and** any `must_match` / `title_filter` regex that encodes the intern gate.
- **modes/_profile.md** + **modes/*.md:** scrub intern phrasing; new-grad archetypes.
- **INDEX.md:** header (~3) "Summer 2026 internship search ops" + profile description + intern links → FT.
- After profile edits: run `cv-sync-check`.
- **STATUS.md:** flip outstanding #3 → done; record FT state. (STATUS.md is gitignored — not git-recoverable, so edit carefully.)
- **CHANGELOG.md:** per-turn entry capturing the pivot (memory rule).
- **.claude/skills/career-ops/SKILL.md:** already modified in working tree — ensure its scan/eval/merge paths and report-write path resolve to the `ft/` target and that eval reports still write the `**URL:**` header (dashboard O-key depends on it).

## 6. Bootstrap & ordering

1. Scaffold `ft/` (§5.A) — must exist before anything writes to it or the dashboard is pointed at it.
2. Add the shared resolvers `lib/paths.mjs` + `scripts/_paths.py` (§4.2).
3. Wire resolver into engine scripts (§5.B, §5.E, §5.F).
4. discovery_filters gate rewrite (§5.D).
5. Go dashboard `u`-removal + rebuild (§5.C).
6. Config/docs pivot (§5.G).
7. Verify (§7), then STATUS/CHANGELOG.

## 7. Verification plan

- `ft/data/applications.md` present with header + `|---|` separator → `dashboard --path ft` launches with zero rows, no crash.
- Dry-run engine with `CAREER_OPS_DATA_DIR=ft`: a crafted FT scan-result flows scan → filter → eval-stub → `merge-tracker.mjs` and lands a row in **`ft/data/applications.md`**, never root. Confirm root `data/applications.md` byte-unchanged (diff against a pre-run copy).
- `node verify-pipeline.mjs` (with `CAREER_OPS_DATA_DIR=ft`) → 0 errors on the FT tracker.
- `CAREER_OPS_DATA_DIR=.` round-trip: gmail-sweep historical run still targets the intern archive correctly.
- `go test ./...` green after `u`-removal; `go build` produces a working binary; `dashboard --path .` still opens the intern archive.
- discovery_filters: a "2026 New Grad Software Engineer (Class of 2027 start)" title now passes the gate and is NOT season-denied; an "intern" title is no longer auto-accepted as on-target.

## 8. Rollback

- All root config edits are git-tracked → revert via git. (STATUS.md is gitignored — keep a manual backup before editing.)
- `ft/` is additive — deleting the directory + reverting the resolver wiring fully undoes the FT side.
- Intern archive is never written by FT runs, so corruption risk is bounded by the §7 byte-unchanged check.

## 9. Accepted risks / open items

- **Cover-letter generation convenience lost** in the dashboard (by decision) — letters now only via explicit `/career-ops` request.
- **Sponsorship signal is eval-stage only** — discovery cannot pre-filter no-sponsorship roles; some will reach eval and be scored down there.
- **Aggregator parser shapes** for the new FT repos may need per-source column tweaks discovered during implementation.
- **`claude -p` cwd** is moot now that generation is removed.
