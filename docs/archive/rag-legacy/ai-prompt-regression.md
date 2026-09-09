# Prompt regression tests (Task 10)

Offline, provider-free regression spec for the three fixed prompts. No test calls OpenRouter, the filesystem outside the fixtures, or a live embedding service. The spec ties each prompt to a locked fixture, the exact validator, and a checked failure mode. Keep this file as the human-readable test plan; the runnable checks are in `ai/prompt-regression.test.ts`.

## How to run

```
npx --prefix backend vitest run ../ai/prompt-regression.test.ts
npx --prefix backend vitest run ../ai/mock-responses.test.ts
npx --prefix backend vitest run ../ai/validation.test.ts
python demo-fixtures/validate_fixtures.py
python demo-fixtures/rag-corpus/validate_corpus.py
```

## Fixture map

| Fixture | Path | Role |
|---|---|---|
| Inspection report PDF (2-page clean typed) | `demo-fixtures/flow-a/inspection-report-E201.pdf` | Vision input |
| OCR oracle | `demo-fixtures/flow-a/expected-ocr.json` | Expected `VisionResult` |
| Retrieval oracle (top 5) | `demo-fixtures/flow-a/expected-retrieval.json` | Expected chunks, must include `SOP-114` section `3.2` |
| Draft oracle (4 sections) | `demo-fixtures/flow-a/expected-approval-note.json` | Expected `DraftResult` |
| SOP / template markdown | `demo-fixtures/flow-a/sop-114-*.md`, `approval-note-template-*.md` | RAG source truth |
| CSV 240 rows | `demo-fixtures/flow-b/reactor-temperature-log.csv` | Code input |
| Golden Python | `demo-fixtures/flow-b/expected-task.py` | Safe reference impl |
| Execution oracle | `demo-fixtures/flow-b/expected-python-execution.json` | `exitCode 0`, `OUT_OF_RANGE 7/240 (high=5, low=2)` |
| Summary oracle | `demo-fixtures/flow-b/expected-out-of-range-summary.json` + `.csv` | 7 rows (5 high, 2 low) |
| Manifest / corpus queries | `demo-fixtures/manifest.json`, `demo-fixtures/rag-corpus/queries.json` | Locked hashes + query expectations |
| Offline mock envelopes | `ai/mock-responses/*.json` | Provider-free `ModelResponse` fixtures |

Validators: `ai/validation.ts` (`validateVisionResult`, `validateDraftResult`, `validateCodeDraftResult`, `LOCKED_FLOW_A_REQUIRED_FINDINGS`, `LOCKED_FLOW_B_CODE_RULES`, `REQUIRED_DRAFT_SECTIONS`). Contracts: `ai/contracts.ts`. Prompts: `ai/ocr-vision-prompt.md`, `ai/approval-note-drafting-prompt.md`, `ai/coding-prompt.md`.

---

## 1. OCR / vision -- `vision-qwen25vl` -- `ai/ocr-vision-prompt.md`

Model: `qwen/qwen2.5-vl-3b-instruct` via OpenRouter in dev, stable ID `vision-qwen25vl`, 60s timeout, `typed-scan` only.

### Input fixture

- `demo-fixtures/flow-a/inspection-report-E201.pdf` supplied as `VisionModelRequest.attachment` with `inputMode: "typed-scan"`.
- Text oracle `demo-fixtures/flow-a/expected-ocr.json` (also `ai/mock-responses/successful-ocr.json`): Report ID `IR-E201-2026-08-20`, Inspection date `2026-08-20`, Equipment `E-201`, unit `R-100`, `Rows 12-15 measured 3.8-4.2 mm; minimum allowable 4.6 mm`, pitting `1.8 mm`, gasket `Replacement recommended`.

### Required output fields

