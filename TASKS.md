# Sovereign Workbench MVP — End-to-End Task Plan

This plan turns `PRODUCT.md`, `PS.md`, and `docs/architecture/` into an executable delivery sequence for the 12-day MVP.

## How to use this plan

- A number followed by a letter is a top-level task, for example `4a)` and `4b)`.
- Tasks with the same number are independent workstreams that can proceed in parallel once the previous numbered gate is complete.
- Roman-numeral items are subtasks. They are atomic implementation or verification actions belonging to the parent task.
- Every top-level task has exactly one accountable owner. Supporting teammates may assist, but the owner is responsible for closing the success criteria.
- The prescribed architecture paths are implementation targets; create the application structure under them as needed because the repository currently contains the product and architecture documentation but not the application implementation.
- No task may expand the MVP into authentication, production-grade sandboxing, handwriting OCR, enterprise-scale RAG, PowerPoint generation, or arbitrary model-plugin infrastructure.

## Team ownership

| Person | Primary area | Task-planning implication |
| --- | --- | --- |
| Ayush | Frontend | Electron renderer, preload-facing UX, file drop, transcript, badges, confirmations, artifact and failure views |
| Supreet | Backend | Electron main, IPC handlers, orchestrator, router, model gateway, tools, SQLite, artifacts, packaging |
| Sid | AI/ML | Model provisioning, latency checks, OCR and drafting prompts, embedding/index preparation, fixture evaluation, offline rehearsal evidence |

## Fixed product constraints

1. Flow A is the flagship: clean typed scanned inspection report → OCR findings → SOP retrieval → cited approval-note `.docx` → local PDF preview.
2. Flow B is the second acceptance flow: CSV/data request → code routing → generated Python → confirmed Bubblewrap execution → verified result and optional `.xlsx`.
3. Routing is automatic and deterministic. The user never chooses the model from a dropdown, and the model cannot choose arbitrary endpoints.
4. Only the five approved LAN hosts may be used. There is no DNS discovery, cloud fallback, telemetry SDK, remote download, or internet-capable application feature.
5. The renderer is presentation-only. Electron main is the sole privileged boundary for model access, filesystem access, tool execution, and persistence.
6. Each run has a private workspace under `data/runs/<run-id>/`; attachments are preserved read-only and outputs are written only below the run directory.
7. DOCX/XLSX writes and Python execution require explicit renderer confirmation recorded in SQLite.
8. The agent is bounded to eight model/tool iterations and must fail visibly on invalid output, unavailable services, timeout, rejected confirmation, or disallowed tools.
9. Finals inputs are fixed, local, pre-tested fixtures. No improvised generative step is part of the acceptance bar.

## Sequence overview

| Sequence | Gate / outcome | Architecture delivery window |
| --- | --- | --- |
| 1 | Scope, evidence, hardware, and UX decisions frozen | Day 1 |
| 2 | Repository, contracts, Electron shell, and offline services bootstrapped | Days 1–2 |
| 3 | Model gateway, local corpus, IPC event plumbing, and basic renderer views ready | Days 2–3 |
| 4 | Secure run boundary, deterministic router, and real attachment flow ready | Days 3–4 |
| 5 | Validated tools, OCR evaluation, and RAG evaluation ready | Days 4–5 |
| 6 | Flow A orchestration, prompts, and live route/transcript UX ready | Days 5–6 |
| 7 | Cited DOCX/PDF generation and artifact preview ready | Days 6–7 |
| 8 | Flow A integrated and Flow B specialist work started in parallel | Days 7–8 |
| 9 | Bubblewrap execution and Flow B UI/tooling ready | Days 8–9 |
| 10 | Flow B integrated and both flows' acceptance assertions pass | Days 9–10 |
| 11 | Failure handling, cancellation, audit completeness, and security checks pass | Days 10–11 |
| 12 | Sovereignty proof, offline deployment bundle, and operator runbook ready | Days 11–12 |
| 13 | Final rehearsal, evidence capture, and handoff complete | Day 12 |

## Detailed tasks

### 1a) Freeze MVP scope and acceptance evidence

**Owner:** Supreet (Backend)

**Subtasks:**

i. Convert the product definition of done and PS expected solution into a single acceptance matrix covering model auto-routing, Flow A, Flow B, multimodal understanding, sandbox verification, zero external calls, blocked-egress evidence, and SOP citations.

ii. For each acceptance item, define the exact visible UI evidence, persisted audit evidence, fixture assertion, or independent infrastructure evidence required to mark it complete.

iii. Mark all out-of-scope capabilities in the delivery notes so they cannot enter the 12-day critical path.

iv. Freeze the two demo narratives, their fixed inputs, expected outputs, expected route events, and acceptable known failure messages.

v. Create a decision log for unresolved implementation choices, with a named owner and a decision deadline no later than the end of Day 1.

