"""Offline preflight checks for the fixed Flow A, Flow B, and Flow C demo fixtures."""

from __future__ import annotations

import csv
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FLOW_B = ROOT / "flow_b"
FLOW_A = ROOT / "flow_a"
FLOW_C = ROOT / "flow_c"


def load(name: str):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read_input_rows() -> list[dict[str, str]]:
    with (FLOW_B / "reactor-temperature-log.csv").open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def validate_flow_a() -> None:
    required = [
        "inspection-report-E201.pdf",
        "sop-114-pressure-equipment-inspection.md",
        "approval-note-template-TPL-012.md",
        "expected-ocr.json",
        "expected-assessment.json",
        "expected-approval-note.json",
        "report-bundle.json",
        "expected-bundle-extraction.json",
        "sovereignty-proof.json",
    ]
    for filename in required:
        path = FLOW_A / filename
        check(path.exists() and path.stat().st_size > 0, f"Flow A fixture is missing or empty: {filename}")

    sop = (FLOW_A / "sop-114-pressure-equipment-inspection.md").read_text(encoding="utf-8")
    check("[section:3.2] Approval criteria" in sop, "SOP criteria section is missing")
    check("[SOP-114 §3.2]" in sop, "SOP citation is missing")

    ocr = load("flow_a/expected-ocr.json")
    check(len(ocr["findings"]) == 3, "OCR oracle must contain three findings")
    check({finding["findingId"] for finding in ocr["findings"]} == {"finding-1", "finding-2", "finding-3"},
          "OCR finding IDs are incorrect")
    check({reference["page"] for reference in ocr["pageReferences"]} == {1, 2},
          "OCR page references are incomplete")

    assessment = load("flow_a/expected-assessment.json")
    check(assessment["criteriaCitation"] == "[SOP-114 §3.2]", "assessment citation is incorrect")
    check({item["status"] for item in assessment["assessments"]} == {"fail", "pass", "unknown"},
          "assessment must demonstrate pass, fail, and unknown statuses")
    check(all(item["citation"] == "[SOP-114 §3.2]" for item in assessment["assessments"]),
          "every assessment must cite the governing SOP")
    check("Conditional clearance" in assessment["recommendation"], "conditional recommendation is missing")
    check(assessment["missingInformation"][0]["field"] == "approvalAuthority",
          "missing approval authority must be explicit")

    note = load("flow_a/expected-approval-note.json")
    check("[SOP-114 §3.2]" in note["body"], "approval note lacks SOP citation")
    check(note["missingInformation"], "approval note must preserve missing information")
    check(any(section["id"] == "recommendation" for section in note["sections"]),
          "approval note recommendation section is missing")
    bundle = load("flow_a/report-bundle.json")
    check(len(bundle["files"]) == 2, "Flow A must contain a two-report bundle")
    extraction = load("flow_a/expected-bundle-extraction.json")
    check(extraction["documentsProcessed"] == 2, "bundle extraction count is incorrect")
    check("RECHECK WELD JOINT 4B" in extraction["handwrittenAnnotations"][0]["text"],
          "handwritten annotation is missing")
    sovereignty = load("flow_a/sovereignty-proof.json")
    check(sovereignty["externalRequests"] == 0 and sovereignty["blockedAttempt"]["recorded"],
          "Flow A sovereignty proof is incomplete")


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

    execution = load("flow_b/expected-python-execution.json")
    summary = load("flow_b/expected-out-of-range-summary.json")
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


def validate_flow_c() -> None:
    required = [
        "pump-skid-P204.svg",
        "piping-spec-SOP-220.md",
        "expected-compliance-assessment.json",
        "corrective-action-note.md",
        "sovereignty-proof.json",
    ]
    for filename in required:
        path = FLOW_C / filename
        check(path.exists() and path.stat().st_size > 0, f"Flow C fixture is missing or empty: {filename}")
    drawing = (FLOW_C / "pump-skid-P204.svg").read_text(encoding="utf-8")
    check("CLASS 150" in drawing and "DN80" in drawing, "drawing discrepancies are missing")
    spec = (FLOW_C / "piping-spec-SOP-220.md").read_text(encoding="utf-8")
    check("[SOP-220 §4.2]" in spec and "[SOP-220 §4.3]" in spec, "piping criteria are missing")
    assessment = load("flow_c/expected-compliance-assessment.json")
    check(len(assessment["checks"]) == 2, "Flow C must contain two compliance checks")
    check(all(item["status"] == "non_compliant" for item in assessment["checks"]),
          "Flow C checks must be non-compliant")
    check({item["citation"] for item in assessment["checks"]} == {"[SOP-220 §4.2]", "[SOP-220 §4.3]"},
          "Flow C citations are incomplete")
    check(assessment["noApprovalClaim"] is True, "Flow C must not claim approval")
    sovereignty = load("flow_c/sovereignty-proof.json")
    check(sovereignty["externalRequests"] == 0 and sovereignty["blockedAttempt"]["recorded"],
          "Flow C sovereignty proof is incomplete")


def validate_manifest() -> None:
    manifest = load("manifest.json")
    check(manifest["fixtureVersion"] == "2.0.0", "unexpected fixture version")
    for relative, details in manifest["files"].items():
        path = ROOT / relative
        check(path.exists(), f"manifest file is missing: {relative}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        check(digest == details["sha256"], f"manifest hash mismatch: {relative}")
        check(path.stat().st_size == details["bytes"], f"manifest size mismatch: {relative}")


def main() -> None:
    validate_flow_a()
    validate_flow_b()
    validate_flow_c()
    validate_manifest()
    print("Fixture preflight passed: Flow A, Flow B, and Flow C are deterministic and internally consistent.")


if __name__ == "__main__":
    main()
