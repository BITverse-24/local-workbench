# ai/vision — typed-scan evidence extraction (deferred Flow A)

Purpose: turn a clean typed inspection-report scan into a structured,
evidence-backed `VisionResult` (`sourceText`, `findings`, `pageReferences`,
optional `warnings`). This service never approves equipment and never
consults external sources — every finding must point at page evidence.

## Files

- `contract.ts` — `VisionModelRequest` / `VisionModelResponse`,
  `VisionResult`, `Finding`, `PageReference`, `Confidence`.
- `prompts/ocr-vision-prompt.md` — the fixed extraction prompt.

## Expected identity and health

- Stable identity `vision-qwen25vl` (see `../shared/types.ts`).
- Future standalone deployment: a model service reached over HTTP that
  reports health at `GET <baseUrl>/models` (the registry `healthPath`) and
  accepts `VisionModelRequest` with `inputMode: "typed-scan"`.
- No server, weights, GPU startup, or supervisor is implemented here —
  this directory holds contracts and prompts only.

## Request/response boundary

- Request carries an `AttachmentReference` (a run-scoped file token, never a
  filesystem path) plus `inputMode: "typed-scan"`.
- Response is one JSON object with exactly `sourceText`, `findings`,
  `pageReferences` (plus optional `warnings`): unique IDs, one-based page
  numbers, non-empty `pageReferenceIds` per finding, and claim values
  supported by `sourceText` or the referenced page text.

## Configuration

Timeout and provider routing come from `config/models.json` via the backend.
The only supported input mode is `typed-scan`; handwriting, stamps, and
diagrams are reported as `warnings`, never interpreted as facts.

## Error behavior

Shape problems surface as `ValidationFailure`; transport problems as
`AIError`. Unknown page-reference IDs, missing evidence, and unsupported
claims are `invalid-value` failures.

## Deployment assumptions

Stateless extraction step. The backend validates the result before any
downstream use. Flow A (scanned-report-to-approval-note) is deferred, so
this contract is currently exercised by offline fixtures and tests only.

Historical note: the pre-migration version of this flow fed vision output
into a retrieval step; that coupling was removed during the migration, see
`docs/archive/rag-legacy/`.
