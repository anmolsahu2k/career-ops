#!/usr/bin/env python3
"""Split fetched Gmail sweeps into agent-sized batches."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths
SWEEPS = _paths.resolve_paths(__file__)["data_dir"] / "gmail-sweeps"
DATE = "2026-06-05"
BATCH_SIZES = {
    "personal-apps": 45,
    "personal-rejections": 45,
    "cmu-handshake": 50,
}

manifest = []
for mode, size in BATCH_SIZES.items():
    src = SWEEPS / f"{mode}-{DATE}.json"
    data = json.loads(src.read_text())
    for i in range(0, len(data), size):
        chunk = data[i : i + size]
        n = i // size + 1
        path = SWEEPS / f"{mode}-batch-{n:02d}-{DATE}.json"
        path.write_text(json.dumps(chunk, indent=2))
        manifest.append({"mode": mode, "batch": n, "path": str(path), "count": len(chunk)})

(SWEEPS / f"manifest-{DATE}.json").write_text(json.dumps(manifest, indent=2))
total = sum(m["count"] for m in manifest)
print(f"Split {total} emails into {len(manifest)} batches")
for m in manifest:
    print(f"  {m['mode']:25s} batch {m['batch']:2d}  count={m['count']:3d}  {m['path']}")