**Success criteria:** A reviewed acceptance matrix maps every product success criterion to evidence and test fixtures; Flow A and Flow B inputs/outputs are fixed; scope exclusions are documented; no acceptance item depends on an unplanned feature.

### 1b) Inventory the finals hardware and private LAN

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Confirm the five-machine topology: M4 Mac Mini for vision, i7 #1 for drafting, i7 #2 for coding, i7 #3 for application/Chroma/Bubblewrap, and i5 11th-gen for embeddings/indexing.

ii. Record fixed LAN IP addresses, service ports, operating systems, available disk, RAM, and model/runtime compatibility for every host.

iii. Assign the exact model aliases and service paths that will be used in `config/models.json` and deployment notes.

iv. Identify the permitted inbound peer for each service and record the exact five-host allowlist required by the independent monitor/firewall.

v. Identify any missing package, driver, runtime, or OS prerequisite while external staging access is still available.

**Success criteria:** A checked-in or deployment-bundle inventory names all five hosts, roles, addresses, ports, versions, and permitted peers; every required prerequisite has an owner and acquisition path; no model endpoint remains an unassigned placeholder.

### 1c) Define the demo UX and event narrative

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Define the desktop layout: chat/input and file-drop area, live agent-step transcript, routing badge, confirmation surface, artifact preview pane, run status, and sovereignty panel.

ii. Map every documented `RunEvent` to a visible renderer state, including empty, running, awaiting confirmation, completed, cancelled, and failed states.

iii. Define the narration order for Flow A (`vision` route → extraction → retrieval → `draft` route → confirmation → DOCX/PDF) and Flow B (`code` route → generated code → confirmation → execution → result).

iv. Define copy for the sovereignty proof, including the distinction between application connection telemetry and independent monitor/firewall evidence.

v. Specify the fixed-file-drop interaction and error treatment for unsupported file types, oversized files, duplicate drops, and cancelled runs.

**Success criteria:** A renderer wireframe or written screen specification covers every acceptance event and failure state; the two demo narratives can be followed without hidden UI; the specification does not require the renderer to access filesystem paths, model addresses, or raw IPC.

### 2a) Bootstrap the repository, module boundaries, and typed contracts

**Owner:** Supreet (Backend)

**Subtasks:**

i. Create the prescribed application structure beginning at `apps/desktop/src/main/index.ts` with `ipc/registerHandlers.ts`, `orchestration/runOrchestrator.ts`, `models/modelGateway.ts`, `tools/toolRunner.ts`, `persistence/runRepository.ts`, and `artifacts/artifactService.ts`.

ii. Establish TypeScript build, lint, test, and packaging commands with pinned dependency versions and a documented local/offline installation procedure.

iii. Define the shared types for `TaskType`, `ModelRegistryEntry`, `RunState`, `ToolName`, `PendingAction`, `ArtifactRef`, `RunSummary`, `StartRunInput`, `ConfirmActionInput`, and all `RunEvent` variants from the architecture contract.

iv. Define Zod schemas for every IPC input, IPC output, event, tool input, and tool output. Reject unknown fields where doing so protects the boundary.

v. Add configuration and data-directory conventions for `config/models.json`, `data/runs/`, the prepared Chroma corpus, logs, and deployment metadata.

**Success criteria:** The application and test harness compile from a clean local dependency cache; prescribed modules and shared schemas exist; a schema test proves malformed IPC and tool payloads are rejected before business logic runs; no renderer-facing type exposes an absolute path, model URL, or tool capability.

### 2b) Provision all local model and embedding services

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Stage and checksum the Qwen2.5-VL-3B-Instruct 4-bit MLX weights, Qwen3-4B-Instruct GGUF Q4 weights, Qwen2.5-Coder-7B-Instruct GGUF Q4 weights, embedding model, Python wheels, Node/Electron dependencies, LibreOffice, and Bubblewrap package.

ii. Install each model server from local media or cache on its assigned host: `mlx_lm.server` for vision and `llama-server` for drafting and coding.

iii. Start each service from a local model path with a stable alias and no download-on-start behavior.

iv. Verify `/v1/models` and a minimal fixture request from the application host for each model endpoint, plus the embedding endpoint from the application host.

v. Record startup commands, service versions, checksums, ports, expected latency, and known resource limits in the deployment notes.

**Success criteria:** All five required services run from local assets; `/v1/models` and fixture requests succeed over the private LAN; no host attempts an external download; baseline latency and memory observations are recorded for later rehearsal comparison.

### 2c) Bootstrap the Electron shell and restricted preload

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Create the Electron main/renderer/preload build targets and launch the desktop shell on the application host.

ii. Add the initial typed preload bridge with stubs for `startRun`, `confirmAction`, `cancelRun`, `getArtifact`, `getRunHistory`, and `onRunEvent`.

iii. Build the initial layout containers for chat/file drop, transcript, routing badge, confirmation, artifact pane, run history, errors, and sovereignty status.

