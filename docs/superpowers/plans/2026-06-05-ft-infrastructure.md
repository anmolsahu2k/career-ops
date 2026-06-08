# FT Infrastructure Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `ft/` data subtree and make the entire engine + dashboard target it by default, so all new full-time-search activity lands in `ft/` while the intern tracker at root stays a frozen, byte-unchanged archive.

**Architecture:** A single env var `CAREER_OPS_DATA_DIR` (default `ft`, validated against traversal/absolute escape) is read by two tiny shared resolvers (`lib/paths.mjs`, `scripts/_paths.py`) that locate the repo root and return target-relative data/reports/batch paths while keeping shared config (portals.yml, states.yml, cv.md) root-relative. EVERY path-bearing engine script is rewired through the resolver (a grep-guard in the final task proves none was missed). The Go dashboard is pointed at `ft/` with its existing `--path` flag; its cover-letter generation (`u` key) is removed wholesale.

**Tech Stack:** Node ESM (.mjs), Python 3 (pathlib), Go (bubbletea TUI). No new dependencies.

**Scope note:** Plan 1 of 2. Plan 2 (FT search semantics: discovery-filter gate rewrite, portals/profile/CLAUDE.md role framing, aggregator source swap) builds on this. Spec: [docs/superpowers/specs/2026-06-05-ft-pivot-and-dashboard-design.md](../specs/2026-06-05-ft-pivot-and-dashboard-design.md).

**Commit policy (per spec line 27 — "No commits/pushes without explicit ask"):** Each task ends with an **optional checkpoint**. Do NOT commit or push automatically. Only commit when the user explicitly approves, and never `git push`. The `git` commands shown are the suggested checkpoint content if/when the user says to commit; treat them as inert otherwise.

---

## File Structure

**Created:** `lib/paths.mjs` (+ `lib/paths.test.mjs`), `scripts/_paths.py` (+ `scripts/test_paths.py`), `ft/data/applications.md`, `ft/reports/.gitkeep`, `ft/batch/tracker-additions/.gitkeep`, `ft/batch/status-flips/.gitkeep`

**Modified — path rewiring (14 scripts):**
- *cwd-relative:* `scan.mjs`, `scan-spa.mjs`
- *`import.meta.url`-relative JS:* `merge-tracker.mjs`, `verify-pipeline.mjs`, `dedup-tracker.mjs`, `normalize-statuses.mjs`, `analyze-patterns.mjs`, `followup-cadence.mjs`, `liveness-parallel.mjs`
- *absolute-`ROOT` JS:* `scripts/gmail-sweep-merge.mjs`, `scripts/apply-status-flips.mjs`, `scripts/split-tsv-for-merge.mjs`
- *Python:* `scripts/discovery_filters.py`, `scripts/aggregator-intake.py`, `scripts/prune-by-liveness.py`, `scripts/reorg-reports-by-company.py`, `scripts/split-sweep-batches.py`, `scripts/gmail-sweep.py` (`jobspy-ingest.py` inherits `discovery_filters` — no edit)

**Guarded (deprecated):** `gemini-eval.mjs` (Gemini/CV-PDF chain, Rule 2 — refuses to run by default)

**Out of scope:** `check-liveness.mjs` (takes URLs, not tracker paths — no rewiring needed)

**Dashboard `u`-removal:** Modify `dashboard/main.go`, `dashboard/internal/ui/screens/pipeline.go`, `dashboard/internal/ui/screens/pipeline_test.go`; Delete `dashboard/internal/data/cover_letter.go`, `dashboard/internal/data/cover_letter_test.go`; Edit `CLAUDE.md` (Rule 4, `u` section, workflow step 9).

---

## The transform recipe (referenced by Tasks 4-9)

Most scripts share one of two idioms. The recipe:

**JS (`import.meta.url`-relative or absolute `ROOT`):** add `import { resolvePaths } from '<rel>/lib/paths.mjs';`, create `const P = resolvePaths(import.meta.url);`, then replace each hardcoded path:
- `<root>/data/applications.md` → `P.appsFile`
- `<root>/data/<x>` → `join(P.dataDir, '<x>')`
- `<root>/reports` → `P.reportsDir`
- `<root>/batch/tracker-additions` → `P.batchDir('tracker-additions')`
- `<root>/batch/status-flips` → `P.batchDir('status-flips')`
- `mkdirSync(<root>/data, …)` → `mkdirSync(P.dataDir, …)`
- shared config (`portals.yml`, `templates/states.yml`, `cv.md`, `modes/…`, `.claude/…`) → keep at `P.root`

`<rel>` is `./lib/paths.mjs` for root-level scripts, `../lib/paths.mjs` for scripts in `scripts/`.

**Python:** `import _paths; _P = _paths.resolve_paths(__file__)`, then `apps_file → _P["apps_file"]`, `reports_dir → _P["reports_dir"]`, `batch_dir → _P["batch_dir"]`, `data_dir → _P["data_dir"]`, shared config → `_P["root"]`. If invoked outside `scripts/`, prepend `import sys; from pathlib import Path; sys.path.insert(0, str(Path(__file__).resolve().parent))`.

