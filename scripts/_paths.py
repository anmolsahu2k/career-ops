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
