Yes. In practical terms, the backend needs to become the runtime layer for the contracts and prompts already prepared in `ai/`.

The existing database/chat implementation can stay. Most work is adding the missing AI execution pipeline around it.

### 1. Connect backend to the AI contracts

Change:

- `backend/src/shared/contracts.ts`

It is currently empty. It should expose the types from `ai/contracts.ts`, including:

- Model requests/responses.
- Vision results.
- Draft results.
- Code results.
- Errors.
- `PythonExecutionResult`.

The AI contract should also gain a dedicated post-execution summarization request for Flow B, because the backend must send real execution output back to the code model.

### 2. Add complete IPC support

Extend:

- `backend/src/main/ipc/channels.ts`
- `backend/src/main/ipc/validators.ts`
- `backend/src/main/ipc/handlers.ts`
- `backend/src/main/index.ts`

Add IPC operations for:

- Starting a run.
- Registering file attachments.
- Confirming or rejecting actions.
- Cancelling runs.
- Getting run history.
- Getting generated artifacts.
- Checking model health.
- Streaming run events to the renderer.

The existing chat IPC channels should remain.

### 3. Add run-scoped file handling

Create:

- `backend/src/main/run/filesystem.ts`
- Attachment persistence helpers.
- Artifact persistence helpers.
- Run persistence helpers.

This layer must:

- Create `data/runs/<runId>/input`, `intermediate`, `output`, and `logs`.
- Convert dropped files into opaque attachment tokens.
- Reject absolute paths and `..` traversal.
- Prevent cross-run access.
- Enforce file type and size limits.
- Keep model-provided paths from becoming unrestricted filesystem paths.

The existing SQLite schema already has tables for attachments, runs, artifacts, and execution results, but backend DAOs and runtime logic are missing.

### 4. Implement the model gateway

Create:

- `backend/src/main/gateway/registry.ts`
- `backend/src/main/gateway/model-gateway.ts`
- `backend/src/main/gateway/openrouter.ts`
- `backend/src/main/gateway/local-llm.ts`
- `backend/src/main/gateway/normalizer.ts`
- `backend/src/main/health/health-check.ts`

Responsibilities:

- Load and validate `backend/config/models.json`.
- Resolve stable IDs such as `vision-qwen25vl`.
- Call OpenRouter during development.
- Support LAN-local model servers later.
- Send vision attachments correctly.
- Request structured JSON responses.
- Apply timeouts and response-size limits.
- Parse model responses.
- Remove Markdown fences if needed.
- Convert provider failures into the defined `AIError` codes.
- Never expose API keys to the renderer, logs, SQLite, or model output.

The existing model configuration already maps the three AI routes:

- Vision → Qwen2.5-VL.
- Drafting → Qwen3.
- Coding → Qwen2.5-Coder.

### 5. Add runtime response validators

Create:

- `backend/src/main/validators/common.ts`
- `backend/src/main/validators/vision.ts`
- `backend/src/main/validators/draft.ts`
- `backend/src/main/validators/code.ts`

These must validate actual model JSON at runtime.

They should check:

- Required fields and no unknown fields.
- Matching request/run/model IDs.
- Valid page references.
- Valid finding evidence.
- Exactly the required approval-note sections.
- Citations belong to retrieved knowledge chunks.
- No unsupported recommendations.
- `task.py` is the only generated script.
- Only allowed imports are used.
- No subprocess, shell, network, dynamic execution, or unrestricted paths.
- Input and output filenames are logical fixture names, not arbitrary paths.

TypeScript types alone cannot provide these protections at runtime.

### 6. Add run state and event handling

Create:

- `backend/src/main/run/state-machine.ts`
- `backend/src/main/run/run-manager.ts`
- `backend/src/shared/events.ts`
- `backend/src/shared/errors.ts`

The backend needs to track:

- `created`
- `classifying`
- `planning`
- `acting`
- `awaiting_confirmation`
- `completed`
- `failed`
- `cancelled`

It should persist transitions and emit events such as:

- Routing selected.
- Tool started.
- Tool completed.
- Confirmation required.
- Artifact ready.
- Error.
- Run state changed.

It should also enforce the eight-iteration limit and prevent cancelled or failed runs from producing artifacts.

