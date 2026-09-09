# ai/tools — file tokens for model requests

Purpose: the file-reference schemas models are allowed to see. A model
never receives a filesystem path, a run directory, or shell access — only
opaque references the backend resolves inside its own run boundary.

## Files

- `contracts.ts` — `AttachmentReference` (registered upload token:
  `attachmentId`, `filename`, `mediaType`, `sizeBytes`, `relativePath` —
  the path is backend-relative, never an absolute user path) and
  `InputFileReference` (inspected CSV token with optional `columns` and
  `rowCount`).

## Request/response boundary

- Vision requests embed one `AttachmentReference`; code requests embed one
  `InputFileReference`. Both use logical filenames supplied for the current
  run; they never expose absolute filesystem paths to a model.
- The backend owns token issuance, run-scoped resolution, size/media-type
  enforcement, and sandbox mounts.

## Configuration

None. These are pure shapes with no endpoints or credentials.

## Error behavior

Unknown tokens, oversized files, and unsupported media types are rejected
by the backend before any model call; malformed references in model output
(e.g. path separators, `..`) are `invalid-value` validation failures.

## Deployment assumptions

References are meaningless outside the issuing backend run. Nothing here
touches IPC, storage, secrets, or the shell.