iv. Ensure `contextIsolation` and the project’s renderer security settings prevent direct access to Node, Electron, filesystem, child-process, or raw IPC APIs.

v. Add a local development fixture mode only if it is clearly separated from production/demo mode and cannot bypass main-process validation.

**Success criteria:** The app opens to the documented shell; renderer code can compile against the typed bridge but cannot import privileged APIs; all major panes render in empty/loading/error states; fixture mode cannot create files, execute code, or call models directly.

### 3a) Implement the model registry, gateway, and health checks

**Owner:** Supreet (Backend)

**Subtasks:**

i. Implement `config/models.json` loading and validation as the sole source of model selection configuration.

ii. Enforce the allowed IDs, task types, runtimes, `http://LAN_IP:PORT/v1` shape, `/models` health path, bounded timeout, and `enabled` flag.

iii. Implement the internal gateway contract for OpenAI-compatible `/v1/chat/completions` and `/v1/models` calls, including fixed aliases, bounded context, low temperature, and task-specific system prompts.

iv. Normalize streaming and non-streaming responses into validated internal results; forward streaming only for user-visible draft text.

v. Run launch-time health checks for all configured model entries and the local embedding service. Expose only safe health summaries to the renderer.

vi. Explicitly fail when a service is unavailable or malformed; do not retry against another task-inappropriate model or any cloud endpoint.

**Success criteria:** Exactly the three approved model entries resolve successfully to the assigned LAN services; launch health state is visible before a run can start; gateway tests prove no arbitrary URL or model ID can be selected; unavailable services produce a named, auditable failure.

### 3b) Prepare the curated corpus and validate local retrieval

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Select and sanitize 10–30 local documents, including the matching SOP and approval-note template, without uploading or syncing them externally.

ii. Assign stable `documentId`, title, section identifier, and source metadata to every document.

iii. Chunk and embed the corpus through the local embedding endpoint; persist Chroma on the designated host.

iv. Create retrieval queries for the fixed inspection report and expected SOP sections, with expected top result and citation identifiers.

v. Validate `topK ≤ 5`, bounded excerpts, stable section IDs, and behavior when no relevant document is found.

**Success criteria:** The persisted local Chroma index contains the curated corpus and no unrelated documents; the Flow A query returns the expected SOP section within the allowed result set; no-match behavior is deterministic and returns a usable failure signal; retrieval works with external networking disconnected.

### 3c) Connect typed IPC events to the initial renderer views

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Implement the renderer subscription lifecycle for `onRunEvent`, including cleanup when a view unmounts or a run ends.

ii. Render run state, routing, plan step, tool call, tool result, confirmation, artifact-ready, and error events in a chronological transcript.

iii. Display routing events as human-readable model badges without exposing base URLs or LAN addresses.

iv. Prevent duplicate event rendering and preserve event order when streamed updates arrive quickly.

v. Add accessible loading, disabled, cancelled, and retry/new-run states.

**Success criteria:** A local event fixture renders the complete event union in the correct order; duplicate listeners do not duplicate transcript rows; renderer output reveals model identity/task type and reasons but never endpoint addresses; subscription cleanup is covered by a test or reproducible check.

### 4a) Implement the Electron-main run boundary and attachment tokens

**Owner:** Supreet (Backend)

**Subtasks:**

i. Make Electron main the sole composition root that owns the orchestrator, gateway, tool runner, persistence, artifact service, and local filesystem access.

ii. Implement `startRun` to validate user text and an Electron-issued local attachment token, create a run ID, and copy the accepted file into `data/runs/<run-id>/input/`.

iii. Preserve the copied input as read-only and generate a random attachment token that is meaningful only to the main process.

iv. Reject client-controlled absolute paths, path traversal, unsupported types, oversized files, and attachments outside the approved intake path.

v. Implement `confirmAction`, `cancelRun`, `getArtifact`, and `getRunHistory` with run ownership and state checks.

vi. Ensure actions expire after five minutes or immediately when their run is cancelled.

**Success criteria:** A real dropped fixture creates an isolated run directory and token; no renderer input can cause arbitrary path access; cancellation and expired confirmations prevent writes/execution; all boundary decisions produce auditable state or error events.

### 4b) Implement deterministic routing and route-change events

**Owner:** Supreet (Backend)

**Subtasks:**

i. Route image/PDF report analysis to `vision` first.

ii. Route requests mentioning CSV, calculation, script, code, execution, or data transformation to `code`.

iii. Route all other requests to `draft`.

iv. Emit a `routing` event with task type, approved model ID, and a concise reason every time the selected model changes.

v. Add the explicit Flow A route transition from `vision` to `draft` after OCR extraction and retrieval.

vi. Add table-driven tests for positive, negative, mixed-intent, unsupported-input, and Flow A post-OCR cases.

**Success criteria:** The router chooses only `vision`, `draft`, or `code` according to the documented deterministic rules; Flow A visibly emits two route events and Flow B emits the `code` route; the model cannot override a route or supply an endpoint; all route decisions are persisted.

