"""Check that demo contains only prompts and the files used in each scenario."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
ROOT = PROJECT / "demo"
MANIFEST = Path(__file__).resolve().with_name("demo-manifest.json")

SCENARIOS = {
    "flow_a/scenario-1": {"mode": "work", "attach": ["inspection-report-E201-annotated.pdf", "inspection-report-E202-followup.pdf"], "kb": ["sop-114-pressure-equipment-inspection.md"], "workspace": []},
    "flow_a/scenario-2": {"mode": "chat", "attach": ["gauge-calibration-register.md"], "kb": ["maintenance-procedure.md"], "workspace": []},
    "flow_a/scenario-3": {"mode": "agent", "attach": [], "kb": ["closeout-procedure.md"], "workspace": ["repair-closeout-packet.md"]},
    "flow_b/scenario-1": {"mode": "work", "attach": ["broken-vendor-log-parser.py", "vendor-maintenance-log.csv"], "kb": [], "workspace": []},
    "flow_b/scenario-2": {"mode": "chat", "attach": ["cold-room-readings.csv"], "kb": ["monitoring-rule.md"], "workspace": []},
    "flow_b/scenario-3": {"mode": "agent", "attach": [], "kb": [], "workspace": ["coldroom.py", "tests/test_coldroom.py"]},
    "flow_c/scenario-1": {"mode": "chat", "attach": ["pump-skid-P204.svg"], "kb": ["piping-spec-SOP-220.md"], "workspace": []},
    "flow_c/scenario-2": {"mode": "work", "attach": ["relief-valve-register.csv"], "kb": ["process-safety-standard.md"], "workspace": []},
    "flow_c/scenario-3": {"mode": "agent", "attach": [], "kb": ["utility-standard-UT-9.md"], "workspace": ["utility-manifold-U18.svg"]},
}


FLOW_C_ONLY = "--flow-c" in sys.argv
if FLOW_C_ONLY:
    SCENARIOS = {name: spec for name, spec in SCENARIOS.items() if name.startswith("flow_c/")}


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def validate_layout() -> None:
    actual_dirs = {p.relative_to(ROOT).as_posix() for p in ROOT.rglob("*") if p.is_dir() and (p / "prompt.md").exists() and (not FLOW_C_ONLY or p.relative_to(ROOT).as_posix().startswith("flow_c/"))}
    check(actual_dirs == set(SCENARIOS), f"Scenario folders differ: {sorted(actual_dirs ^ set(SCENARIOS))}")
    expected_paths: set[str] = set()
    for relative, spec in SCENARIOS.items():
        folder = ROOT / relative
        prompt_path = folder / "prompt.md"
        check(prompt_path.is_file(), f"Missing prompt: {relative}/prompt.md")
        prompt = prompt_path.read_text(encoding="utf-8")
        check(re.search(rf"(?mi)^\*\*Chat type:\*\*\s*{spec['mode']}\s*$", prompt) is not None,
              f"Wrong or missing chat type in {relative}/prompt.md")
        for label, files in (("Files to attach", spec["attach"]), ("Knowledge base files", spec["kb"])):
            start = prompt.find(f"**{label}:**")
            check(start >= 0, f"Missing {label} in {relative}/prompt.md")
            section = prompt[start:].split("\n\n", 1)[0]
            listed = re.findall(r"`([^`]+)`", section)
            listed = [] if "None." in section else listed
            check(listed == files, f"{label} list in {relative}/prompt.md must be {files}, found {listed}")
            for name in files:
                check((folder / name).is_file(), f"Prompt names missing file: {relative}/{name}")
        expected_paths.add(f"{relative}/prompt.md")
        expected_paths.update(f"{relative}/{name}" for name in spec["attach"] + spec["kb"])
        if spec["mode"] == "agent":
            check("**Agent workspace:**" in prompt, f"Agent workspace missing from {relative}/prompt.md")
            for name in spec["workspace"]:
                check((folder / "workspace" / name).is_file(), f"Missing Agent workspace file: {relative}/workspace/{name}")
                expected_paths.add(f"{relative}/workspace/{name}")
        actual_files = {p.relative_to(ROOT).as_posix() for p in folder.rglob("*") if p.is_file()}
        local_expected = {p for p in expected_paths if p.startswith(relative + "/")}
        check(actual_files == local_expected, f"Unexpected or missing files in {relative}: {sorted(actual_files ^ local_expected)}")
    for flow in (("flow_c",) if FLOW_C_ONLY else ("flow_a", "flow_b", "flow_c")):
        modes = [spec["mode"] for name, spec in SCENARIOS.items() if name.startswith(flow + "/")]
        check(sorted(modes) == ["agent", "chat", "work"], f"{flow} must have one chat, one work, and one agent scenario")


def validate_inputs() -> None:
    for relative in (() if FLOW_C_ONLY else ("flow_a/scenario-1/inspection-report-E201-annotated.pdf", "flow_a/scenario-1/inspection-report-E202-followup.pdf")):
        check((ROOT / relative).read_bytes().startswith(b"%PDF-"), f"Invalid PDF: {relative}")
    with (ROOT / "flow_b/scenario-2/cold-room-readings.csv").open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    check(len(rows) == 8, "Cold-room demo input must contain eight rows")
    check({row["temp_c"] for row in rows if row["temp_c"]} == {"3.2", "5.0", "5.1", "1.9", "2.0", "4.8", "6.4"}, "Cold-room values changed")
    drawing = (ROOT / "flow_c/scenario-1/pump-skid-P204.svg").read_text(encoding="utf-8")
    check("data:image/png;base64," in drawing and "DN80 discharge" in drawing and "CLASS 150" not in drawing, "Drawing must preserve visible image-only evidence")


def validate_manifest() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    check(manifest["fixtureVersion"] == "2.1.0", "Unexpected fixture version")
    actual = {p.relative_to(ROOT).as_posix() for p in ROOT.rglob("*") if p.is_file()}
    check(actual == set(manifest["files"]), "Manifest file list does not match the minimal demo folders")
    for relative, details in manifest["files"].items():
        path = ROOT / relative
        check(hashlib.sha256(path.read_bytes()).hexdigest() == details["sha256"], f"Manifest hash mismatch: {relative}")
        check(path.stat().st_size == details["bytes"], f"Manifest size mismatch: {relative}")


def main() -> None:
    validate_layout()
    validate_inputs()
    validate_manifest()
    print("Demo fixtures passed: selected scenario folders contain only prompts, attachments, knowledge files, and Agent workspace inputs.")


if __name__ == "__main__":
    main()
