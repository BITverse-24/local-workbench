# ai/shared — shared envelopes and errors

Purpose: single home for the cross-service AI plumbing — stable model
identities, request/response envelopes, and workflow errors. Every service
contract (`vision`, `draft`, `code`) builds on these files and nothing else.

## Files

- `types.ts` — `TaskType`, `ModelId`, `ModelCapability`, `ModelRegistryEntry`,
  `ResponseFormat`, `ModelUsage`. Types only; the live registry data lives in
  `config/models.json` (owned by another lane) and is never duplicated here.
- `service-contract.ts` — `ModelRequestBase` / `ModelResponseBase`
  (`requestId`, `runId`, routing, prompts, timeouts) plus `ServiceIdentity`
  and `ModelHealth` shapes for status reporting.
- `errors.ts` — `AIError` / `AIErrorCode`, `ValidationFailure`,
  `AIWorkflowError`, `AIResult<T>`.

## Request/response boundary

- Every model call sends a `ModelRequestBase` derivative and receives a
  `ModelResponseBase` derivative. `requestId` echoes caller to response;
  `runId` scopes the call to one backend run; `completedAt` is an ISO
  timestamp; `usage` is advisory only.
- Callers must handle `AIResult<T>` explicitly — there are no thrown
  workflow errors across this boundary.

## Configuration

No credentials, endpoints, or model weights live here. Runtime routing
(`baseUrl`, provider model name, timeouts) is resolved by the backend from
`config/models.json` using the stable `ModelId`s defined in `types.ts`.

## Error behavior

- `AIError` covers transport/model problems (`model_unavailable`,
  `model_timeout`, `model_rejected_request`, `empty_model_response`,
  `invalid_model_response`, `unsupported_task`, `missing_required_content`,
  `unsafe_generated_code`).
- `ValidationFailure` covers responses with the wrong shape
  (`wrong-type`, `missing-field`, `invalid-value`, `extra-field`).

Historical note: retrieval-specific error codes and the old global
`ai/contracts.ts` dump were removed during the migration; see
`docs/archive/rag-legacy/`.