**CRITICAL — tracker report-link resolution:** A report link pulled OUT of a tracker row (regex like `\(([^)]+\.md)\)` → yields `reports/<slug>/<file>.md`) is relative to the tracker's SUBTREE root, not the reports dir. Resolve it with `join(P.target, link)` (JS) / `_P["target"] / link` (Python) — **NOT** `P.reportsDir` (that double-nests to `ft/reports/reports/...`) and **NOT** `P.root` (that reads the intern archive). Add `const TARGET_ROOT = P.target;` / `TARGET_ROOT = _P["target"]` wherever a script reads report files by their tracker link. Only use `P.reportsDir` when constructing a fresh report path from scratch.

---

## Task 1: Scaffold the `ft/` subtree

**Files:** Create `ft/data/applications.md`, `ft/reports/.gitkeep`, `ft/batch/tracker-additions/.gitkeep`, `ft/batch/status-flips/.gitkeep`

- [ ] **Step 1: Create dirs + gitkeeps**
```bash
mkdir -p ft/data ft/reports ft/batch/tracker-additions ft/batch/status-flips
touch ft/reports/.gitkeep ft/batch/tracker-additions/.gitkeep ft/batch/status-flips/.gitkeep
```

- [ ] **Step 2: Create the empty FT tracker (header + REQUIRED separator row)**

Write `ft/data/applications.md` (the `|---|` row is mandatory — `merge-tracker.mjs` splices new rows after it):
```markdown
# Full-Time / New-Grad Applications

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
```

- [ ] **Step 3: Verify dashboard launches against the empty FT tracker**
```bash
cd dashboard && go build -o /tmp/career-dash . && cd ..
/tmp/career-dash --path ft   # opens with 0 rows, no crash; press q
```

- [ ] **Step 4: Checkpoint (optional, with user approval)** — `git add ft/`

---

## Task 2: JS path resolver `lib/paths.mjs` (with traversal guard)

**Files:** Create `lib/paths.mjs`, Test `lib/paths.test.mjs`

- [ ] **Step 1: Write the failing test**

`lib/paths.test.mjs`:
```javascript
import assert from 'node:assert';
import { test } from 'node:test';
import { resolvePaths } from './paths.mjs';

test('defaults to ft when env unset or empty', () => {
  delete process.env.CAREER_OPS_DATA_DIR;
  let p = resolvePaths(import.meta.url);
  assert.ok(p.root.endsWith('career-ops'), `root was ${p.root}`);
  assert.ok(p.appsFile.endsWith('ft/data/applications.md'), p.appsFile);
  process.env.CAREER_OPS_DATA_DIR = '';   // set-but-empty must NOT resolve to root archive
  p = resolvePaths(import.meta.url);
  assert.ok(p.appsFile.endsWith('ft/data/applications.md'), `empty-env: ${p.appsFile}`);
  delete process.env.CAREER_OPS_DATA_DIR;
  assert.ok(p.reportsDir.endsWith('ft/reports'), p.reportsDir);
  assert.ok(p.batchDir('tracker-additions').endsWith('ft/batch/tracker-additions'), p.batchDir('tracker-additions'));
  assert.ok(p.portalsFile.endsWith('career-ops/portals.yml'), p.portalsFile);
});

test('CAREER_OPS_DATA_DIR=. targets the root archive', () => {
  process.env.CAREER_OPS_DATA_DIR = '.';
  const p = resolvePaths(import.meta.url);
  assert.ok(p.appsFile.endsWith('career-ops/data/applications.md'), p.appsFile);
  delete process.env.CAREER_OPS_DATA_DIR;
});

test('rejects absolute and traversal targets', () => {
  for (const bad of ['/etc', '../evil', 'ft/../..']) {
    process.env.CAREER_OPS_DATA_DIR = bad;
    assert.throws(() => resolvePaths(import.meta.url), /CAREER_OPS_DATA_DIR/, `should reject ${bad}`);
  }
  delete process.env.CAREER_OPS_DATA_DIR;
});
```

- [ ] **Step 2: Run to confirm it fails** — `node --test lib/paths.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Implement `lib/paths.mjs`**
```javascript
// lib/paths.mjs — single source of truth for engine data paths.
// CAREER_OPS_DATA_DIR (default 'ft') selects the target subtree under repo root.
// Shared config (portals.yml, states.yml, cv.md) always resolves to repo root.
import { existsSync } from 'fs';
import { dirname, join, isAbsolute, relative } from 'path';
import { fileURLToPath } from 'url';

function findRepoRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'CLAUDE.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('career-ops repo root (CLAUDE.md) not found from ' + startDir);
    dir = parent;
  }
}

