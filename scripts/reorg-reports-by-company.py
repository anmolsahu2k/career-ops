#!/usr/bin/env python3
"""Reorganize reports/ into per-company subfolders.

Strategy:
1. Parse data/applications.md tracker rows -> map row#-> company slug.
2. Walk reports/*.md -> find leading number, look up company from tracker.
3. For files whose # has multiple tracker rows (multi-role companies), all
   rows must agree on Company; if not, prefer the row whose Report or Notes
   field references this exact filename.
4. Files without a numeric prefix go to reports/_misc/ (except pending.md
   which stays at top level).
5. Emit a manifest (old_path -> new_path), then perform git mv.
6. Rewrite every reports/ link inside data/applications.md and inside the
   moved files (cover letters often cross-reference each other).

Run:
    python3 scripts/reorg-reports-by-company.py --dry-run   # default
    python3 scripts/reorg-reports-by-company.py --execute
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
TRACKER = ROOT / "data" / "applications.md"
REPORTS = ROOT / "reports"

# Keep these at top of reports/ — shared sentinels / non-company files.
KEEP_AT_TOP = {"pending.md", ".gitkeep"}

SLUG_NON_ALNUM = re.compile(r"[^a-z0-9]+")

# Merge variants of the same company under one canonical slug.
SLUG_ALIASES = {
    "bosch-group": "bosch",
    "cadence": "cadence-design-systems",
    "gelber-group-llc": "gelber-group",
    "kla-corporation": "kla",
    "marvell-technology": "marvell",
    "nuro-inc": "nuro",
    "smiths-detection-group": "smiths-detection",
}

LINK_RE = re.compile(r"\(reports/([\w./\-]+\.md)\)")


def slugify(name: str) -> str:
    name = name.lower()
    # strip emoji/visa-flags / non-ASCII
    name = "".join(ch if ord(ch) < 128 else " " for ch in name)
    name = SLUG_NON_ALNUM.sub("-", name).strip("-")
    return SLUG_ALIASES.get(name, name)


def parse_tracker() -> dict[int, list[dict]]:
    """Return {row_num: [row_dict, ...]}.

    Multiple rows may share a #; we keep all of them so we can disambiguate
    later by matching filenames in Report/Notes fields.
    """
    rows: dict[int, list[dict]] = defaultdict(list)
    for line in TRACKER.read_text().splitlines():
        if not line.startswith("|"):
            continue
        parts = [p.strip() for p in line.split("|")]
        # leading + trailing pipes give empty parts at both ends
        if len(parts) < 11:
            continue
        if parts[1] in ("#", "---") or set(parts[1]) <= {"-", " "}:
            continue
        try:
            num = int(parts[1])
        except ValueError:
            continue
        rows[num].append({
            "num": num,
            "date": parts[2],
            "company": parts[3],
            "role": parts[4],
            "score": parts[5],
            "status": parts[6],
            "pdf": parts[7],
            "report": parts[8],
            "notes": parts[9],
            "raw": line,
        })
    return rows


def file_num(filename: str) -> int | None:
    m = re.match(r"^(\d+)-", filename)
    return int(m.group(1)) if m else None


def build_filename_company_map(tracker: dict[int, list[dict]]) -> dict[str, str]:
    """Walk every Report and Notes cell, extract reports/<filename>, map to company."""
    out: dict[str, str] = {}
    for rows in tracker.values():
        for row in rows:
            for cell in (row["report"], row["notes"]):
                for m in LINK_RE.finditer(cell):
                    bn = os.path.basename(m.group(1))
                    if bn in KEEP_AT_TOP:
                        continue
                    # Don't overwrite if already mapped (first row wins; usually consistent).
                    out.setdefault(bn, row["company"])
    return out


def pick_company(num: int, filename: str, tracker: dict[int, list[dict]],
                 filename_map: dict[str, str], known_slugs: set[str]) -> str | None:
    if filename in filename_map:
        return filename_map[filename]
    candidates = tracker.get(num, [])
    if candidates:
        if len(candidates) == 1:
            return candidates[0]["company"]
        for row in candidates:
            if filename in row["report"] or filename in row["notes"]:
                return row["company"]
        companies = {row["company"] for row in candidates}
        if len(companies) == 1:
            return companies.pop()
        print(f"WARN: row #{num} has multiple companies {companies}; using first", file=sys.stderr)
        return candidates[0]["company"]
    # Fallback: prefix-match against known slugs based on filename.
    # e.g. "024-axway-b2bi-swe-2026-04-28.md" -> stem "axway-b2bi-swe" -> matches "axway".
    stem = re.sub(r"^\d+-", "", filename)
    stem = re.sub(r"-\d{4}-\d{2}-\d{2}\.md$", "", stem)
    stem = re.sub(r"\.md$", "", stem)
    # Try progressively shorter prefixes.
    parts = stem.split("-")
    for i in range(len(parts), 0, -1):
        cand = "-".join(parts[:i])
        cand = SLUG_ALIASES.get(cand, cand)
        if cand in known_slugs:
            # Look up the company name by reverse lookup of any tracker row using that slug.
            return cand  # return slug directly; caller will skip re-slugifying.
    return None


def build_plan() -> tuple[list[tuple[Path, Path]], dict[str, str]]:
    """Returns (moves, slug_for_filename).

    moves: list of (old_abs_path, new_abs_path)
    slug_for_filename: {basename: company_slug}  (for link rewriting)
    """
    tracker = parse_tracker()
    filename_map = build_filename_company_map(tracker)

    # Pass 1: build known_slugs from tracker companies.
    known_slugs: set[str] = set()
    for rows in tracker.values():
        for row in rows:
            s = slugify(row["company"])
            if s:
                known_slugs.add(s)

    moves: list[tuple[Path, Path]] = []
    slug_for_filename: dict[str, str] = {}

    for entry in sorted(REPORTS.iterdir()):
        if entry.is_dir():
            continue
        name = entry.name
        if name in KEEP_AT_TOP:
            continue
        num = file_num(name)
        if num is None:
            new = REPORTS / "_misc" / name
            moves.append((entry, new))
            slug_for_filename[name] = "_misc"
            continue
        result = pick_company(num, name, tracker, filename_map, known_slugs)
        if result is None:
            print(f"WARN: no tracker row for #{num} ({name}); putting in _orphan/", file=sys.stderr)
            new = REPORTS / "_orphan" / name
            moves.append((entry, new))
            slug_for_filename[name] = "_orphan"
            continue
        # If pick_company returned a slug from prefix-match fallback, use as-is.
        slug = result if result in known_slugs else slugify(result)
        if not slug:
            slug = "_orphan"
        new = REPORTS / slug / name
        moves.append((entry, new))
        slug_for_filename[name] = slug

    return moves, slug_for_filename


def rewrite_links(text: str, slug_for_filename: dict[str, str]) -> str:
    """Replace `reports/<basename>` with `reports/<slug>/<basename>` everywhere.

    Skip basenames in KEEP_AT_TOP (pending.md).
    """
    pat = re.compile(r"reports/([\w.\-]+\.md)")

    def repl(m):
        bn = m.group(1)
        if bn in KEEP_AT_TOP:
            return m.group(0)
        slug = slug_for_filename.get(bn)
        if not slug:
            return m.group(0)
        return f"reports/{slug}/{bn}"

    return pat.sub(repl, text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true", help="Actually move files (default: dry-run)")
    ap.add_argument("--no-git", action="store_true", help="Use plain mv instead of git mv")
    args = ap.parse_args()

    moves, slug_for_filename = build_plan()

    # Summary
    by_slug: dict[str, list[str]] = defaultdict(list)
    for old, new in moves:
        by_slug[new.parent.name].append(old.name)

    print(f"Plan: {len(moves)} moves into {len(by_slug)} folders")
    for slug, files in sorted(by_slug.items()):
        print(f"  {slug:40s} {len(files):4d} files")

    # Pre-flight: detect filename collisions inside the same target folder
    target_keys = set()
    collisions = []
    for _, new in moves:
        key = (new.parent, new.name)
        if key in target_keys:
            collisions.append(new)
        target_keys.add(key)
    if collisions:
        print("\nERROR: filename collisions:", file=sys.stderr)
        for c in collisions:
            print(f"  {c}", file=sys.stderr)
        sys.exit(1)

    if not args.execute:
        print("\n(dry-run; pass --execute to actually move)")
        # Still write the manifest for inspection
        manifest = ROOT / "_meta" / "reorg-manifest.txt"
        manifest.parent.mkdir(exist_ok=True)
        manifest.write_text("\n".join(f"{old.relative_to(ROOT)} -> {new.relative_to(ROOT)}" for old, new in moves))
        print(f"Manifest written to {manifest.relative_to(ROOT)}")
        return

    # Execute moves
    seen_dirs = set()
    for old, new in moves:
        new.parent.mkdir(parents=True, exist_ok=True)
        if new.parent not in seen_dirs:
            seen_dirs.add(new.parent)
        if args.no_git:
            shutil.move(str(old), str(new))
        else:
            r = subprocess.run(["git", "-C", str(ROOT), "mv", str(old.relative_to(ROOT)), str(new.relative_to(ROOT))],
                               capture_output=True, text=True)
            if r.returncode != 0:
                # Fallback for untracked files (most of reports/ is untracked per status output)
                if "not under version control" in r.stderr or "did not match any file" in r.stderr:
                    shutil.move(str(old), str(new))
                else:
                    print(f"git mv failed: {r.stderr}", file=sys.stderr)
                    sys.exit(2)

    # Rewrite tracker links
    tracker_text = TRACKER.read_text()
    new_tracker = rewrite_links(tracker_text, slug_for_filename)
    if new_tracker != tracker_text:
        TRACKER.write_text(new_tracker)
        print(f"Updated {TRACKER.relative_to(ROOT)}")

    # Rewrite cross-refs inside moved files
    rewritten = 0
    for _, new in moves:
        if not new.exists() or not new.suffix == ".md":
            continue
        try:
            t = new.read_text()
        except UnicodeDecodeError:
            continue
        nt = rewrite_links(t, slug_for_filename)
        if nt != t:
            new.write_text(nt)
            rewritten += 1
    print(f"Rewrote cross-references in {rewritten} files")

    print("\nDone.")


if __name__ == "__main__":
    main()