### 4c) Implement the real file-drop and run-start UX

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Implement drag-and-drop and file-picker interactions for the fixed PDF and CSV fixtures.

ii. Pass only the Electron-issued attachment token and user text through the preload bridge.

iii. Show selected-file metadata without revealing local absolute paths.

iv. Disable start while launch health checks are incomplete or required services are unavailable.

v. Handle rejection for unsupported, oversized, duplicate, or missing files with actionable messages.

vi. Add a clear new-run action after completion, cancellation, or failure.

**Success criteria:** The real file-drop control starts a run using the fixed PDF and CSV fixtures; the renderer never sends an absolute path; invalid files are rejected before a run begins; the UI visibly blocks starts when health checks fail.

### 5a) Implement validated tools and flow policy enforcement

**Owner:** Supreet (Backend)

**Subtasks:**

i. Implement the `ToolRunner` dispatch table for `read_file`, `ocr_extract`, `search_knowledge`, `draft_note`, `generate_docx`, `draft_code`, `execute_python`, and `generate_xlsx`.

ii. Validate every tool input and output with Zod before use, storage, or handoff to the next model step.

iii. Enforce the allowed-tool matrix per flow and reject tools not permitted by the current flow.

iv. Enforce run-relative paths, type/size allowlists, bounded output, fixed timeouts, and the eight-iteration maximum.

v. Prevent tools from creating network clients, changing registry configuration, invoking model-supplied shell commands, or accessing paths outside the run workspace.

vi. Emit and persist tool-call and tool-result summaries without storing large prompts or attachments in SQLite.

**Success criteria:** Each tool has a fixed schema and test; disallowed tools, invalid payloads, path escapes, timeouts, and iteration overflow fail visibly; no tool can invoke a network client or arbitrary shell command; tool summaries and errors are auditable.

### 5b) Tune and evaluate clean-scan OCR extraction

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Define the structured extraction schema for source text, key findings, page references, identifiers, dates, measurements, and uncertainty/omission markers needed by the approval note.

ii. Build the vision prompt and preprocessing path for the fixed clean typed inspection-report PDF/image.

iii. Run repeated local evaluations and record extraction accuracy against the known fixture findings and page references.

iv. Tune only bounded prompt, preprocessing, and decoding parameters; do not broaden the MVP into general handwriting OCR.

v. Document the UI wording that extracted findings are OCR/vision output and are not a handwriting-accuracy claim.

**Success criteria:** The vision service returns schema-valid findings containing all required fixture facts and page references within the accepted tolerance; malformed or incomplete output is rejected; the prompt/evaluation record is reproducible offline.

### 5c) Validate the retrieval and citation contract

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Define the `search_knowledge` input and output fixtures with query, `topK`, `documentId`, section, excerpt, and source IDs.

ii. Verify that the expected SOP section and template are returned for the extracted findings.

iii. Define the no-match and ambiguous-match responses and the threshold at which drafting must stop.

iv. Create a golden citation set for the approval note, including the required `[SOP-114 §3.2]` form.

v. Confirm that citations remain tied to retrieved chunks and cannot be invented by the drafting model.

**Success criteria:** The fixed Flow A query returns the golden citation set; all citations resolve to retrieved chunks; no-match retrieval blocks document creation; the retrieval test passes with external networking disconnected.

### 6a) Implement the bounded agent state machine and Flow A loop

**Owner:** Supreet (Backend)

**Subtasks:**

i. Implement the run states `created`, `classifying`, `planning`, `acting`, `awaiting_confirmation`, `completed`, `cancelled`, and `failed` with legal transitions only.

ii. Implement the Flow A sequence: classify → vision/OCR → knowledge search → route to draft → draft note → request DOCX confirmation → generate artifact.

iii. Stream a plan step before each model/tool action and an observation after each tool result.

iv. Feed only validated, bounded findings and retrieved citations into the drafting step.

v. Stop on invalid output, unavailable model, tool timeout, disallowed tool, missing citation, cancellation, or eight-iteration limit.

vi. Persist every state transition, route, confirmation, citation, artifact reference, and failure summary.

**Success criteria:** A fixed scanned report completes the documented Flow A state sequence without hidden work; route and tool events appear in order; the run never exceeds eight iterations; invalid or missing inputs fail before an uncited or unvalidated document is created.

### 6b) Tune the approval-note drafting model and prompt

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Define the drafting input schema containing extracted findings, retrieved chunks, template constraints, and required citation IDs.

ii. Create a low-temperature drafting prompt that produces an approval-note body with citations in the exact required form.

iii. Require the model to use only supplied findings and retrieved sources, and to signal missing information rather than inventing facts.

iv. Evaluate the fixed report across repeated local runs for required sections, factual grounding, citation placement, and output-schema validity.

v. Freeze the prompt, decoding settings, and expected content assertions for the demo bundle.