export function resolvePaths(callerUrl) {
  const root = findRepoRoot(dirname(fileURLToPath(callerUrl)));
  const targetName = process.env.CAREER_OPS_DATA_DIR || 'ft';
  // Guard: only '.' or a repo-relative subpath that stays under root.
  if (isAbsolute(targetName) || targetName.split(/[\\/]/).includes('..')) {
    throw new Error(`CAREER_OPS_DATA_DIR must be '.' or a repo-relative subpath, got: ${targetName}`);
  }
  const target = join(root, targetName);
  if (relative(root, target).startsWith('..')) {
    throw new Error(`CAREER_OPS_DATA_DIR escapes repo root: ${targetName}`);
  }
  return {
    root,
    target,
    dataDir: join(target, 'data'),
    appsFile: join(target, 'data', 'applications.md'),
    reportsDir: join(target, 'reports'),
    batchDir: (sub = '') => join(target, 'batch', sub),
    portalsFile: join(root, 'portals.yml'),
    statesFile: join(root, 'templates', 'states.yml'),
  };
}
```

- [ ] **Step 4: Run the test** — `node --test lib/paths.test.mjs` → PASS (3/3).

- [ ] **Step 5: Checkpoint (optional)** — `git add lib/paths.mjs lib/paths.test.mjs`

---

## Task 3: Python path resolver `scripts/_paths.py` (with traversal guard)

**Files:** Create `scripts/_paths.py`, Test `scripts/test_paths.py`

- [ ] **Step 1: Write the failing test**

`scripts/test_paths.py`:
```python
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths  # noqa: E402


def test_default_is_ft():
    os.environ.pop("CAREER_OPS_DATA_DIR", None)
    p = _paths.resolve_paths(__file__)
    assert p["root"].name == "career-ops", p["root"]
    assert str(p["apps_file"]).endswith("ft/data/applications.md"), p["apps_file"]
    assert str(p["portals_file"]).endswith("career-ops/portals.yml"), p["portals_file"]


def test_dot_targets_root_archive():
    os.environ["CAREER_OPS_DATA_DIR"] = "."
    p = _paths.resolve_paths(__file__)
    assert str(p["apps_file"]).endswith("career-ops/data/applications.md"), p["apps_file"]
    os.environ.pop("CAREER_OPS_DATA_DIR", None)


def test_rejects_absolute_and_traversal():
    for bad in ["/etc", "../evil", "ft/../.."]:
        os.environ["CAREER_OPS_DATA_DIR"] = bad
        try:
            _paths.resolve_paths(__file__)
            assert False, f"should reject {bad}"
        except ValueError:
            pass
    os.environ.pop("CAREER_OPS_DATA_DIR", None)


def test_empty_env_defaults_to_ft():
    os.environ["CAREER_OPS_DATA_DIR"] = ""   # set-but-empty must NOT resolve to root archive
    p = _paths.resolve_paths(__file__)
    assert str(p["apps_file"]).endswith("ft/data/applications.md"), p["apps_file"]
    os.environ.pop("CAREER_OPS_DATA_DIR", None)


if __name__ == "__main__":
    test_default_is_ft(); test_dot_targets_root_archive()
    test_rejects_absolute_and_traversal(); test_empty_env_defaults_to_ft()
    print("ok")
```

- [ ] **Step 2: Run to confirm it fails** — `python3 scripts/test_paths.py` → `ModuleNotFoundError`.

- [ ] **Step 3: Implement `scripts/_paths.py`**
```python
"""Single source of truth for engine data paths (Python side).

CAREER_OPS_DATA_DIR (default 'ft') selects the target subtree under repo root.
Shared config (portals.yml, states.yml, cv.md) always resolves to repo root.
"""
import os
from pathlib import Path


def _find_repo_root(start: Path) -> Path:
    d = start.resolve()
    while True:
        if (d / "CLAUDE.md").exists():
            return d
        if d.parent == d:
            raise RuntimeError(f"career-ops repo root (CLAUDE.md) not found from {start}")
        d = d.parent


def resolve_paths(caller_file: str) -> dict:
    root = _find_repo_root(Path(caller_file).parent)
    # `or "ft"` (not get(..., "ft")) so a set-but-EMPTY env var still defaults to
    # ft and never silently resolves to the root archive (JS uses `|| 'ft'`).
    target_name = os.environ.get("CAREER_OPS_DATA_DIR") or "ft"
    # Guard: only '.' or a repo-relative subpath that stays under root.
    if os.path.isabs(target_name) or ".." in Path(target_name).parts:
        raise ValueError(f"CAREER_OPS_DATA_DIR must be '.' or a repo-relative subpath, got: {target_name}")
    target = (root / target_name).resolve()
    if root not in target.parents and target != root:
        raise ValueError(f"CAREER_OPS_DATA_DIR escapes repo root: {target_name}")
    return {
        "root": root,
        "target": target,
        "data_dir": target / "data",
        "apps_file": target / "data" / "applications.md",
        "reports_dir": target / "reports",
        "batch_dir": target / "batch" / "tracker-additions",
        "portals_file": root / "portals.yml",
        "states_file": root / "templates" / "states.yml",
    }
