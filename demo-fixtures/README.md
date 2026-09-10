# Sovereign Workbench fixed demo fixtures

This directory is the immutable input and oracle bundle for both active
offline demos. The canonical behavior is defined in
`docs/demo-requirements.md`.

Flow A is an evidence-grounded approval-readiness assessment: the scan is
extracted, governing SOP criteria are applied, and the oracle records status,
required action, uncertainty, and citation for each decision point. The
approval-note template is a fixed output shape, not a retrieval oracle.

## Contents

- `flow-b/reactor-temperature-log.csv`: 240-row fixed input.
- `flow-b/expected-task.py`: safe golden code response used by offline tests.
- `flow-b/expected-python-execution.json`: execution oracle.
- `flow-b/expected-out-of-range-summary.json`: semantic spreadsheet oracle.
- `flow-b/expected-out-of-range-summary.csv`: expected flagged-row data.
- `flow-a/inspection-report-E201.pdf`: fixed scanned inspection input.
- `flow-a/expected-ocr.json`: OCR extraction oracle with page evidence.
- `flow-a/expected-assessment.json`: approval-readiness status/action oracle.
- `flow-a/expected-approval-note.json`: grounded approval-note oracle.
- `flow-a/sop-114-pressure-equipment-inspection.md`: governing local criteria.
- `flow-a/approval-note-template-TPL-012.md`: deterministic note structure.
- `build_fixtures.py`: reproducible fixture manifest generator.
- `validate_fixtures.py`: offline Flow A and Flow B fixture validator.
- `manifest.json`: hashes and locked expectations for both flows.

Run the preflight test from this directory:

```text
python validate_fixtures.py
```

The validator uses only the Python standard library. It checks CSV counts
and outliers, contract-shaped JSON oracles, golden Python execution, and
manifest hashes.