**Success criteria:** The drafting response is schema-valid, contains all required approval-note sections, cites only retrieved SOP IDs, and passes the golden fixture assertions across the agreed rehearsal runs; prompt and settings are stored locally and reproducible.

### 6c) Build the live Flow A transcript, routing badge, and confirmation UX

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Render the `vision` routing event with an explainable reason tied to scanned-document understanding.

ii. Render OCR, retrieval, drafting, and artifact-generation plan/tool events with compact human-readable summaries.

iii. Render the second `draft` routing badge as a visible route change, not as a user-selected model.

iv. Build the confirmation modal for `generate_docx`, showing the intended artifact and a clear approve/reject choice.

v. Disable duplicate confirmation submissions and show expired, rejected, cancelled, and completed states.

**Success criteria:** A user can follow Flow A from drop to confirmation entirely through visible UI; both route badges and all critical tool steps appear in order; rejecting or expiring confirmation leaves no impression that a document was written.

### 7a) Implement cited DOCX generation and local PDF conversion

**Owner:** Supreet (Backend)

**Subtasks:**

i. Implement `generate_docx` using validated title, body, and citations only.

ii. Resolve every cited source ID against the run’s retrieved chunks and refuse generation if any citation is absent.

iii. Add a “Grounding references” section listing the same SOP section identifiers used in the note.

iv. Write the immutable DOCX only below the run output directory.

v. Convert the DOCX to a local PDF using the installed LibreOffice worker; retain the DOCX when conversion fails.

vi. Emit `artifact_ready` references with safe artifact IDs and metadata rather than filesystem paths.

**Success criteria:** After confirmation, the fixture produces a readable DOCX containing the expected note assertions and `[SOP-114 §3.2]`-style grounding references; the local PDF preview exists and matches the DOCX content; a missing citation blocks generation; conversion failure retains the DOCX and reports a visible preview failure.

### 7b) Build the artifact preview and download pane

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Render the artifact list from safe `ArtifactRef` values returned through `getArtifact`.

ii. Display the generated PDF in the preview pane and expose the DOCX for local download/opening through the approved main-process path.

iii. Show artifact type, creation state, and conversion failure without fabricating a preview.

iv. Prevent in-app editing, since editing generated artifacts is out of scope.

v. Keep the artifact pane usable while the transcript remains visible for the demo narrative.

**Success criteria:** The Flow A PDF is viewable in-app after `artifact_ready`; the DOCX can be retrieved through the bridge; preview and conversion failure states are distinct; no renderer code receives or constructs arbitrary filesystem paths.

### 7c) Add Flow A document and citation assertions

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Define text assertions for the approval-note title, findings, recommendation, and required SOP section.

ii. Extract DOCX text in a local test and assert required content and citation identifiers.

iii. Verify PDF preview existence and basic text/renderability after conversion.

iv. Add a negative test proving an invented or absent citation prevents artifact creation.

v. Record the expected artifact hashes or stable content checks where practical for rehearsal comparison.

**Success criteria:** Automated fixture checks distinguish a correctly grounded approval note from an uncited or incomplete note; DOCX and PDF verification runs locally without network access; the negative citation test fails safely.

### 8a) Integrate Flow A end to end on the real file-drop path

**Owner:** Supreet (Backend)

**Subtasks:**

i. Connect the real renderer file drop to `startRun`, the run state machine, gateway, tools, retrieval, document worker, persistence, and artifact references.

ii. Run the fixed scanned report through the actual Electron desktop app, not a mocked orchestration path.

iii. Verify the exact event order: run state → `vision` routing → extraction → knowledge search → `draft` routing → drafting → confirmation → DOCX/PDF → completed.

iv. Verify the run workspace contains the input, bounded intermediates, and immutable outputs, while SQLite contains only metadata and audit summaries.

v. Capture and resolve integration defects without changing the fixed acceptance narrative.

**Success criteria:** The real Flow A demo completes from file drop to cited DOCX and PDF after one explicit confirmation; all expected events and audit records exist; no external endpoint or renderer privilege is involved.

### 8b) Start Flow B code-model prompt and fixture validation

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Define the fixed CSV fixture, expected out-of-range flags, expected summary, and optional spreadsheet columns.

ii. Define the `draft_code` schema containing Python source, input references, expected output description, and no shell arguments.

iii. Tune the code prompt to produce deterministic, readable Python using only the permitted input/output contract.

iv. Evaluate generated code against the fixture’s expected logic and reject unsafe or malformed source before execution.

v. Freeze the code prompt, fixture, expected stdout, expected exit code, and expected output data.

**Success criteria:** The code model returns schema-valid Python that addresses the fixed CSV task and matches the expected logic; unsafe/malformed source is rejected; expected outputs and prompt settings are recorded for the Flow B integration.

### 8c) Build the Flow B UI skeleton in parallel with Flow A integration

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Add CSV/data-task file-drop affordance without introducing a separate manual model selector.

ii. Render code-route and generated-source transcript cards with safe truncation.

