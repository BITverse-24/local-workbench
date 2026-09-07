"""Build deterministic binary/text fixtures and refresh manifest hashes."""

from __future__ import annotations

import csv
import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FLOW_A = ROOT / "flow-a"
FLOW_B = ROOT / "flow-b"


def pdf_escape(value: str) -> bytes:
    return value.encode("cp1252").replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def make_pdf(path: Path) -> None:
    pages = [
        [
            (16, "Heat Exchanger E-201 Tube Bundle Inspection Report"),
            (10, "Report ID: IR-E201-2026-08-20"),
            (10, "Inspection date: 2026-08-20"),
            (10, "Unit: R-100"),
            (10, "Inspection scope: Tube bundle and shell inlet nozzle"),
            (12, "Tube wall thickness"),
            (10, "Rows 12–15 measured 3.8–4.2 mm; minimum allowable tube wall thickness: 4.6 mm."),
            (12, "Corrosion findings"),
            (10, "Localised pitting corrosion at the shell inlet nozzle; maximum pitting depth: 1.8 mm."),
        ],
        [
            (16, "Heat Exchanger E-201 Tube Bundle Inspection Report"),
            (12, "Channel-head inspection"),
            (10, "Channel-head gasket shows degradation; replacement recommended before return to service."),
            (10, "No approval status is stated in this report."),
            (12, "Inspection record"),
            (10, "Report reference: IR-E201-2026-08-20"),
            (10, "Inspection date: 2026-08-20"),
        ],
    ]

    objects: list[bytes] = []
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>")
    objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>")

    for page in pages:
        lines = [b"BT"]
        y = 740
        for size, text in page:
            lines.append(f"/F1 {size} Tf 72 {y} Td (".encode("ascii") + pdf_escape(text) + b") Tj")
            y -= 28 if size >= 12 else 20
        lines.append(b"ET")
        objects.append(b"<< /Length " + str(sum(len(line) + 1 for line in lines)).encode("ascii") + b" >>\nstream\n" + b"\n".join(lines) + b"\nendstream")

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    path.write_bytes(bytes(output))


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
        writer = csv.writer(handle)
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
                "reportReference": "IR-E201-2026-08-20",
                "inspectionDate": "2026-08-20",
                "equipment": "E-201",
                "unit": "R-100",
                "expectedFindingCount": 3,
                "requiredCitation": "SOP-114 §3.2",
                "requiredTemplate": "TPL-012",
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
    make_pdf(FLOW_A / "inspection-report-E201.pdf")
    make_csv(FLOW_B / "reactor-temperature-log.csv")
    make_manifest()
    print("Built demo fixtures and manifest.")
