#!/usr/bin/env python3
"""prune-by-liveness.py — apply a liveness-results.tsv to the live aggregator
TSVs. Deletes expired placeholders, marks expired evaluated rows as Discarded,
and flags uncertain rows in their Notes column.

Run AFTER `npm run liveness:batch` to clean up dead URLs before the next eval
dispatch (saves Claude tokens) or before merging into applications.md (keeps
the tracker clean).

Usage:
  python3 scripts/prune-by-liveness.py [path/to/liveness-results.tsv] [--dry-run]

Default results file: /tmp/liveness-results.tsv
"""
import argparse
import re
import sys
from datetime import date
from pathlib import Path
import _paths
_P = _paths.resolve_paths(__file__)
BATCH = _P["batch_dir"]
TARGET_ROOT = _P["target"]
URL_RE_REPORT = re.compile(r"\*\*URL:\*\*\s*(\S+)")


def load_results(path):
    """Returns {normalized_url: {result, status, reason}}."""
    out = {}
    for line in path.read_text().splitlines():
        parts = line.split("\t")
        if len(parts) >= 4:
            url = parts[0].lower().rstrip("/")
            out[url] = {"result": parts[1], "status": parts[2], "reason": parts[3]}
    return out


def url_for_tsv(tsv_path):
    """Pull the URL for a TSV from its Notes (placeholder) or from the report
    file's `**URL:**` header (evaluated)."""
    line = tsv_path.read_text().splitlines()[0]
    parts = line.split("\t")
    notes = parts[8] if len(parts) > 8 else ""
    report_cell = parts[7] if len(parts) > 7 else ""
    is_placeholder = "reports/pending.md" in report_cell

    m = re.search(r"URL:\s*(\S+)", notes)
    if m:
        return m.group(1).rstrip(".,").lower().rstrip("/"), is_placeholder, report_cell

    m2 = re.search(r"\(([^)]+\.md)\)", report_cell)
    if m2:
        rp = TARGET_ROOT / m2.group(1)
        if rp.exists():
            m3 = URL_RE_REPORT.search(rp.read_text(errors="replace"))
            if m3:
                return m3.group(1).rstrip(".,").lower().rstrip("/"), is_placeholder, report_cell
    return None, is_placeholder, report_cell


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument(
        "results",
        nargs="?",
        default="/tmp/liveness-results.tsv",
        help="TSV from liveness-parallel.mjs (default: /tmp/liveness-results.tsv)",
    )
    p.add_argument("--dry-run", action="store_true", help="show what would change without writing")
    args = p.parse_args(argv)

    results_path = Path(args.results)
    if not results_path.exists():
        print(f"liveness results not found: {results_path}", file=sys.stderr)
        return 1
    results = load_results(results_path)
    today = date.today().isoformat()

    deleted = discarded = flagged = unmatched = 0
    # All discovery sources (aggregator, jobspy, handshake, ...) are gated the
    # same way; glob all tsvs not just one source's.
    for tsv in sorted(BATCH.glob("*.tsv"), key=lambda p: int(p.name.split("-", 1)[0])):
        url, is_placeholder, report_cell = url_for_tsv(tsv)
        if not url or url not in results:
            unmatched += 1
            continue
        result = results[url]["result"]
        if result == "active":
            continue

        if result == "expired":
            if is_placeholder:
                if args.dry_run:
                    print(f"DELETE {tsv.name}")
                else:
                    tsv.unlink()
                deleted += 1
            else:
                # Mark Discarded in TSV
                line = tsv.read_text().splitlines()[0]
                parts = line.split("\t")
                if len(parts) >= 9:
                    parts[5] = "Discarded"
                    note_prefix = f"AUTO-DISCARDED {today} (liveness check: URL expired). "
                    if note_prefix not in parts[8]:
                        parts[8] = note_prefix + parts[8]
                    if args.dry_run:
                        print(f"DISCARD {tsv.name}")
                    else:
                        tsv.write_text("\t".join(parts) + "\n")
                # Mark Discarded in report file
                m2 = re.search(r"\(([^)]+\.md)\)", report_cell)
                if m2:
                    rp = TARGET_ROOT / m2.group(1)
                    if rp.exists() and rp.name != "pending.md":
                        text = rp.read_text()
                        new_text = re.sub(
                            r"(\*\*Status:\*\*\s*)\S+", r"\1Discarded", text, count=1
                        )
                        if "**Liveness:**" not in new_text:
                            new_text = re.sub(
                                r"(\*\*Status:\*\*\s*Discarded\n)",
                                rf"\1**Liveness:** EXPIRED (auto-flagged {today}, URL no longer active)\n",
                                new_text,
                                count=1,
                            )
                        if not args.dry_run and new_text != text:
                            rp.write_text(new_text)
                discarded += 1

        elif result == "uncertain":
            line = tsv.read_text().splitlines()[0]
            parts = line.split("\t")
            if len(parts) >= 9:
                prefix = f"LIVENESS-UNCERTAIN {today}. "
                if prefix not in parts[8]:
                    parts[8] = prefix + parts[8]
                    if args.dry_run:
                        print(f"FLAG    {tsv.name}")
                    else:
                        tsv.write_text("\t".join(parts) + "\n")
                    flagged += 1

    print(
        f"\nSummary {'(dry-run)' if args.dry_run else ''}: "
        f"{deleted} deleted (expired placeholders), "
        f"{discarded} discarded (expired evaluated), "
        f"{flagged} flagged uncertain, "
        f"{unmatched} TSVs unmatched (URL not in results)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