iii. Add the execution confirmation surface, expected output summary, and pending state.

iv. Add result, stdout, stderr, exit-code, timeout, and execution-failure view states.

v. Add the optional spreadsheet-artifact slot without claiming the artifact exists before backend verification.

**Success criteria:** The renderer has complete Flow B states and can consume fixture events for route, code generation, confirmation, execution, and result; it never enables execution or artifact creation without a main-process confirmation event.

### 9a) Implement the fixed Bubblewrap Python runner

**Owner:** Supreet (Backend)

**Subtasks:**

i. Create an empty run-scoped output directory for each approved execution.

ii. Bind-mount only the specific input directory read-only and output directory writable.

iii. Provide the minimal read-only Python runtime and temporary filesystem required by the fixture.

iv. Invoke Bubblewrap with a new network namespace (`--unshare-net`) and a fixed interpreter path; never pass model-supplied shell arguments.

v. Run only the validated `task.py`, enforce a 60-second wall-clock timeout, and cap stdout/stderr before persistence/display.

vi. Return exit code, bounded logs, and output references; clean temporary execution files only after the audit summary is written.

**Success criteria:** The fixture script runs with expected output and no network access; an attempted network operation fails inside the runner; writes outside the output directory are blocked; timeout and non-zero exit are surfaced as failures with bounded logs; the runner invocation is fixed and auditable.

### 9b) Implement Flow B code validation and execution policy

**Owner:** Supreet (Backend)

**Subtasks:**

i. Implement `draft_code` input/output validation and source-size limits.

ii. Write validated source into the run workspace only after the code response passes schema and policy checks.

iii. Require an explicit confirmation before invoking `execute_python`.

iv. Associate the approved action ID with the exact source and input references that were shown to the user.

v. Treat non-zero exit, timeout, missing output, or schema mismatch as verification failure rather than a successful result.

vi. Allow `generate_xlsx` only after validated result rows/columns and its own confirmation if it is invoked.

**Success criteria:** No generated Python executes without an explicit, recorded approval; the executed source matches the approved source; failed execution can never be presented as a successful calculation; optional XLSX output is validated, scoped, and auditable.

### 9c) Implement local XLSX generation and result artifact references

**Owner:** Supreet (Backend)

**Subtasks:**

i. Define the validated rows/columns contract for `generate_xlsx`.

ii. Write XLSX files only below the current run’s output directory.

iii. Emit safe artifact metadata and preserve immutable output semantics.

iv. Add a malformed-row, unsupported-type, and output-write-failure test.

**Success criteria:** A valid Flow B result can produce a readable local `.xlsx` when requested; invalid data cannot create an artifact; artifacts are retrievable through safe IDs and are recorded in SQLite.

### 10a) Integrate Flow B from CSV drop through verified result

**Owner:** Supreet (Backend)

**Subtasks:**

i. Connect the real CSV drop to classification, code routing, metadata inspection, planning, code drafting, validation, confirmation, Bubblewrap execution, and result summarisation.

ii. Send only verified execution outputs to the summarisation model; do not allow the model to reinterpret a non-zero exit as success.

iii. Emit the `code` routing event, tool events, confirmation event, bounded logs, exit code, and artifact events in order.

iv. Verify output confinement and SQLite audit entries for the source, approval, execution, and result.

v. Exercise both successful and failed fixture executions.

**Success criteria:** The real Flow B path completes with the expected flags/summary and exit code after confirmation; the UI shows the generated result and optional XLSX; a failing script is visibly marked failed and never summarized as successful.

### 10b) Validate Flow B expected outputs and sandbox proof

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Compare returned stdout, exit code, and generated data with the fixed expected values.

ii. Verify the no-network fixture attempt fails under Bubblewrap.

iii. Verify logs are bounded and contain enough context to explain success or failure.

iv. Verify the result summarisation is grounded in execution output rather than unsupported model claims.

v. Record the successful and failure-case evidence needed for the final demo.

**Success criteria:** Flow B passes its deterministic output assertions; no-network and output-confinement checks pass; failure evidence is understandable and reproducible offline; the evidence packet contains the exact expected exit code and result.

### 10c) Finish the unified transcript and artifact/result experience

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Make Flow A and Flow B use the same transcript visual language while preserving their distinct tools and route badges.

ii. Show source/code summaries with bounded expansion so the full session remains demo-readable.

iii. Display stdout/stderr and exit code with clear success/failure semantics.

iv. Render DOCX/PDF/XLSX artifact cards with loading, ready, unavailable, and conversion-failed states.

v. Ensure the user can start a new clean run without stale events or artifacts leaking from the prior run.

**Success criteria:** Both flows are understandable from one consistent UI; success, cancellation, and failure are visually unambiguous; run reset clears transient state while preserving history; no stale artifact or event appears in a later run.

### 11a) Implement retries, cancellation, confirmation expiry, and known failures

**Owner:** Supreet (Backend)

