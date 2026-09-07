# Sovereign Workbench fixed demo fixtures

This directory is the immutable input and oracle bundle for the two locked
offline demos. The canonical behavior is defined in `docs/demo-requirements.md`.

The Flow A report uses the deterministic report reference `IR-E201-2026-08-20`
and inspection date `2026-08-20`. These values are recorded in `manifest.json`
and in the report itself so the final demo never invents them.

## Contents

- `flow-a/inspection-report-E201.pdf`: two-page clean typed inspection report.
- `flow-a/sop-114-pressure-equipment-inspection.md`: seeded SOP corpus entry.
- `flow-a/approval-note-template-TPL-012.md`: seeded template corpus entry.
- `flow-a/expected-ocr.json`: exact OCR oracle.
- `flow-a/expected-retrieval.json`: top-five retrieval oracle.
- `flow-a/expected-approval-note.json`: exact four-section draft oracle.
- `rag-corpus/`: ten-document local-only RAG corpus metadata bundle, including
  stable section IDs, Chroma metadata fields, expected queries, and a no-match
  case.
- `flow-b/reactor-temperature-log.csv`: 240-row fixed input.
- `flow-b/expected-task.py`: safe golden code response used by offline tests.
- `flow-b/expected-python-execution.json`: execution oracle.
- `flow-b/expected-out-of-range-summary.json`: semantic spreadsheet oracle.
- `flow-b/expected-out-of-range-summary.csv`: expected flagged-row data.
- `build_fixtures.py`: reproducible PDF/CSV builder and manifest generator.
- `validate_fixtures.py`: offline fixture and golden-code test runner.
- `manifest.json`: hashes and locked expectations for every fixture.

Run the preflight test from this directory:

```text
python validate_fixtures.py
```

The validator uses only the Python standard library. It checks the PDF page
structure and embedded text, report/SOP/template consistency, CSV counts and
outliers, contract-shaped JSON oracles, golden Python execution, and manifest
hashes.

Validate the corpus metadata separately with:

```text
python rag-corpus/validate_corpus.py
```

The corpus is file-backed and does not call an embedding API. The intended
index configuration is the local `BAAI/bge-small-en-v1.5` model with 384
dimensions and cosine distance. Chroma indexing remains a later integration
step once the local model weights and backend indexer are available.