- Single JSON object only, no Markdown fences, no extra fields. Keys: `sourceText`, `findings`, `pageReferences`, optional `warnings`.
- `sourceText: string` non-empty, verbatim transcription of readable typed text.
- `findings[]` each: `findingId`, `title`, `value`, `pageReferenceIds` (non-empty), `confidence` (`high|medium|low`), `evidence` -- all non-empty strings, `findingId` unique.
- `pageReferences[]` each: `id` unique, `page` positive one-based integer, `text` non-empty verbatim excerpt, optional `location`.
- Every `pageReferenceIds` entry must exist in `pageReferences`.

### Expected values (locked Flow A)

- Exactly 3 findings matching `LOCKED_FLOW_A_REQUIRED_FINDINGS`:
  - finding-1 title includes `tube wall thickness`, page 1, value includes `3.8`, `4.2`, `4.6`.
  - finding-2 title includes `pitting corrosion`, page 1, value includes `1.8`.
  - finding-3 title includes `gasket degradation`, page 2, value includes `replacement`.
- `page-ref-1` page 1 thickness excerpt, `page-ref-2` page 1 pitting excerpt, `page-ref-3` page 2 gasket excerpt.
- `sourceText` contains `IR-E201-2026-08-20`, `E-201`, and the three measurement strings.
- `warnings: []` for the clean scan.

### Allowed variation

- Whitespace / dash normalisation (NFKC), case in titles/evidence. Measurement numbers, units, and page numbers must be exact.
- `confidence` may be `medium`/`low` only when the same uncertainty is represented in `warnings`/`evidence`; clean fixture expects `high`.
- `location` wording may vary if it still identifies the table/section. `id` values may vary if unique and correctly referenced.
- `sourceText` line breaks may vary; must not omit a measurement or limit.

### Failure conditions

- Not a single JSON object, missing/extra/null field, Markdown fence (triple backticks).
- Missing any of the 3 required findings, duplicate `findingId`/`id`, `page < 1` or non-integer, unknown or empty `pageReferenceIds`.
- `value`/`evidence` not grounded in `sourceText` + referenced page text (lexical check `textSupportsClaim`).
- Inferred cause/severity/compliance/approval status, invented or corrected date/measurement, or interpreting handwriting/stamps/diagrams as fact without a warning.
- `warnings` omitted when scan ambiguous, or non-string entries.
- Negative fixture must be rejected: `ai/mock-responses/invalid-ocr-output.json` (unknown page-ref, missing findings).

Regression assertions:
- OCR must find the known inspection issue (all 3 findings with correct pages/values).
- OCR must not invent an inspection date or other unstated fact.

---

## 2. Approval-note drafting -- `draft-qwen3` -- `ai/approval-note-drafting-prompt.md`

Model: `qwen/qwen3-4b`, stable ID `draft-qwen3`, 45s timeout, structured output, DOCX-ready prose.

### Input fixture

- `findings` + `pageReferences` + `sourceText` from validated `VisionResult` (the OCR oracle above).
- `retrievedChunks` from `demo-fixtures/flow-a/expected-retrieval.json` (5 chunks). Minimum required: `SOP-114` section `3.2` excerpt `"When a report identifies a tube-wall measurement below... [SOP-114 3.2]"` and `TPL-012` template chunks.
- `templateRequirements` -- stable headings from retrieval result.
- Mock success: `ai/mock-responses/successful-drafting.json` (4 sections, `SOP-114` section `3.2`).
- Mock no-source: `ai/mock-responses/no-matching-knowledge-source.json` with `retrievedChunks: []`.
- Mock failures: `unsupported-citation-draft.json` (cites `SOP-999` section `9.9`), `missing-sections-draft.json` (only 3 sections).
- Query expectation `demo-fixtures/rag-corpus/queries.json` `flow-a-approval-note` must include `SOP-114` section `3.2`.

### Required output fields