**Subtasks:**

i. Implement named failures for unavailable registry endpoints, invalid structured output, disallowed tools, no matching SOP, conversion failure, Bubblewrap timeout, and non-zero exit.

ii. Add bounded retries only where explicitly safe, and always revalidate health before retrying a model service.

iii. Ensure cancellation interrupts pending orchestration and prevents future tool calls, writes, and execution.

iv. Ensure confirmations expire after five minutes and cannot be replayed or applied to another run/action.

v. Add tests for rejected confirmation, expired confirmation, repeated confirmation, cancellation during planning, and cancellation while awaiting confirmation.

**Success criteria:** Every documented failure condition produces a visible `error` or cancelled state with an audit record; no cloud or task-inappropriate fallback occurs; cancelled/rejected/expired actions perform no protected side effect; safe retry behavior is bounded and tested.

### 11b) Complete audit persistence and security-boundary verification

**Owner:** Supreet (Backend)

**Subtasks:**

i. Persist run metadata, state transitions, route decisions, event summaries, pending/resolved confirmations, citations, artifact metadata, and errors in SQLite.

ii. Confirm large attachments, model prompts, and large intermediate payloads remain in run files rather than being duplicated into SQLite.

iii. Verify each run workspace is isolated and artifact IDs cannot retrieve another run’s output.

iv. Verify renderer APIs expose only the documented typed bridge and cannot reach models, tools, filesystem paths, or persistence directly.

v. Verify the registry and tool runner reject arbitrary URLs, shell commands, absolute paths, configuration mutation, and network clients.

vi. Verify all model/tool iterations are counted and capped at eight.

**Success criteria:** Security-boundary tests pass; an audit reconstruction can explain a complete run without storing prohibited large payloads; cross-run access and arbitrary capability attempts fail; the renderer remains a thin presentation layer.

### 11c) Run model stability, latency, and dependency checks

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Run repeated local calls for vision, drafting, coding, and embeddings using the fixed fixtures.

ii. Record p50/p95-ish observed latency, memory pressure, timeouts, and failure rate appropriate to the limited rehearsal sample.

iii. Identify prompt or runtime settings that create unacceptable variance and freeze the most stable tested configuration.

iv. Verify services remain available after the application is restarted and after external networking is disconnected.

v. Document operator actions for a failed health check without introducing model substitution or cloud fallback.

**Success criteria:** All required services pass repeated fixture checks within configured timeouts; the final model/runtime configuration is versioned and reproducible; known instability has a documented operator recovery path; no untested fallback is part of the demo.

### 12a) Build the offline deployment bundle and operator runbook

**Owner:** Supreet (Backend)

**Subtasks:**

i. Package the Electron application, local dependencies, model startup instructions, embedding service, Chroma data, LibreOffice worker, Bubblewrap runner, config, fixtures, and tests.

ii. Add an installation checklist that uses only local media/caches after the staging transfer.

iii. Add startup order: boot hosts, start model services, start embedding/Chroma, launch Electron, run health checks, then begin the demo.

iv. Document fixed IP/port configuration, version/checksum inventory, run-data cleanup boundaries, and known failure recovery.

v. Document that the external monitor/firewall is independent infrastructure and is not fabricated or treated as application source of truth.

vi. Verify the bundle can be installed/restarted from the recorded local assets with external networking disabled.

**Success criteria:** A fresh finals setup can be booted from the deployment bundle and runbook without downloads; launch health checks pass; both fixed fixtures are available locally; the bundle contains no cloud endpoint, remote-download step, or undisclosed dependency.

### 12b) Configure and verify independent sovereignty evidence

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Configure the independent monitor/firewall to observe the five hosts and allow only approved LAN traffic between the documented peers.

ii. Verify external outbound requests remain at zero during a clean application launch, Flow A, and Flow B.

iii. Verify permitted traffic is limited to the approved LAN addresses and expected service ports.

iv. Execute the infrastructure team’s preconfigured controlled outbound-attempt test; do not add an internet-capable feature to the application.

v. Capture monitor evidence showing the blocked event, timestamp, source host, destination classification, and enforcement result.

vi. Store the evidence in the final operator/evidence pack with run identifiers and timestamps.

**Success criteria:** Independent evidence covers the full session and both flows with zero external requests, permitted traffic only among approved LAN hosts, and one recorded blocked outbound attempt; the test does not modify the application to reach the internet.

### 12c) Complete the always-visible sovereignty panel

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Show the configured five-host allowlist and service status in a permanently visible panel without exposing unnecessary connection details in the main demo narrative.

ii. Show application-observed external-request count and the clean-session zero state from validated backend telemetry.

iii. Show LAN service connection state, health-check state, and a clear “independent monitor active” indicator only when the application is configured for the finals environment.

iv. Distinguish app-local telemetry from the independent monitor/firewall’s authoritative egress evidence; never fabricate external counters or a blocked event.

