# Backend Handoff: Responsibilities Outside the AI Layer

## Purpose

This document describes the work that must be implemented by the Electron main/backend owner around the AI layer.

The AI work provides the model-facing data shapes in ai/contracts.ts, prompt/fixture work, and model-specific result expectations. Those contracts describe the boundary between the backend and the model gateway; they do not implement the application backend, orchestration, filesystem isolation, sandboxing, persistence, IPC, or UI event delivery.

The backend should use this document together with:

- ai/contracts.ts
- ai/contracts.md
- docs/architecture/components-and-contracts.md
- docs/demo-requirements.md
- PRODUCT.md

The locked demo behavior in docs/demo-requirements.md is authoritative for the final flows.

## 1. What the AI layer provides

The AI layer provides or defines:

- TaskType: vision, draft, and code.
- Model IDs and registry entry shape.
- Model request and response shapes.
- Vision findings, source text, page references, and confidence values.
- Retrieved knowledge-chunk and citation shapes.
- Approval-note result sections and missing-information reporting.
- Generated Python result shape.
- Python execution-result shape for use by the backend after sandbox execution.
- AI errors and validation-failure shapes.
- Prompt-level expectations for OCR, drafting, and code generation.

The AI layer does not:

- Receive files from the renderer.
- Validate untrusted JSON at runtime unless a validator is explicitly added.
- Own the run lifecycle or state machine.
- Decide which filesystem paths are safe.
- Execute Python or create DOCX/XLSX files.
- Access Chroma, the filesystem, Electron IPC, or SQLite.
- Ask the user for confirmation.
- Enforce network isolation.
- Persist prompts, results, audit events, approvals, or artifacts.
- Stream backend events to the renderer.
- Decide whether a generated result is safe to use.
- Select arbitrary model endpoints.

The backend owns all of those responsibilities.

## 2. Required model-gateway boundary

The backend should wrap all model calls behind one internal gateway. The orchestrator should not call OpenRouter, mlx-lm, or llama-server directly.

An appropriate internal interface is:

~~~ts
interface ModelGateway {
  execute(request: ModelRequest): Promise<AIResult<ModelResponse>>;
  health(modelId: ModelId): Promise<ModelHealth>;
  cancel?(requestId: string): Promise<void>;
}

interface ModelHealth {
  modelId: ModelId;
  available: boolean;
  checkedAt: string;
  latencyMs?: number;
  message?: string;
}
~~~

The exact implementation may be HTTP or a local function call, but the rest of the backend should depend only on this normalized interface.

### Gateway responsibilities

The gateway must:

1. Resolve modelId through the approved model registry.
2. Reject disabled or unknown model IDs.
3. Reject a request whose task type is not allowed by the registry entry.
4. Check required capabilities, such as image input or structured output.
5. Resolve the API key from the configured environment variable when using OpenRouter.
6. Never expose an API key to the renderer, SQLite, logs, prompts, or committed files.
7. Translate the normalized request into the provider request format.
8. Add the required image/PDF content for vision requests.
9. Request structured JSON where supported.
10. Apply the configured timeout and response-size limit.
11. Parse the provider response into ModelResponse.
12. Return AIResult rather than throwing unclassified errors.
13. Preserve requestId and runId in all success and failure paths.
14. Map provider errors to the AIErrorCode values in ai/contracts.ts.
15. Avoid logging full confidential document contents or full prompts by default.

### Provider normalization

The local model servers and OpenRouter may differ in response details. The gateway must normalize them before returning a result:

- OpenAI-compatible chat response envelopes are provider-specific and must not escape the gateway.
- Provider message content must be parsed as JSON when structured output is requested.
- Markdown fences around JSON should either be removed safely or treated as invalid output according to the chosen policy.
- Provider finish reasons may be recorded in diagnostics but must not become the application result by themselves.
- Partial or truncated responses must become empty_model_response, invalid_model_response, or a more specific backend error.
- Streaming may be used for user-visible draft text, but the final persisted result must still be complete and validated.

## 3. Add runtime validators

The interfaces in ai/contracts.ts are compile-time types. They do not protect the application from malformed model JSON. The backend must add runtime schemas, preferably with Zod or an equivalent library.

At minimum, validate:

### Common response fields

- requestId matches the request.
- runId matches the active run.
- modelId matches the model that was called.
- completedAt is a valid timestamp.
- taskType matches the request discriminator.
- The response result has no unexpected fields if strict parsing is enabled.

