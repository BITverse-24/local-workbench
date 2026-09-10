"""Build deterministic demo fixtures and refresh manifest hashes."""

from __future__ import annotations

import csv
import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FLOW_B = ROOT / "flow-b"
FLOW_A = ROOT / "flow-a"


def make_csv(path: Path) -> None:
    special = {
        "2026-08-20T03:10": ("352.4", "high"),
        "2026-08-20T03:20": ("354.1", "high"),
        "2026-08-20T05:30": ("248.6", "low"),
        "2026-08-20T09:40": ("351.8", "high"),
        "2026-08-20T14:50": ("353.2", "high"),
        "2026-08-20T17:20": ("249.3", "low"),
        "2026-08-20T21:00": ("352.9", "high"),
    }
    start = datetime(2026, 8, 20)
    candidates = [(start + timedelta(minutes=6 * i)).strftime("%Y-%m-%dT%H:%M") for i in range(240)]
    normal = [stamp for stamp in candidates if stamp not in special][:233]
    timestamps = sorted(normal + list(special))
    with path.open("w", newline="", encoding="utf-8") as handle:
        # lineterminator matches the committed fixture bytes (LF, not csv's CRLF default).
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["timestamp", "reactor_id", "temperature_c"])
        for index, stamp in enumerate(timestamps):
            temperature = special.get(stamp, (f"{300.0 + (index % 5) * 0.2:.1f}", ""))[0]
            writer.writerow([stamp, "R-101", temperature])


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_manifest() -> None:
    files = {}
    for path in sorted(ROOT.rglob("*")):
        if path.is_file() and path.name not in {"manifest.json"}:
            files[str(path.relative_to(ROOT)).replace("\\", "/")] = {
                "sha256": sha256(path),
                "bytes": path.stat().st_size,
            }
    manifest = {
        "fixtureVersion": "1.0.0",
        "generatedAt": "2026-08-20T00:00:00Z",
        "flows": {
            "flowA": {
                "reportId": "IR-E201-2026-08-20",
                "equipmentId": "E-201",
                "criteriaCitation": "[SOP-114 §3.2]",
                "statuses": ["fail", "pass", "unknown"],
                "recommendation": "Conditional clearance pending retubing and recorded gasket replacement; final approval authority disposition required.",
            },
            "flowB": {
                "inputRows": 240,
                "reactorId": "R-101",
                "limitsCelsius": {"lowExclusive": 250.0, "highExclusive": 350.0},
                "outOfRangeRows": 7,
                "highRows": 5,
                "lowRows": 2,
                "expectedStdout": "OUT_OF_RANGE 7/240 (high=5, low=2)",
                "expectedExitCode": 0,
            },
        },
        "files": files,
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    make_csv(FLOW_B / "reactor-temperature-log.csv")
    make_manifest()
    print("Built demo fixtures and manifest.")