v. Render degraded and failure states when a service is outside the allowlist, health is unknown, or independent evidence is unavailable.

vi. Verify the panel remains visible during both flows, confirmation dialogs, artifact preview, and failure states.

**Success criteria:** The sovereignty panel is visible for the complete session; it shows the exact allowlist and zero external-request state from validated telemetry; it clearly points to independent monitor evidence for the blocked event; it never claims evidence that the app did not receive.

### 13a) Run the full architecture and acceptance gate

**Owner:** Supreet (Backend)

**Subtasks:**

i. Run all automated unit, schema, state-machine, tool-policy, artifact, sandbox, IPC, and fixture E2E tests from the offline deployment bundle.

ii. Confirm Electron main is the only privileged process boundary and renderer APIs match the documented bridge exactly.

iii. Confirm registry, health checks, run isolation, confirmations, eight-step bound, failure policy, and audit persistence against the architecture checklist.

iv. Confirm Flow A and Flow B acceptance assertions pass using the real file-drop path.

v. Triage remaining defects by demo risk; fix only defects required for acceptance, stability, or operator clarity.

**Success criteria:** The architecture and product acceptance checklists have no unowned failures; all required automated and fixture E2E tests pass offline; remaining issues are explicitly deferred and do not affect the two flows or sovereignty proof.

### 13b) Rehearse the flagship Flow A and freeze its fixtures

**Owner:** Sid (AI/ML)

**Subtasks:**

i. Boot the five hosts and start services from local paths according to the runbook.

ii. Confirm registry and embedding health before opening the fixed inspection report.

iii. Execute the complete Flow A narrative, including route changes, OCR findings, SOP citation, confirmation, DOCX generation, and PDF preview.

iv. Repeat enough times to establish stable behavior and record observed timings, transcript wording, and evidence identifiers.

v. Freeze the report, SOP, template, prompt/settings, expected assertions, and clean-session reset procedure.

**Success criteria:** Flow A completes repeatedly from the real file-drop control with the expected findings, `[SOP-114 §3.2]`-style citation, DOCX, PDF, route badges, confirmation audit, and sovereignty evidence; fixture and prompt changes are frozen afterward.

### 13c) Rehearse Flow B and freeze its verification evidence

**Owner:** Supreet (Backend)

**Subtasks:**

i. Reset to a clean application session and execute the fixed CSV task through the actual renderer.

ii. Narrate the automatic `code` route, generated source, expected output, execution confirmation, Bubblewrap result, exit code, and optional XLSX artifact.

iii. Repeat the successful run and one controlled failure run to confirm visible semantics.

iv. Confirm no-network, output-confinement, bounded-log, and audit assertions remain green.

v. Freeze the code fixture, generated-source acceptance checks, expected stdout/stderr, exit code, and operator recovery instructions.

**Success criteria:** Flow B completes repeatedly with the expected result and exit code after explicit confirmation; the controlled failure is clearly failed; sandbox and audit evidence are captured; no fixture or policy changes remain unrecorded.

### 13d) Perform the final full-session demo rehearsal and handoff

**Owner:** Ayush (Frontend)

**Subtasks:**

i. Start from a clean machine/application state and open the independent monitor view before launching the app.

ii. Run Flow A and Flow B in the documented order while keeping the sovereignty panel visible and narrating the route badges and confirmation gates.

iii. Execute the preconfigured blocked-egress infrastructure test and verify its evidence is linked to the session.

iv. Verify the artifact pane, transcript, errors, run history, and new-run reset are readable at demo resolution.

v. Verify the operator can recover from a known failed health check using the runbook without changing product scope.

vi. Archive the final build identifier, fixture checksums, service versions, monitor evidence, screenshots/logs, acceptance checklist, and unresolved non-blocking issues.

**Success criteria:** A presenter can run the entire fixed session end to end without hidden manual intervention; both flows, visible routing, confirmations, artifacts, zero external requests, and blocked-egress evidence are demonstrated; the final bundle, runbook, and evidence pack are handed off and reproducible on the finals LAN.

## Final definition of done

The project is complete only when all of the following are true:

- Model auto-selection is visibly demonstrated for `vision` → `draft` in Flow A and `code` in Flow B.
- A clean typed scanned report produces extracted findings, a locally grounded approval note, a cited DOCX, and a local PDF preview.
- A CSV coding task produces validated Python, runs only after confirmation inside Bubblewrap with no network, and displays the verified result.
- The renderer remains limited to the documented typed bridge and cannot access model endpoints, filesystem paths, tools, or persistence directly.
- All model/tool calls, citations, confirmations, artifacts, failures, and state transitions are locally auditable.
- The sovereignty panel remains visible, external-request count stays at zero, only approved LAN traffic is used, and the independent monitor records a controlled blocked-egress event.
- The complete system works from fixed, pre-tested local fixtures with external networking disconnected.
- The final deployment bundle, operator runbook, rehearsal record, and evidence pack are complete.

