"""Offline preflight checks for the fixed demo fixture bundle."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FLOW_A = ROOT / "flow-a"
FLOW_B = ROOT / "flow-b"


def load(name: str):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate_pdf() -> None:
    data = (FLOW_A / "inspection-report-E201.pdf").read_bytes()
    check(data.startswith(b"%PDF-1.4"), "report is not a PDF 1.4 file")
    check(len(re.findall(rb"/Type /Page /Parent", data)) == 2, "report must contain exactly two pages")
    strings = [match.decode("cp1252") for match in re.findall(rb"\((.*?)\) Tj", data)]
    text = "\n".join(strings)
    required = [
        "Heat Exchanger E-201 Tube Bundle Inspection Report",
        "Report ID: IR-E201-2026-08-20",
        "Inspection date: 2026-08-20",
        "Unit: R-100",
        "Rows 12–15 measured 3.8–4.2 mm; minimum allowable tube wall thickness: 4.6 mm.",
        "Localised pitting corrosion at the shell inlet nozzle; maximum pitting depth: 1.8 mm.",
        "Channel-head gasket shows degradation; replacement recommended before return to service.",
    ]
    for fragment in required:
        check(fragment in text, f"report PDF is missing: {fragment}")


def validate_flow_a() -> None:
    ocr = load("flow-a/expected-ocr.json")
    check(len(ocr["findings"]) == 3, "OCR oracle must contain three findings")
    check([item["page"] for item in ocr["pageReferences"]] == [1, 1, 2], "OCR pages must be 1, 1, 2")
    page_ids = {item["id"] for item in ocr["pageReferences"]}
    check(all(set(item["pageReferenceIds"]) <= page_ids for item in ocr["findings"]), "finding references must resolve")
    check(ocr["warnings"] == [], "clean report must have no OCR warnings")

    sop = (FLOW_A / "sop-114-pressure-equipment-inspection.md").read_text(encoding="utf-8")
    template = (FLOW_A / "approval-note-template-TPL-012.md").read_text(encoding="utf-8")
    check("[section:3.2] Approval criteria" in sop, "SOP 3.2 section is missing")
    check("[SOP-114 §3.2]" in sop, "SOP citation text is missing")
    for section in ["equipment-header", "findings-summary", "recommendation", "grounding-references"]:
        check(f"[section:{section}]" in template, f"TPL-012 section is missing: {section}")

    retrieval = load("flow-a/expected-retrieval.json")
    check(retrieval["topK"] == 5 and len(retrieval["chunks"]) == 5, "retrieval oracle must contain top five chunks")
    identities = {(chunk["documentId"], chunk["sectionId"]) for chunk in retrieval["chunks"]}
    check(("SOP-114", "3.2") in identities, "SOP-114 3.2 must be in top five")
    check(any(chunk["documentId"] == "TPL-012" for chunk in retrieval["chunks"]), "TPL-012 must be in top five")

    draft = load("flow-a/expected-approval-note.json")
    expected_sections = ["equipment-header", "findings-summary", "recommendation", "grounding-references"]
    check([section["id"] for section in draft["sections"]] == expected_sections, "draft sections are not locked")
    check("E-201" in draft["sections"][0]["body"], "draft lacks equipment identifier")
    check("IR-E201-2026-08-20" in draft["sections"][0]["body"], "draft lacks report reference")
    check("Conditional clearance pending retubing" in draft["sections"][2]["body"], "draft lacks recommendation")
    check("[SOP-114 §3.2]" in draft["body"], "draft lacks required citation")
    check(draft["citations"][0]["documentId"] == "SOP-114", "draft citation has wrong document")
    check(draft["citations"][0]["sectionId"] == "3.2", "draft citation has wrong section")
    check(draft["missingInformation"][0]["field"] == "approvalAuthority", "draft must mark missing authority")


def read_input_rows() -> list[dict[str, str]]:
    with (FLOW_B / "reactor-temperature-log.csv").open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def validate_flow_b() -> None:
    rows = read_input_rows()
    check(len(rows) == 240, f"CSV must contain 240 data rows, found {len(rows)}")
    check({row["reactor_id"] for row in rows} == {"R-101"}, "CSV reactor must be R-101")
    check(list(rows[0]) == ["timestamp", "reactor_id", "temperature_c"], "CSV header is incorrect")
    special_timestamps = {
        "2026-08-20T03:10", "2026-08-20T03:20", "2026-08-20T05:30",
        "2026-08-20T09:40", "2026-08-20T14:50", "2026-08-20T17:20",
        "2026-08-20T21:00",
    }
    for row in rows:
        check(250.0 <= float(row["temperature_c"]) <= 350.0 or row["timestamp"] in special_timestamps,
              f"unexpected out-of-range row: {row}")

    execution = load("flow-b/expected-python-execution.json")
    summary = load("flow-b/expected-out-of-range-summary.json")
    expected_rows = summary["rows"]
    with tempfile.TemporaryDirectory(prefix=".preflight-", dir=ROOT) as temporary:
        run_dir = Path(temporary)
        shutil.copy2(FLOW_B / "reactor-temperature-log.csv", run_dir / "reactor-temperature-log.csv")
        shutil.copy2(FLOW_B / "expected-task.py", run_dir / "task.py")
        result = subprocess.run(
            [sys.executable, "task.py"],
            cwd=run_dir,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        check(result.returncode == execution["exitCode"], f"golden code exit code is {result.returncode}")
        check(result.stdout == execution["stdout"], f"golden stdout is {result.stdout!r}")
        check(result.stderr == execution["stderr"], f"golden stderr is {result.stderr!r}")
        check((run_dir / "out-of-range-rows.csv").exists(), "golden code did not create output CSV")
        with (run_dir / "out-of-range-rows.csv").open(newline="", encoding="utf-8") as handle:
            generated_rows = list(csv.DictReader(handle))
        check(generated_rows == expected_rows, "generated flagged rows differ from the oracle")

    check(execution["timedOut"] is False, "fixed execution must not time out")
    check(execution["outputFiles"] == ["out-of-range-rows.csv"], "execution output file is incorrect")
    check(summary["summary"] == {
        "totalRows": 240,
        "outOfRange": 7,
        "high": 5,
        "low": 2,
        "stdout": "OUT_OF_RANGE 7/240 (high=5, low=2)",
    }, "summary oracle is incorrect")
    expected_csv = (FLOW_B / "expected-out-of-range-summary.csv").read_text(encoding="utf-8")
    check(expected_csv.endswith("2026-08-20T21:00,R-101,352.9,high\n"), "expected output CSV is incomplete")


def validate_manifest() -> None:
    manifest = load("manifest.json")
    check(manifest["fixtureVersion"] == "1.0.0", "unexpected fixture version")
    for relative, details in manifest["files"].items():
        path = ROOT / relative
        check(path.exists(), f"manifest file is missing: {relative}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        check(digest == details["sha256"], f"manifest hash mismatch: {relative}")
        check(path.stat().st_size == details["bytes"], f"manifest size mismatch: {relative}")


def main() -> None:
    validate_pdf()
    validate_flow_a()
    validate_flow_b()
    validate_manifest()
    print("Fixture preflight passed: Flow A and Flow B are deterministic and internally consistent.")


if __name__ == "__main__":
    main()
