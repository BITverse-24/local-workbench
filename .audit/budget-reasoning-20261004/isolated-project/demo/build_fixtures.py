"""Build deterministic demo fixtures and refresh manifest hashes."""

from __future__ import annotations

import csv
import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path



ROOT = Path(__file__).resolve().parent
FLOW_B = ROOT / "flow_b"
FLOW_A = ROOT / "flow_a"
FLOW_C = ROOT / "flow_c"


def make_flow_a_scans() -> None:
    """Create deterministic scan-like PDFs with visible handwritten evidence."""
    for filename, report_id, equipment, note, second_page in [
        (
            "inspection-report-E201-annotated.pdf",
            "IR-E201-2026-08-20",
            "E-201 Heat Exchanger",
            "RECHECK WELD JOINT 4B",
            "Channel-head gasket degradation. Replacement recommended before return to service.",
        ),
        (
            "inspection-report-E202-followup.pdf",
            "IR-E202-2026-08-21",
            "E-202 Pressure Vessel",
            "verify after repair",
            "Follow-up visual inspection complete. No new defects observed.",
        ),
    ]:
        output = FLOW_A / filename
        pages = [
            [
                (16, 54, 740, "NORTH ZONE REFINERY - INSPECTION REPORT", "0 0 0"),
                (10, 54, 714, f"Report ID: {report_id}", "0 0 0"),
                (10, 54, 698, f"Equipment: {equipment}", "0 0 0"),
                (11, 54, 662, "Inspection findings", "0 0 0"),
                (10, 72, 632, "Tube wall thickness: Rows 12-15 measured 3.8-4.2 mm.", "0 0 0"),
                (10, 72, 614, "Minimum allowable tube wall thickness: 4.6 mm.", "0 0 0"),
                (10, 72, 596, "Localised pitting corrosion at the shell inlet nozzle; maximum depth 1.8 mm.", "0 0 0"),
                (10, 72, 578, "The report does not state an approval status.", "0 0 0"),
                (13, 390, 510, note, "0.72 0.08 0.08"),
                (11, 390, 492, "- field inspector", "0.72 0.08 0.08"),
            ],
            [
                (12, 54, 740, "Page 2 - follow-up observations", "0 0 0"),
                (10, 54, 708, second_page, "0 0 0"),
                (10, 54, 680, "Inspector annotation is retained as source evidence.", "0 0 0"),
            ],
        ]
        write_simple_pdf(output, pages, report_id)


def pdf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_simple_pdf(path: Path, pages: list[list[tuple[int, int, int, str, str]]], title: str) -> None:
    """Write a tiny dependency-free two-page PDF for offline demo scans."""
    objects: list[bytes] = []
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    page_ids = []
    for page_index, lines in enumerate(pages):
        content_parts = ["BT"]
        for size, x, y, text, color in lines:
            content_parts.extend([f"/{'F1'} {size} Tf", f"{color} rg", f"1 0 0 1 {x} {y} Tm", f"({pdf_escape(text)}) Tj"])
        content_parts.append("ET")
        stream = "\n".join(content_parts).encode("ascii", "replace")
        content_id = 3 + page_index * 2
        page_id = content_id + 1
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode("ascii") + stream + b"\nendstream")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents {content_id} 0 R >>".encode("ascii"))
        page_ids.append(page_id)
    objects.insert(1, f"<< /Type /Pages /Kids [{' '.join(f'{page_id} 0 R' for page_id in page_ids)}] /Count {len(page_ids)} >>".encode("ascii"))
    objects.append(f"<< /Title ({pdf_escape(title)}) >>".encode("ascii"))
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for object_id, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{object_id} 0 obj\n".encode("ascii"))
        pdf.extend(body)
        pdf.extend(b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    pdf.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info {len(objects)} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    path.write_bytes(pdf)


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
        "fixtureVersion": "2.0.0",
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
            "flowC": {
                "drawingId": "PID-P204-REV-C",
                "requiredCitations": ["[SOP-220 §4.2]", "[SOP-220 §4.3]"],
                "nonCompliantChecks": 2,
                "recommendation": "Replace XV-204 with Class 300 and revise discharge line to DN100 or larger.",
            },
        },
        "files": files,
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    make_flow_a_scans()
    make_csv(FLOW_B / "reactor-temperature-log.csv")
    make_manifest()
    print("Built demo fixtures and manifest.")