```

- [ ] **Step 4: Run the test** — `python3 scripts/test_paths.py` → prints `ok`.

- [ ] **Step 5: Checkpoint (optional)** — `git add scripts/_paths.py scripts/test_paths.py`

---

## Task 4: Rewire `merge-tracker.mjs`

**Files:** Modify `merge-tracker.mjs:26-31` (+ the `mkdirSync` near line 37)

- [ ] **Step 1: Apply the JS recipe.** Replace the constant block:
```javascript
const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
```
with:
```javascript
import { resolvePaths } from './lib/paths.mjs';
const P = resolvePaths(import.meta.url);
const CAREER_OPS = P.root;          // portals.yml read via join(CAREER_OPS,'portals.yml') stays root — correct
const APPS_FILE = P.appsFile;
const ADDITIONS_DIR = P.batchDir('tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
```
Also change `mkdirSync(join(CAREER_OPS, 'data'), …)` → `mkdirSync(P.dataDir, …)`. Confirm the only remaining `join(CAREER_OPS, …)` uses are `portals.yml` (shared, correct).

- [ ] **Step 2: Verify default targets ft/** — `node merge-tracker.mjs --dry-run` → `📊 Existing: 0 entries` (empty FT tracker), NOT ~2,086.

- [ ] **Step 3: Verify archive escape hatch** — `CAREER_OPS_DATA_DIR=. node merge-tracker.mjs --dry-run` → prints ~2,086.

- [ ] **Step 4: Checkpoint (optional)** — `git add merge-tracker.mjs`

---

## Task 5: Rewire `verify-pipeline.mjs` (report links resolve against TARGET, not root)

**Files:** Modify `verify-pipeline.mjs:21-34` AND the four `CAREER_OPS` uses at `:134, :216, :266, :280`

The subtlety Codex caught: report links like `reports/...` in `ft/data/applications.md` are relative to the TARGET subtree, but `portals.yml` is shared at root. Keep both roots distinct.

- [ ] **Step 1: Replace the constant block**
```javascript
import { resolvePaths } from './lib/paths.mjs';
const P = resolvePaths(import.meta.url);
const REPO_ROOT = P.root;       // shared config (portals.yml, templates/states.yml)
const TARGET_ROOT = P.target;   // report-link resolution base
const APPS_FILE = P.appsFile;
const ADDITIONS_DIR = P.batchDir('tracker-additions');
const REPORTS_DIR = P.reportsDir;
const STATES_FILE = P.statesFile;

mkdirSync(P.dataDir, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });
```

- [ ] **Step 2: Fix the four downstream `CAREER_OPS` sites**

Read lines 134, 216, 266, 280. For each: if it resolves a tracker **report link** (e.g. `join(CAREER_OPS, match[1])` where `match[1]` is `reports/...`), change to `join(TARGET_ROOT, match[1])`. If it reads **shared config** (`portals.yml` / `templates/...`), change to `REPO_ROOT`. Grep after editing to be sure no bare `CAREER_OPS` identifier remains:
```bash
grep -n "CAREER_OPS" verify-pipeline.mjs   # expect: none (replaced by REPO_ROOT / TARGET_ROOT)
```

- [ ] **Step 3: Verify** — `node verify-pipeline.mjs` → 0 errors on the empty FT tracker; must not report on intern rows.

- [ ] **Step 4: Checkpoint (optional)** — `git add verify-pipeline.mjs`

---

## Task 6: Rewire `scan.mjs` + `scan-spa.mjs`

**Files:** Modify `scan.mjs:24-36`, `scan-spa.mjs:32-40`

- [ ] **Step 1: `scan.mjs`** — replace the four bare constants + `mkdirSync('data', …)`:
```javascript
import { join } from 'path';
import { resolvePaths } from './lib/paths.mjs';
const P = resolvePaths(import.meta.url);
const PORTALS_PATH = P.portalsFile;                            // shared root config
const SCAN_HISTORY_PATH = join(P.dataDir, 'scan-history.tsv');
const APPLICATIONS_PATH = P.appsFile;
const SCAN_RESULTS_PATH = (date) => join(P.dataDir, `scan-results-${date}.tsv`);
mkdirSync(P.dataDir, { recursive: true });
```
(Add `import { join }` only if not already imported.)

- [ ] **Step 2: `scan-spa.mjs`** — identical four constants + `mkdirSync('data', …)`; apply the same replacement.

- [ ] **Step 3: Verify** — `node scan.mjs --dry-run --company Cohere 2>&1 | head` → no path errors; any scan-results path is under `ft/data/`.

- [ ] **Step 4: Checkpoint (optional)** — `git add scan.mjs scan-spa.mjs`

---

## Task 7: Rewire the remaining `import.meta.url`-relative JS scripts

**Files:** `dedup-tracker.mjs:16-24`, `normalize-statuses.mjs:18-26`, `analyze-patterns.mjs:18-22`, `followup-cadence.mjs:18-22`, `liveness-parallel.mjs:29-33`

All five resolve paths from `dirname(fileURLToPath(import.meta.url))`. Apply the JS recipe per file.

- [ ] **Step 1: `dedup-tracker.mjs`** — replace the `CAREER_OPS`/`APPS_FILE` block (16-22) with `const P = resolvePaths(import.meta.url); const APPS_FILE = P.appsFile;` (+ `import { resolvePaths } from './lib/paths.mjs';`), and `mkdirSync(join(CAREER_OPS,'data'),…)` (24) → `mkdirSync(P.dataDir,…)`.

- [ ] **Step 2: `normalize-statuses.mjs`** — same block (18-26), same replacement.

- [ ] **Step 3: `analyze-patterns.mjs`** — block (18-22) defines `APPS_FILE` + `REPORTS_DIR`; replace with `P.appsFile` / `P.reportsDir`, and add `const TARGET_ROOT = P.target;`. **Then fix the tracker-link read at line 224**: `const reportPath = reportMatch ? join(CAREER_OPS, reportMatch[1]) : null;` → `join(TARGET_ROOT, reportMatch[1])`. (Read-only script; routing it to ft/ means analytics reflect the FT funnel — intended.)

- [ ] **Step 4: `followup-cadence.mjs`** — block (18-22) defines `APPS_FILE` + `FOLLOWUPS_FILE = join(CAREER_OPS,'data/follow-ups.md')`; replace with `P.appsFile` and `join(P.dataDir,'follow-ups.md')`, and add `const TARGET_ROOT = P.target;`. **Then fix the tracker-link read at line 151**: `const fullPath = join(CAREER_OPS, match[1]);` → `join(TARGET_ROOT, match[1])`.

- [ ] **Step 5: `liveness-parallel.mjs`** — `HERE = dirname(...)` (29), `join(HERE,'batch/tracker-additions')` (33), and the tracker-link read `join(HERE, rp)` at line 51 where `rp` is already `reports/...`. Add `const P = resolvePaths(import.meta.url);`, replace `join(HERE,'batch/tracker-additions')` → `P.batchDir('tracker-additions')`, and **`join(HERE, rp)` → `join(P.target, rp)`** (NOT `P.reportsDir` — `rp` already contains the `reports/` prefix). Drop `HERE` if no longer used.

- [ ] **Step 6: Smoke each (read-only)**
```bash
node analyze-patterns.mjs 2>&1 | head -3        # operates on 0-row ft tracker, no crash
node followup-cadence.mjs 2>&1 | head -3
node dedup-tracker.mjs --dry-run 2>&1 | head -3  # if it has a dry flag; else inspect output path only
node normalize-statuses.mjs --dry-run 2>&1 | head -3
```
Expected: all reference `ft/` paths / 0 rows; none touch root.

- [ ] **Step 7: Checkpoint (optional)** — `git add dedup-tracker.mjs normalize-statuses.mjs analyze-patterns.mjs followup-cadence.mjs liveness-parallel.mjs`

---

## Task 8: Rewire the absolute-`ROOT` JS scripts (incl. the dangling-ROOT fix)

**Files:** `scripts/gmail-sweep-merge.mjs:21-26` **and `:337`**, `scripts/apply-status-flips.mjs:22-24`, `scripts/split-tsv-for-merge.mjs:16-19`

These hardcode `const ROOT = '/Users/anmolsahu2k/Stuff/Create/career-ops'`. Use `import { resolvePaths } from '../lib/paths.mjs';` (these live in `scripts/`).

- [ ] **Step 1: `gmail-sweep-merge.mjs`** — replace the block (21-26):
```javascript
import { resolvePaths } from '../lib/paths.mjs';
const P = resolvePaths(import.meta.url);
const PARSED_DIR = join(P.dataDir, 'gmail-sweeps/parsed');
const APPS_FILE = P.appsFile;
const ADDITIONS_DIR = P.batchDir('tracker-additions');
const FLIPS_DIR = P.batchDir('status-flips');
const TODAY = '2026-06-05';
```
**And fix the dangling `ROOT` at line 337** (Codex catch — `ROOT` no longer exists):
```javascript
const diagPath = join(P.dataDir, 'gmail-sweeps', `merge-report-${TODAY}.json`);
```
Ensure the dir exists before writing: add `mkdirSync(join(P.dataDir,'gmail-sweeps'), { recursive: true });` near the other mkdirs. Then grep: `grep -n "ROOT" scripts/gmail-sweep-merge.mjs` → none.

- [ ] **Step 2: `apply-status-flips.mjs`** — replace block (22-24): `const P = resolvePaths(import.meta.url); const APPS_FILE = P.appsFile; const FLIPS_DIR = P.batchDir('status-flips');`. Grep `ROOT` → none.

- [ ] **Step 3: `split-tsv-for-merge.mjs`** — replace block (16-19):
```javascript
import { resolvePaths } from '../lib/paths.mjs';
const P = resolvePaths(import.meta.url);
const APPS_FILE = P.appsFile;
const MERGED_DIR = join(P.batchDir('tracker-additions'), 'merged');
const ADDITIONS_DIR = P.batchDir('tracker-additions');
```
Grep `ROOT` → none.

- [ ] **Step 4: Verify** — `node scripts/gmail-sweep-merge.mjs 2>&1 | head -3` → reads `ft/data/gmail-sweeps/parsed` (likely "No parsed dir", which is fine), never root. `node scripts/split-tsv-for-merge.mjs 2>&1 | head -3` → operates on `ft/batch/...`.

- [ ] **Step 5: Checkpoint (optional)** — `git add scripts/gmail-sweep-merge.mjs scripts/apply-status-flips.mjs scripts/split-tsv-for-merge.mjs`

---

## Task 9: Rewire the Python scripts

**Files:** `scripts/discovery_filters.py:31-35`, `scripts/aggregator-intake.py:47-51`, `scripts/prune-by-liveness.py:21-22`, `scripts/reorg-reports-by-company.py:32-34`, `scripts/gmail-sweep.py:161` (`jobspy-ingest.py` inherits `discovery_filters` — no edit, but verify in Step 5).

- [ ] **Step 1: `discovery_filters.py`** — replace `SCRIPT_DIR`/`CAREER_OPS`/`APPS_FILE`/`REPORTS_DIR`/`BATCH_DIR` (31-35) with:
```python
import _paths
_P = _paths.resolve_paths(__file__)
CAREER_OPS = _P["root"]
APPS_FILE = _P["apps_file"]
REPORTS_DIR = _P["reports_dir"]
BATCH_DIR = _P["batch_dir"]
```

- [ ] **Step 2: `aggregator-intake.py`** — replace `SCRIPT_PATH`/`CAREER_OPS`/`DATA_DIR`/`LOG_DIR` (47-51) with `import _paths; _P = _paths.resolve_paths(__file__); CAREER_OPS = _P["root"]; DATA_DIR = _P["data_dir"]; LOG_DIR = DATA_DIR`. Keep the existing `import discovery_filters as df`.

- [ ] **Step 3: `prune-by-liveness.py`** — replace `WORKSPACE = Path(__file__).resolve().parent.parent` / `BATCH = WORKSPACE / "batch/tracker-additions"` (21-22) with `import _paths; _P = _paths.resolve_paths(__file__); BATCH = _P["batch_dir"]; TARGET_ROOT = _P["target"]`. **Then fix the two tracker-link reads** at lines 52 and 114: `rp = WORKSPACE / m2.group(1)` → `rp = TARGET_ROOT / m2.group(1)` (the link already contains `reports/`, so target-root, not reports_dir). Grep after: `grep -n "WORKSPACE" scripts/prune-by-liveness.py` → none.

- [ ] **Step 4: `reorg-reports-by-company.py`** — this needs BOTH roots. Replace `ROOT`/`TRACKER`/`REPORTS` (32-34) with:
```python
import _paths
_P = _paths.resolve_paths(__file__)
REPO_ROOT = _P["root"]      # for git -C and relative_to in git mv
TARGET_ROOT = _P["target"]  # reorg operates within the target subtree
TRACKER = _P["apps_file"]
REPORTS = _P["reports_dir"]
```
Then in the move/manifest block (lines ~253-296): the manifest goes to `TARGET_ROOT / "_meta" / "reorg-manifest.txt"`; `old.relative_to(...)` / `new.relative_to(...)` use **`REPO_ROOT`** (git mv paths are relative to the git root, e.g. `ft/reports/...`); `git -C str(REPO_ROOT)`. Use `TARGET_ROOT` only for the manifest location and any `relative_to` used purely for display under the subtree. Grep after: `grep -n "\bROOT\b" scripts/reorg-reports-by-company.py` → none (only REPO_ROOT/TARGET_ROOT).

- [ ] **Step 5: `split-sweep-batches.py`** — currently `SWEEPS = Path("data/gmail-sweeps")` (cwd-relative, line 6). Add the `_paths` import (prepend `import sys; from pathlib import Path; sys.path.insert(0, str(Path(__file__).resolve().parent)); import _paths`) and replace with `SWEEPS = _paths.resolve_paths(__file__)["data_dir"] / "gmail-sweeps"`. This keeps the Gmail flow's split step in the same `ft/data/gmail-sweeps` dir that `gmail-sweep.py` and `gmail-sweep-merge.mjs` now use.

- [ ] **Step 6: `gmail-sweep.py` out-dir default** — after imports add:
```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths
_DEFAULT_SWEEP_DIR = str(_paths.resolve_paths(__file__)["data_dir"] / "gmail-sweeps")
```
and change line 161 to `ap.add_argument("--out-dir", default=_DEFAULT_SWEEP_DIR)`.

- [ ] **Step 7: Verify**
```bash
python3 -c "import sys; sys.path.insert(0,'scripts'); import discovery_filters as d; print(d.APPS_FILE, d.BATCH_DIR)"   # both under ft/
grep -nE "applications\.md|batch/|data/gmail-sweeps" scripts/jobspy-ingest.py   # confirm it only uses df.BATCH_DIR, no own constant
CAREER_OPS_DATA_DIR=. python3 -c "import sys; sys.path.insert(0,'scripts'); import discovery_filters as d; print(d.APPS_FILE)"  # archive path
```

- [ ] **Step 8: Checkpoint (optional)** — `git add scripts/discovery_filters.py scripts/aggregator-intake.py scripts/prune-by-liveness.py scripts/reorg-reports-by-company.py scripts/split-sweep-batches.py scripts/gmail-sweep.py`

---

## Task 10: Guard the deprecated `gemini-eval.mjs`

**Files:** Modify `gemini-eval.mjs:39-49`

This is the deprecated Gemini/CV-PDF chain (Rule 2). Rather than wire dead code, refuse to run it by default so it can never write the intern archive.

- [ ] **Step 1: Add a guard at the top of `main()` (or just after the imports/const block, before any file write)**
```javascript
// Deprecated (Rule 2: no CV PDF gen; Gemini chain retired). Refuse to run unless
// explicitly opted in, so it can never write the frozen intern tracker/reports.
if (process.env.ALLOW_GEMINI_EVAL !== '1') {
  console.error('gemini-eval.mjs is deprecated and disabled. Set ALLOW_GEMINI_EVAL=1 to override.');
  process.exit(2);
}
```

- [ ] **Step 2: Verify** — `node gemini-eval.mjs 2>&1 | head -2` → prints the deprecation notice, exits 2, writes nothing.

- [ ] **Step 3: Checkpoint (optional)** — `git add gemini-eval.mjs`

---

## Task 11: Remove dashboard cover-letter generation (the `u` key)

**Files:** Delete `dashboard/internal/data/cover_letter.go`, `dashboard/internal/data/cover_letter_test.go`; Modify `dashboard/internal/ui/screens/pipeline.go` (`case "u"` at :411, struct fields/messages, **footer at :985**), `dashboard/main.go` (const :21, cases :118-136, `context` import), `dashboard/internal/ui/screens/pipeline_test.go` (**three** `TestUKey_*` tests at :192/:214/:248 + any helper, :167-260).

- [ ] **Step 1: Delete the cover_letter files** — `git rm dashboard/internal/data/cover_letter.go dashboard/internal/data/cover_letter_test.go`

- [ ] **Step 2: `pipeline.go`** — delete the `case "u":` block (411-435, up to `case "g":`); delete the `coverLetterGenerating` field + comment (~150-151) and `SetCoverLetterGenerating` (~163); delete `PipelineGenerateCoverLetterMsg` (51-54) and `PipelineCoverLetterReadyMsg` (search the file); **delete the footer binding at line 985** (`keyStyle.Render("u") + descStyle.Render(" cover ltr  ") +`). Then `grep -n "filepath\." pipeline.go` — if none remain, drop the `"path/filepath"` import.

- [ ] **Step 3: `main.go`** — delete `const coverLetterGenTimeout` (21) and both cases (118-136: `PipelineGenerateCoverLetterMsg` + `PipelineCoverLetterReadyMsg`). Remove the now-unused `"context"` import. Verify: `grep -n "context\." dashboard/main.go` → none; `grep -n "time\." dashboard/main.go` → still present (ExpireStaleEvaluations).

- [ ] **Step 4: `pipeline_test.go`** — delete ALL THREE cover-letter tests: `TestUKey_NoExistingFile_DispatchesGenerate` (192), `TestUKey_ExistingFile_DispatchesOpenViewer` (214), `TestUKey_DebouncedDuringGeneration` (248), plus any shared helper in 167-260. Grep after: `grep -n "CoverLetter\|TestUKey\|PipelineGenerateCoverLetter" dashboard/internal/ui/screens/pipeline_test.go` → none.

- [ ] **Step 5: Build + test** — `cd dashboard && go build ./... && go test ./... ; cd ..` → build + all tests green. (If "imported and not used: context" → finish Step 3; if a `TestUKey` symbol is undefined → finish Step 4.)

- [ ] **Step 6: Smoke** — `cd dashboard && go build -o /tmp/career-dash . && cd ..` then `/tmp/career-dash --path ft` (press `u` → no-op, footer no longer shows "u cover ltr"); `/tmp/career-dash --path .` still opens the archive.

- [ ] **Step 7: Checkpoint (optional)** — `git add -A dashboard/`

---

## Task 12: Update CLAUDE.md for the removed `u` feature

**Files:** Modify `CLAUDE.md` (Rule 4 trigger b; the "Dashboard `u` keybinding (cover letter)" section; workflow step 9)

- [ ] **Step 1:** In hard rule 4, remove trigger (b) (the `u`-press path); state the single trigger as explicit user request; drop the parenthetical about the dashboard shell-out.
- [ ] **Step 2:** Delete the entire "Dashboard `u` keybinding (cover letter)" subsection.
- [ ] **Step 3:** In "Workflow when surfacing new candidates" step 9, remove the "or when the user presses `u` …" clause; keep "Generated only when the user asks."
- [ ] **Step 4: Verify** — `grep -n "press .*u\|u-key\|u keybinding\|cover_letter.go\|GenerateCoverLetter" CLAUDE.md` → none.
- [ ] **Step 5: Checkpoint (optional)** — `git add CLAUDE.md`

---

## Task 13: End-to-end verification + grep-guard + STATUS/CHANGELOG

**Files:** Modify `STATUS.md`, `CHANGELOG.md`

- [ ] **Step 1: Grep-guard — prove no mutator still points at the root archive by default**

The guard targets the actual corruption signature — a **data/reports/batch path built off a script-relative root variable** (`CAREER_OPS`/`ROOT`/`HERE`/`WORKSPACE`) or a cwd-relative `data/...` literal — NOT bare `dirname(fileURLToPath)`/`Path(__file__).parent` (legit in many root tools). An allowlist excludes the resolvers, the guarded deprecated script, and known non-engine tools.

```bash
ALLOW='lib/paths\.mjs|scripts/_paths\.py|gemini-eval\.mjs|doctor\.mjs|cv-sync-check\.mjs|test-all\.mjs|update-system\.mjs|generate-pdf\.mjs|/merged/|docs/'