- Single JSON object, no Markdown, no extra fields. Keys: `title`, `body`, `sections`, `citations`, `missingInformation`.
- `title: string` non-empty.
- `body: string` DOCX-ready, contains the four sections plus citations.
- `sections: ApprovalNoteSection[4]` exactly `REQUIRED_DRAFT_SECTIONS` in order: `equipment-header`, `findings-summary`, `recommendation`, `grounding-references`; each `id`/`heading`/`body` non-empty.
- `citations[]` each: `documentId`, `sectionId`, `label` (`SOP-114 3.2`), `inlineText` (`[SOP-114 3.2]`), optional `supportingExcerpt` that must be substring of the matching chunk excerpt (normalized).
- `missingInformation[]` each: `field`/`note` non-empty; must explicitly mark unavailable fields, never silently omit or guess.

### Expected values (locked Flow A)

- `equipment-header` contains `E-201` and `IR-E201-2026-08-20` when present in OCR.
- `findings-summary` contains all 3 OCR findings with measurements (`3.8-4.2 mm`, `4.6 mm`, `1.8 mm`, `gasket ... replacement`).
- `recommendation` is conditional clearance pending retubing of the affected tubes (and gasket replacement recorded before return to service) with marker `[SOP-114 3.2]` in both `body` and `sections[2].body`.
- `grounding-references` body contains `[SOP-114 3.2]`.
- `citations` contains entry `documentId: SOP-114`, `sectionId: 3.2`, `label: SOP-114 3.2`, `inlineText: [SOP-114 3.2]`, `supportingExcerpt` equal/contained in the retrieved `SOP-114` section `3.2` excerpt.
- `missingInformation` contains at least one entry (e.g. `approvalAuthority` or `inspectionDate` note stating not present in supplied OCR).
- No-source case: `citations: []`, no bracket citation marker in `body`/`sections`, and `missingInformation` contains a notice matching `/source|retriev|knowledge|sop|template/i`.

### Allowed variation

- Wording of `title`/`body`/`section` prose may vary if every claim remains grounded in findings/page texts/retrieved excerpts.
- `heading` capitalization may vary; `id` order/spelling must not.
- `missingInformation` field name may be `approvalAuthority`, `inspectionDate`, or `knowledgeSources` as long as note accurately reflects absence; extra grounded missing fields are allowed.
- `supportingExcerpt` may be normalized substring, not byte-identical.

### Failure conditions

- Not one JSON object, missing/extra field, wrong section count/order/ID, empty string field.
- `label` != `documentId sectionId` or `inlineText` != `[label]` (section marker is part of label).
- Citation identity not in `retrievedChunks` allowlist, or `supportingExcerpt` not contained in matched chunk excerpt.
- Required citation `SOP-114` section `3.2` absent when `retrievedChunks` non-empty.
- Claim in `body`/`sections` not grounded in `sourceText`/findings/page texts/retrieved excerpts (`findUnsupportedClaims`).
- Invented inspection date, approval date/authority, or measurement; silently omitting a missing field instead of listing it.
- `retrievedChunks: []` but `citations.length > 0` or bracket marker present, or missing the explicit no-source notice.
- Negative fixtures must be rejected: unsupported citation, missing `grounding-references`.

Regression assertions:
- Draft must cite `SOP-114` section `3.2` exactly.
- Draft must not invent an inspection date or any other unsupported fact -- missing data must appear in `missingInformation`.

---

## 3. Code generation -- `code-qwen25coder` -- `ai/coding-prompt.md`

Model: `qwen/qwen2.5-coder-7b-instruct`, stable ID `code-qwen25coder`, 60s timeout, code generation.

### Input fixture

- `reactor-temperature-log.csv` -- 240 rows, cols `timestamp`, `reactor_id`, `temperature_c`, `R-101`, limits `LOWER 250.0` exclusive, `UPPER 350.0` exclusive.
- Task: identify out-of-range rows, classify `high` (`>350`) vs `low` (`<250`), write `out-of-range-rows.csv` with `direction`, print `OUT_OF_RANGE 7/240 (high=5, low=2)`, exit 0, deterministic.
- Mock success: `ai/mock-responses/successful-code-generation.json`.
- Golden files: `demo-fixtures/flow-b/expected-task.py`, `expected-out-of-range-summary.json`/`.csv`, `expected-python-execution.json`.
- Mock failure: `ai/mock-responses/malformed-code-response.json` (missing `source`, has `unexpectedField`).