### 7. Add deterministic routing

Create:

- `backend/src/main/router/deterministic-router.ts`

Routing should be backend-controlled:

- PDF/image inspection → vision model.
- CSV/code/calculation request → code model.
- Approval-note composition → drafting model.

The model must never choose its own endpoint, tool, or backend route.

### 8. Implement Flow A tools

Create:

- `backend/src/main/tools/read_file.ts`
- `backend/src/main/tools/ocr_extract.ts`
- `backend/src/main/tools/search_knowledge.ts`
- `backend/src/main/tools/draft_note.ts`
- `backend/src/main/tools/generate_docx.ts`

Flow A should run as:

1. Receive inspection report attachment.
2. Route to vision.
3. Extract and validate OCR findings.
4. Search local Chroma for `SOP-114 §3.2` and `TPL-012`.
5. Route to drafting model.
6. Validate sections and citation membership.
7. Ask for DOCX confirmation.
8. Generate DOCX and PDF.
9. Mark the run complete only after both artifacts exist.

The backend also needs a Chroma client/index integration. The embedding service remains separate from the three user-facing model routes.

### 9. Implement Flow B tools

Create:

- `backend/src/main/tools/draft_code.ts`
- `backend/src/main/tools/execute_python.ts`
- `backend/src/main/tools/generate_xlsx.ts`

Flow B should:

1. Detect CSV/code intent.
2. Read and validate the CSV.
3. Ask the code model for `task.py`.
4. Validate the generated Python.
5. Ask for execution confirmation.
6. Run the script in Bubblewrap:
   - Read-only input.
   - Writable run output directory.
   - No network.
   - Fixed Python executable.
   - 60-second timeout.
7. Capture the real `PythonExecutionResult`.
8. Verify `OUT_OF_RANGE 7/240 (high=5, low=2)`.
9. Ask for XLSX confirmation.
10. Generate the XLSX.
11. Call the code model again with the actual execution result.
12. Complete only if the final summary agrees with the verified execution.

The second summarization call is important: the model’s original `expectedResult` cannot count as proof that the script worked.

### 10. Add confirmations and cancellation

Create:

- `backend/src/main/confirmation/confirmation-store.ts`

It needs to support:

- Five-minute expiry.
- Exact `runId` and `actionId` matching.
- Replay rejection.
- Cancellation invalidation.
- Confirmation immediately before:
  - DOCX generation.
  - Python execution.
  - XLSX generation.

### 11. Add artifact generation and retrieval

The backend needs workers/services for:

- DOCX generation using `docx`.
- PDF conversion using local LibreOffice.
- XLSX generation using `exceljs`.
- Artifact metadata persistence.
- Renderer-safe artifact retrieval.

Artifacts should only be exposed as run-relative metadata, never arbitrary absolute paths.

### 12. Add sovereignty and health monitoring

Create:

- `backend/src/main/sovereignty/monitor-bridge.ts`

This should track:

- Model health.
- Embedding health.
- External request count.
- Allowed LAN services.
- Blocked egress evidence.

The final LAN deployment should be able to demonstrate zero external requests.

### 13. Add audit persistence

Extend the persistence layer with DAOs or an audit module for:

- Runs.
- State transitions.
- Routing decisions.
- Model calls.
- Tool calls.
- Confirmations.
- Citations.
- Execution results.
- Artifacts.
- Errors.

The existing schema already anticipates most of this; the missing piece is the backend code that writes and reads those records.

### 14. Add the missing test suites

Create tests for:

- `gateway.test.ts`
- `validators.test.ts`
- `filesystem.test.ts`
- `router.test.ts`
- `confirmation.test.ts`
- `flows.test.ts`
- `bubblewrap.test.ts`

They should cover malformed model output, unsupported citations, unsafe code, path traversal, cross-run access, confirmation replay, timeout, failed execution, and both locked demo flows.

In short, the backend currently has the persistence foundation. To run everything in `ai/`, it needs the gateway, validators, run manager, router, tools, sandbox, confirmation system, orchestration, artifact generation, event stream, and audit wiring described above.

The existing `backend/BACKEND_PLANS.md` already serves as a near-complete file-by-file implementation checklist.