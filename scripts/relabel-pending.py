#!/usr/bin/env python3
# requirements: stdlib only

"""
relabel-pending.py

Bulk-rewrite applications.md rows where Report column points at
reports/pending.md. These rows were merged from triage TSVs and were
mis-labeled as Status=Evaluated when in reality they only have a
deterministic title+company-keyword score, no per-JD eval.

Rewrites:
  - Status field: Evaluated -> Triaged
  - For Company starting with "Oracle": Status -> SKIP, append visa-block
    note (Oracle JDs verbatim "Visa sponsorship is not available... F-1
    e.g. EAD, OPT, CPT" per #1867 eval; same exclusion applies repo-wide).

Skips:
  - Rows whose Report column already points at a real report file (no
    `pending.md` substring).

Usage:
  python3 scripts/relabel-pending.py            # apply
  python3 scripts/relabel-pending.py --dry-run  # preview only
"""

import argparse
import re
import sys
from pathlib import Path

CO = Path(__file__).resolve().parent.parent
APPS = CO / "data" / "applications.md"

ORACLE_NOTE = (
    "Oracle visa-block (per #1867 eval): JDs verbatim "
    "'Visa sponsorship is not available... includes... F-1 e.g. EAD, OPT, CPT'. "
    "Bulk-marked SKIP."
)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    text = APPS.read_text(encoding="utf-8")
    lines = text.split("\n")

    changes = {"triaged": 0, "oracle_skip": 0, "skipped_already_evaluated": 0}
    out_lines = []

    for line in lines:
        if not line.startswith("| ") or "pending.md" not in line:
            out_lines.append(line)
            continue

        cells = [c.strip() for c in line.split("|")]
        if len(cells) < 10:
            out_lines.append(line)
            continue

        # cells = ['', num, date, company, role, score, status, pdf, report, notes, '']
        company = cells[3]
        status = cells[6]
        notes = cells[9]

        if status != "Evaluated":
            changes["skipped_already_evaluated"] += 1
            out_lines.append(line)
            continue

        if company.lower().startswith("oracle"):
            cells[6] = "SKIP"
            cells[9] = f"{ORACLE_NOTE} Original: {notes[:200]}"
            changes["oracle_skip"] += 1
        else:
            cells[6] = "Triaged"
            changes["triaged"] += 1

        out_lines.append("|".join(cells))

    new_text = "\n".join(out_lines)

    print(f"# relabel-pending dry_run={args.dry_run}")
    print(f"  pending.md rows -> Triaged: {changes['triaged']}")
    print(f"  Oracle pending rows -> SKIP: {changes['oracle_skip']}")
    print(f"  already non-Evaluated (untouched): {changes['skipped_already_evaluated']}")

    if args.dry_run:
        return 0

    APPS.write_text(new_text, encoding="utf-8")
    print(f"\nrewrote {APPS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
