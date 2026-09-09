# Sovereign Workbench fixed demo fixtures

This directory is the immutable input and oracle bundle for the one active
offline demo, Flow B (CSV → code → sandbox → XLSX). The canonical behavior
is defined in `docs/demo-requirements.md`.

Flow A (scanned-report-to-approval-note) is strictly deferred and active
retrieval is removed repo-wide: `flow-a/` and `rag-corpus/` were archived
under `docs/archive/rag-legacy/` during the migration, and `manifest.json`
below covers Flow B only.

## Contents

- `flow-b/reactor-temperature-log.csv`: 240-row fixed input.
- `flow-b/expected-task.py`: safe golden code response used by offline tests.
- `flow-b/expected-python-execution.json`: execution oracle.
- `flow-b/expected-out-of-range-summary.json`: semantic spreadsheet oracle.
- `flow-b/expected-out-of-range-summary.csv`: expected flagged-row data.
- `build_fixtures.py`: reproducible CSV builder and manifest generator
  (Flow B only).
- `validate_fixtures.py`: offline fixture and golden-code test runner
  (Flow B only).
- `manifest.json`: hashes and locked expectations for the Flow B fixtures.

Run the preflight test from this directory:

```text
python validate_fixtures.py
```

The validator uses only the Python standard library. It checks CSV counts
and outliers, contract-shaped JSON oracles, golden Python execution, and
manifest hashes.