# JS: any data/reports/batch path joined onto a script-relative root var, or a cwd-relative data literal.
grep -rnE "join\((CAREER_OPS|ROOT|HERE|WORKSPACE), *['\"](data|reports|batch)|(^|[^.])['\"]data/(applications|scan-results|scan-history|gmail-sweeps)" \
  --include='*.mjs' . | grep -vE "$ALLOW"

# Python: data/reports/batch paths built off a script-relative root, or cwd-relative Path("data/...").
grep -rnE "(WORKSPACE|CAREER_OPS|ROOT|SWEEPS) *= *Path|/ *['\"](reports|batch)['\"]|Path\(['\"]data/|['\"]data/(applications|gmail-sweeps)" \
  --include='*.py' scripts/ | grep -vE "$ALLOW"
```
Expected: **zero** lines. Any hit is a missed mutator still pointing at root — fix it before proceeding. (Run the broader `dirname(fileURLToPath`/`Path(__file__).parent` sweep separately as an audit if you want, but it is not the pass/fail gate.)

- [ ] **Step 2: Prove the intern archive is byte-unchanged after an FT write**
```bash
shasum data/applications.md > /tmp/intern-before.sha
printf '900001\t2027-01-15\tAcmeFT\tNew Grad Software Engineer\tApplied\tN/A\tSDE\tn/a\t[Test] ft infra check\n' > ft/batch/tracker-additions/zz-ft-test.tsv
node merge-tracker.mjs
shasum -c /tmp/intern-before.sha            # MUST print: data/applications.md: OK
grep -c "AcmeFT" ft/data/applications.md     # expect 1
```

- [ ] **Step 3: Clean up test artifacts**
```bash
git checkout ft/data/applications.md 2>/dev/null || true   # restore header-only (committed in Task 1)
rm -f ft/batch/tracker-additions/merged/zz-ft-test.tsv ft/batch/tracker-additions/zz-ft-test.tsv
```
Confirm `ft/data/applications.md` is header-only again.

- [ ] **Step 4: Full verify** — `node verify-pipeline.mjs` (0 errors) ; `cd dashboard && go test ./... ; cd ..` (green) ; `node --test lib/paths.test.mjs` and `python3 scripts/test_paths.py` (green).

- [ ] **Step 5: Update STATUS.md** — under Current state add: "FT infrastructure (Plan 1) landed YYYY-MM-DD: ft/ subtree + CAREER_OPS_DATA_DIR resolver wired into all path-bearing scripts + dashboard u-removal; engine defaults to ft/. Plan 2 (search semantics) pending." Do NOT flip outstanding #3 to done (completes after Plan 2).

- [ ] **Step 6: Append CHANGELOG entry** under `## 2026-06-05` summarizing: ft/ scaffold, the two resolvers (with traversal guard), the 14 rewired scripts + gemini guard, dashboard u-removal (2 files deleted), the grep-guard + byte-unchanged archive proof.

- [ ] **Step 7: Checkpoint (optional)** — `git add STATUS.md CHANGELOG.md`

---

## Self-review notes (for the implementer)

- **The grep-guard (Task 13 Step 1) + byte-unchanged check (Step 2) are the backstops** for the whole plan — if any script was missed, they fail. Do not skip them.
- `portals.yml`, `templates/states.yml`, `config/profile.yml`, `cv.md`, `modes/…`, `.claude/…` are SHARED — they must keep resolving to `P.root` / `REPO_ROOT`, never the target. Double-check each rewired file.
- The dashboard does NOT read `CAREER_OPS_DATA_DIR` — point it with `--path ft`. Intentional.
- `jobspy-ingest.py` inherits `discovery_filters` constants; it needs no edit but IS verified in Task 9 Step 6.
- Commits are optional checkpoints requiring explicit user approval (spec line 27). Never `git push`.
