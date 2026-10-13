# ai/draft — approval-note drafting (deferred Flow A)

Purpose: draft a structured approval note (`DraftResult`) from validated
vision findings and template requirements. The draft states missing
information explicitly and never guesses it.

## Files

- `contract.ts` — `DraftModelRequest` / `DraftModelResponse`, `DraftResult`
  (`title`, `body`, `sections`, `missingInformation`), `ApprovalNoteSection`
  (`equipment-header`, `findings-summary`, `recommendation`),
  `MissingInformation`.
- `prompts/approval-note-drafting-prompt.md` — the drafting prompt.

## Expected identity and health

- Stable identity `draft-qwen3` (see `../shared/types.ts`).
- Future standalone deployment: a model service reached over HTTP that
  reports health at `GET <baseUrl>/models` (the registry `healthPath`) and
  accepts `DraftModelRequest`.
- No server, weights, GPU startup, or supervisor is implemented here —
  this directory holds contracts and prompts only.

## Request/response boundary

- Request carries validated `findings` + `pageReferences` and
  `templateRequirements` (stable headings/formatting). It carries no
  filesystem paths and no external-source allowlists.
- Response is one JSON object with exactly the three sections in order,
  plus `title`, `body`, and `missingInformation`. Every material finding
  appears in `findings-summary`; unavailable fields are listed as missing,
  never invented.

## Configuration

Timeout and provider routing come from `config/models.json` via the backend.
Template headings are supplied per request in `templateRequirements`.

## Error behavior

Shape problems surface as `ValidationFailure`; transport problems as
`AIError`. Dropped sections, altered measurements, and invented facts are
rejections. Runtime validation is owned by the backend.

## Deployment assumptions
 
Stateless drafting step executed by `draft-qwen3`. Orchestrated by `RunManager`
during Flow A (inspection bundle -> SOP-114 criteria -> `.docx` approval note)
and Flow C (engineering drawing review -> SOP-220 criteria -> `.md` compliance note).
Film-ready demonstration fixtures and governing criteria live under `demo/flow_a/scenario-1/`
and `demo/flow_c/scenario-1/`. Evaluation oracles live under `tests/fixtures/demo/oracles/`.