### Required output fields

- Single JSON object, no Markdown, no extra fields. Keys: `filename`, `source`, `expectedResult`, `inputFiles`, `outputFiles`, `allowedImports`.
- `filename: "task.py"` exactly.
- `source: string` Python only, non-empty, `<=100k` chars.
- `expectedResult: string` must contain `OUT_OF_RANGE 7/240 (high=5, low=2)`.
- `inputFiles: ["reactor-temperature-log.csv"]` exactly.
- `outputFiles: ["out-of-range-rows.csv"]` exactly.
- `allowedImports: ["csv", "datetime"]` (or subset `["csv"]` if datetime unused) -- no other imports.

### Expected values (locked Flow B)

- `source` reads `reactor-temperature-log.csv` and writes `out-of-range-rows.csv` with fieldnames `timestamp,reactor_id,temperature_c,direction`.
- Execution against the fixed CSV produces `stdout OUT_OF_RANGE 7/240 (high=5, low=2)` and 7 flagged rows (5 high, 2 low) matching `expected-out-of-range-summary.json` timestamps/temperatures in input order; `exitCode 0`.
- `expectedResult` contains the summary line verbatim.
- No hard-coded counts in `source` -- must calculate, not contain literal `OUT_OF_RANGE 7/240`, `high=5`, `low=2` as short-circuit.

### Allowed variation

- Variable/function names, whitespace, loop style may vary.
- `allowedImports` may be `["csv"]` if `datetime` not used; order must be unique.
- `expectedResult` may have surrounding text if it includes the required summary substring.
- Output CSV row order must match input order (oracle order); no extra files/columns.

### Failure conditions

- Not one JSON object, missing/extra field, wrong filename, wrong `inputFiles`/`outputFiles`, non-logical filename with `/` or `..`.
- `source` contains Markdown fences or unsafe patterns (`subprocess|socket|requests|urllib`, `os.system|Popen|shell=`, `eval|exec|compile|__import__`, `os.environ|pathlib|shutil`, triple backticks) -- `UNSAFE_CODE_PATTERNS`.
- `source` imports a module not in `allowedImports` (regex `^` + `from|import` check).
- `source` opens a file other than the two fixed names, or does not mention both names.
- `source` hard-codes `OUT_OF_RANGE 7/240` / `high=5` / `low=2` instead of calculating.
- `source` missing/non-string/empty; `expectedResult` missing required substring.
- Backend must still sandbox-execute and compare actual `PythonExecutionResult` to oracle -- `expectedResult` alone is not proof of execution.
- Negative fixture must be rejected: `malformed-code-response.json`.

Regression assertions:
- Code must flag the known out-of-range CSV rows (7 rows, 5 high 2 low with correct timestamps).
- Code must return the expected summary (`OUT_OF_RANGE 7/240 (high=5, low=2)`) and sandbox execution must match `expected-python-execution.json`.

---

## Cross-cutting rules

- All three prompts require one JSON object; unknown fields rejected by `exactKeys`.
- Model responses are untrusted text; backend must re-validate envelope fields (`requestId`, `runId`, `modelId`, `taskType`) and `result` before use.
- `ai/prompt-regression.test.ts` ties prompts to fixtures and locked expectations; `ai/validation.test.ts` and `ai/mock-responses.test.ts` remain focused validator checks.
- Changing `demo-fixtures/manifest.json` hashes or embedding model `BAAI/bge-small-en-v1.5` (384 dims, cosine) requires rebuilding Chroma index and re-running `validate_corpus.py`.