### Vision results

- sourceText is a bounded string.
- Every finding has a unique findingId.
- Every pageReferenceIds entry points to an existing page reference.
- Page numbers are positive integers.
- Findings contain title, value, evidence, and confidence.
- Confidence is one of high, medium, or low.
- The fixed demo report produces all three expected findings.
- The result does not claim to support handwriting or unsupported document types.

### Draft results

- All four required section IDs are present:
  - equipment-header
  - findings-summary
  - recommendation
  - grounding-references
- Section IDs are unique.
- title, body, and section bodies are bounded strings.
- Every citation has a stable documentId and sectionId.
- Every citation exists in the current retrievedChunks set.
- The note does not cite a source that was not retrieved during this run.
- Missing information is explicit rather than silently invented.
- The fixed Flow A note contains [SOP-114 §3.2].

### Code results

- filename is exactly task.py.
- source is present and below a configured size limit.
- allowedLanguage is Python at the request boundary.
- No shell command, shell argument, subprocess invocation, or network client is accepted as an execution instruction.
- Imports are checked against the backend allowlist; the model's allowedImports field is advisory only.
- Declared input and output filenames are treated as logical names, not filesystem paths.
- The backend chooses the actual command, working directory, mounts, output directory, and timeout.

Validation failures must stop the relevant workflow step before the result is used or persisted as successful.

## 4. Complete the Flow B code contract

The current contract covers code generation and defines PythonExecutionResult, but Flow B also requires a final code-model summarization call after execution.

The backend should add one of these designs before implementing Flow B.

### Recommended design: explicit phase

~~~ts
type CodePhase = "generate" | "summarize";

interface CodeGenerateRequest extends CodeModelRequest {
  phase: "generate";
}

interface CodeSummarizeRequest extends ModelRequestBase {
  taskType: "code";
  modelId: "code-qwen25coder";
  responseFormat: "code-result";
  phase: "summarize";
  task: string;
  execution: PythonExecutionResult;
}
~~~

The summary request must contain the actual execution result, not the model's prediction. It should include:

- Exit code
- timedOut
- Capped stdout
- Capped stderr
- Actual output-file names
- The original user task
- The expected result from the code-draft step, if useful for comparison

A timeout or non-zero exit code must be represented as failed verification. It must never be summarized as a successful calculation.

## 5. Attachment and filesystem ownership

The renderer must never send a client-controlled absolute path to the backend.

### Required attachment flow

1. Renderer selects or drops a file.
2. Electron main validates the file type and size.
3. Electron main copies or registers it under the new run's attachment directory.
4. Electron main issues an opaque attachment token or ID.
5. The orchestrator resolves that ID to a backend-owned run-relative path.
6. The model gateway receives an AttachmentReference, never an unrestricted renderer path.

The backend must enforce:

- A run cannot access another run's attachments.
- relativePath cannot contain .. traversal.
- Symlinks and junctions cannot escape the run directory.
- Files are checked against an allowlist of media types and extensions.
- File sizes are bounded before model submission.
- PDFs/images sent to the vision model are read-only.
- Temporary converted images are run-scoped and cleaned up safely.
- Large source text is truncated or rejected according to a fixed policy.

Recommended layout:

~~~text
data/runs/<run-id>/
  input/
  intermediate/
  output/
  logs/
~~~

Large attachments and artifacts belong on disk. SQLite should store metadata and references, not duplicate large binary files or unrestricted prompt contents.

## 6. Run state machine and orchestration

Only Electron main/backend code may transition run state. The renderer can display state and request actions, but it cannot set state directly.

The backend must support at least:

~~~ts
type RunState =
  | "created"
  | "classifying"
  | "planning"
  | "acting"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled";
~~~

Required rules:

- A run receives a unique runId.
- Each model call receives a unique requestId.
- State transitions are validated and persisted.
- The run has a maximum of eight model/tool iterations.
- Cancellation is checked before every model call and tool call.
- A cancelled run cannot later create an artifact.
- A failed run cannot be reported as completed.
- A confirmation rejection or expiry cancels the protected action and leaves a clear audit event.
- Model output cannot directly choose arbitrary tools or endpoints.
- Tool calls are selected by backend policy and validated before execution.

The orchestrator should implement the plan → act → observe loop described in the architecture documents, while keeping model-specific details inside the gateway.

## 7. Deterministic routing

The backend router must own model selection. The model must not select its own endpoint.

Required routing behavior:

- Image/PDF inspection report → vision-qwen25vl.
- CSV, calculation, script, code, execution, or data-transformation request → code-qwen25coder.
- Other drafting requests → draft-qwen3.
- After Flow A OCR and retrieval, explicitly route to draft-qwen3.

Every route change must produce a visible routing event with:

- runId
- Task type
- Model ID
- Human-readable reason

The locked reasons are:

- Flow A first route: scanned report
- Flow A second route: compose approval note
- Flow B route: CSV/code intent

## 8. Backend tool implementations

All tool inputs and outputs must be runtime-validated in Electron main before execution, persistence, or use by the next step.

### read_file

Responsibilities:

- Resolve an attachment token or run-relative path.
- Enforce the run boundary.
- Inspect file metadata.
- For CSV, return bounded columns, row count, and representative metadata.
- Reject unsupported or oversized files.
- Never expose unrestricted filesystem access to the model.

### ocr_extract

Responsibilities:

- Pass the approved report attachment to the vision gateway.
- Validate the returned VisionResult.
- Confirm page-reference integrity.
- Emit a bounded transcript summary.
- Preserve the full validated intermediate result in the run workspace if needed.

### search_knowledge

Responsibilities:

- Query the local Chroma index only.
- Enforce topK <= 5 for the demo workflow.
- Return stable documentId, sectionId, labels, and excerpts.
- Return a structured no-match result when no suitable source exists.
- Ensure the retrieved chunks are associated with the current run.
- Never allow the drafting model to invent retrieval results.

### draft_note

Responsibilities:

- Build the draft request from validated findings and retrieved chunks.
- Validate the returned DraftResult.
- Check citation membership before any document-generation request.
- Reject missing SOP matches or unsupported citations.
- Do not call the document worker until the user approves it.

### generate_docx

Responsibilities:

- Require an active confirmation.
- Accept only validated title, sections, body, and citations.
- Generate approval-note-E201.docx for the fixed demo.
- Convert the DOCX to a PDF preview locally.
- Refuse to claim a preview exists if conversion fails.
- Write only under the run output directory.
- Return artifact metadata, not uncontrolled paths.

### draft_code

Responsibilities:

- Build a code-generation request from validated task and CSV metadata.
- Validate the returned CodeDraftResult.
- Display the source or a safe concise summary to the user.
- Never treat model output as an executable shell command.
- Never let the model select the sandbox command or mounts.

### execute_python

Responsibilities:

- Require an active confirmation.
- Use a fixed Python entrypoint and fixed runner policy.
- Mount the CSV/input read-only.
- Provide only a run-scoped writable output directory.
- Disable networking.
- Enforce the 60-second timeout.
- Cap stdout and stderr before persistence/display.
- Capture exit code, timeout state, duration, and output files.
- Treat timeout or non-zero exit as failed verification.

### generate_xlsx

Responsibilities:

- Use validated result rows from execution, not unverified model claims.
- Require a separate confirmation.
- Write out-of-range-summary.xlsx under the run output directory.
- Return an artifact reference.
- Reject rows that are not present in the validated execution output.

## 9. Confirmation, cancellation, and expiry

The backend must implement confirmation as server-owned state, not merely a UI modal.

~~~ts
interface PendingAction {
  actionId: string;
  runId: string;
  kind: "generate_docx" | "execute_python" | "generate_xlsx";
  prompt: string;
  createdAt: string;
  expiresAt: string;
}

interface ConfirmActionInput {
  runId: string;
  actionId: string;
  approved: boolean;
}
~~~

Required behavior:

- DOCX generation requires approval.
- Python execution requires approval.
- XLSX generation requires a second approval.
- Approval is valid only for the exact runId and actionId.
- An action expires after five minutes.
- A rejected or expired action cannot be replayed.
- Cancellation invalidates all pending actions for that run.
- Approval/rejection/expiry is persisted with timestamp and outcome.
- The protected operation checks the action again immediately before execution.

Locked confirmation prompts:

- Generate the approval-note DOCX?
- Execute the generated Python?

## 10. Renderer IPC and event delivery

The renderer should receive a narrow typed bridge only. It must not receive Node, filesystem, model, or raw IPC access.

The backend should expose the equivalent of:

~~~ts
interface WorkbenchBridge {
  startRun(input: StartRunInput): Promise<{ runId: string }>;
  confirmAction(input: ConfirmActionInput): Promise<void>;
  cancelRun(input: { runId: string }): Promise<void>;
  getArtifact(input: { runId: string; artifactId: string }): Promise<ArtifactRef>;
  getRunHistory(input?: { limit?: number }): Promise<RunSummary[]>;
  onRunEvent(listener: (event: RunEvent) => void): () => void;
}
~~~

At minimum, stream these events in order:

- Run state changes
- Routing changes
- Plan steps
- Tool calls
- Tool results
- Confirmation requests
- Artifact readiness
- Errors

Events must include the runId. Event summaries should be safe for the renderer and should not expose API keys, unrestricted paths, or unnecessarily sensitive source documents.

The renderer must be able to show the exact demo narrative:

- Flow A: vision → OCR → knowledge search → draft → confirmation → DOCX/PDF.
- Flow B: code → file inspection → code draft → confirmation → Python execution → confirmation → XLSX → final summary.

## 11. Persistence and audit trail

SQLite should store enough information to explain a complete run after the UI is closed.

Persist at least:

- Run ID and creation/completion timestamps
- User request summary
- Attachment metadata
- Run state transitions
- Routing decisions and reasons
- Model IDs and request IDs
- Tool calls and bounded results
- Confirmation requests and outcomes
- Citation references
- Artifact metadata
- Execution exit code, timeout, duration, and capped logs
- Failure codes and messages

Do not persist:

- API keys
- Unrestricted absolute paths
- Full confidential documents unless explicitly required by the product
- Unbounded model prompts or responses
- Renderer-controlled paths

Large files, intermediate files, DOCX/PDF/XLSX artifacts, and source attachments belong under the run directory. Database records should point to validated artifact IDs and run-relative locations.

## 12. Error mapping and visible failures

The backend must distinguish model/gateway failures, validation failures, tool failures, confirmation failures, and artifact failures.

At minimum, surface these cases clearly:

- Model unavailable
- Model timeout
- Provider request rejected
- Empty model response
- Invalid model response
- Unsupported task or attachment
- No matching knowledge source
- Unsupported citation
- Missing required content
- Unsafe generated code
- Python timeout
- Python non-zero exit
- DOCX/PDF conversion failure
- XLSX generation failure
- User rejection
- Confirmation expiry
- Run cancellation
- Exceeded iteration limit

The UI-facing error event should contain a stable code and safe message. Internal provider diagnostics may be logged separately, with credentials and sensitive content removed.

## 13. Sovereignty and network policy

The backend must cooperate with the independent network monitor but must not pretend that application logic alone is a firewall.

For the application:

- Development OpenRouter access must be explicit and visible in configuration.
- Final demo configuration must use LAN-only model and embedding endpoints.
- The backend must not create arbitrary network clients from model output.
- The Chroma/embedding service must use the approved local endpoint.
- Python execution must have networking disabled.
- The sovereignty panel must receive the real monitor state and external-request count.
- A blocked-egress event is infrastructure evidence, not a fabricated application event.

The final rehearsal must verify that OpenRouter entries are removed or disabled before the air-gapped demo and that all configured local endpoints are included in the approved LAN allowlist.

## 14. Locked Flow A backend sequence

The backend should implement this sequence for the fixed inspection report:

1. Create a run.
2. Register the dropped PDF as a run-owned attachment.
3. Emit classifying.
4. Route to vision-qwen25vl with reason scanned report.
5. Call ocr_extract.
6. Validate the three expected findings and page references.
7. Call search_knowledge.
8. Verify that SOP-114 §3.2 and TPL-012 are within the top five chunks.
9. Route to draft-qwen3 with reason compose approval note.
10. Call draft_note.
11. Validate the four note sections and citation membership.
12. Emit the exact DOCX confirmation request.
13. Stop until the user approves, rejects, or the action expires.
14. On approval, generate the DOCX and local PDF preview.
15. Emit artifact references.
16. Mark the run completed only after artifact creation and preview conversion succeed.

Required final note properties:

- Equipment header for E-201 and the report reference.
- All three extracted findings.
- Conditional clearance pending retubing of affected tubes.
- Grounding reference SOP-114 §3.2.

If the citation is absent from retrieval, document generation must not start.

## 15. Locked Flow B backend sequence

The backend should implement this sequence for the fixed CSV:

1. Create a separate run.
2. Register reactor-temperature-log.csv as a run-owned attachment.
3. Route to code-qwen25coder with reason CSV/code intent.
4. Call read_file and validate the CSV metadata.
5. Call draft_code and validate task.py.
6. Emit Execute the generated Python?
7. On approval, execute the fixed Python runner under Bubblewrap.
8. Capture exit code, capped logs, timeout status, duration, and output files.
9. Require exit code 0 and verify the expected output before treating the result as successful.
10. Verify stdout contains OUT_OF_RANGE 7/240 (high=5, low=2).
11. Propose generate_xlsx from validated output rows.
12. Emit the second confirmation request.
13. On approval, create out-of-range-summary.xlsx.
14. Call the final code-model summary step using the actual execution result.
15. Mark the run completed only after the verified summary and artifact state are consistent.

The expected flagged rows are seven total: five high and two low. A timeout or non-zero exit must produce a failed verification and must not trigger a successful spreadsheet result.

## 16. Testing and acceptance checklist

### Gateway tests

- Each model ID resolves to the intended development endpoint.
- Unknown and disabled models are rejected.
- OpenRouter credentials are read only from an environment variable.
- Provider responses normalize into the expected result shapes.
- Timeouts and provider failures map to stable errors.
- Request and run IDs are preserved.

### Validation tests

- Malformed vision response is rejected.
- Finding with an unknown page-reference ID is rejected.
- Draft with a missing section is rejected.
- Draft with an unsupported citation is rejected.
- Code response with shell instructions is rejected.
- Code response with oversized source is rejected.
- Extra/unexpected fields follow the chosen strictness policy.

### Filesystem/security tests

- Absolute paths from the renderer are rejected.
- .. traversal is rejected.
- A run cannot access another run's files.
- Generated artifacts remain inside the run output directory.
- Python cannot access the network.
- Python cannot write outside its output directory.
- Input files are read-only during execution.

### Confirmation tests

- Rejecting DOCX confirmation creates no DOCX.
- Expired confirmation creates no artifact.
- Rejecting Python prevents execution.
- Rejecting XLSX prevents spreadsheet generation.
- Cancellation invalidates pending confirmations.
- Replay of an already-resolved action is rejected.

### Flow A acceptance

- Routing visibly changes vision then draft.
- OCR produces the three locked findings.
- Retrieval returns SOP-114 §3.2 and TPL-012 within the top five.
- Draft cites [SOP-114 §3.2].
- DOCX and PDF preview are produced only after approval.
- Run reaches completed only after successful artifact creation.

### Flow B acceptance

- Routing visibly changes to code.
- The fixed CSV metadata is shown.
- Python runs only after approval and under the 60-second timeout.
- Exit code is 0 for the fixed fixture.
- Output contains OUT_OF_RANGE 7/240 (high=5, low=2).
- XLSX is generated only from validated output rows and after approval.
- Final summary uses actual execution output.

### Sovereignty acceptance

- Development mode reports the true OpenRouter traffic.
- Final mode uses only the approved LAN endpoints.
- The external-request counter remains zero during the local demo.
- The monitor-active state is visible.
- The independent blocked-egress proof is available for rehearsal.

## 17. Suggested implementation order

1. Create the Electron main/preload/backend structure.
2. Create run directories and attachment-token handling.
3. Add registry loading and model health checks.
4. Implement the normalized model gateway.
5. Add runtime validators for the AI contracts.
6. Add SQLite run and audit persistence.
7. Implement run state transitions and event streaming.
8. Implement deterministic routing.
9. Implement read_file, ocr_extract, and local search_knowledge.
10. Implement Flow A drafting, citation validation, confirmation, DOCX, and PDF preview.
11. Implement code generation, Bubblewrap execution, and execution-result validation.
12. Add the Flow B final summary request and XLSX confirmation/artifact path.
13. Add cancellation, expiry, retries, and visible failures.
14. Connect the renderer and sovereignty panel.
15. Run the locked fixture tests and full rehearsal on the final topology.

## 18. Definition of backend completion

The backend portion is complete when:

- The renderer can start a run using a safe attachment token.
- The backend can call all three model routes through one normalized gateway.
- Every model result is runtime-validated before use.
- Flow A completes with the cited DOCX/PDF after approval.
- Flow B completes with verified Python output and the XLSX after approvals.
- All route changes, tools, confirmations, artifacts, and errors stream visibly.
- All important actions are persisted locally.
- Cancellation, rejection, expiry, timeout, malformed output, and unavailable-model paths behave safely.
- The final local configuration produces zero external application requests.
- No model output can escape the run directory, choose a shell command, bypass confirmation, or select an arbitrary endpoint.

