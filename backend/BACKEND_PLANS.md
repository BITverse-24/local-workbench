# Backend Plans — Electron ↔ Backend ↔ AI Models

> **Writable directory:** `backend/` per `AGENTS.md:1`
> **Refs:** `ai/contracts.ts:1`, `ai/model-registry.ts:10`, `ai/contracts.md:1`, `BACKEND_HANDOFF.md:1`, `docs/architecture/components-and-contracts.md:1`, `docs/architecture/flows-and-data.md:1`, `docs/demo-requirements.md:1`, `PRODUCT.md:1`

## 0. Purpose

This plan locks the backend structure that connects the Electron **renderer (frontend)** to the **AI models** via a single normalized gateway. It lists every IPC channel, internal service route, model endpoint, tool invocation and event that will be implemented under `backend/`. No model call bypasses `ModelGateway`; no renderer path reaches the filesystem directly.

```
Renderer (React)  ──IPC (WorkbenchBridge)──▶  Electron Main / Backend (backend/)
                                                    │
                                                    ├──▶ ModelGateway ──▶ OpenRouter (dev) / LAN mlx-lm + llama-server (final)
                                                    ├──▶ Chroma (local embeddings)
                                                    ├──▶ SQLite + data/runs/<runId>/
                                                    └──▶ Bubblewrap + LibreOffice workers
```

---

## 1. Proposed Directory Structure

All code below lives inside the single writable directory `backend/` (per boundary rule `AGENTS.md:18`).

```
backend/
├── BACKEND_PLANS.md              # this file
├── index.ts                      # existing stub — becomes barrel re-export
├── package.json                  # backend deps (zod, better-sqlite3, chroma client)
├── config/
│   └── models.json               # runtime copy of registry; dev = OpenRouter, final = LAN-only
├── src/
│   ├── main/
│   │   ├── index.ts              # Electron main entry (wires ipcMain handlers)
│   │   ├── ipc/
│   │   │   ├── channels.ts       # IPC channel name constants
│   │   │   ├── handlers.ts       # workbench:* handlers + window controls
│   │   │   └── validators.ts     # Zod validation of StartRunInput/ConfirmActionInput
│   │   ├── run/
│   │   │   ├── run-manager.ts    # create runId, state machine, iteration cap=8
│   │   │   ├── state-machine.ts  # RunState transitions + persistence
│   │   │   └── filesystem.ts     # data/runs/<runId>/{input,intermediate,output,logs} + token logic
│   │   ├── router/
│   │   │   └── deterministic-router.ts  # fileType/intent → TaskType → ModelId + reason
│   │   ├── orchestrator/
│   │   │   ├── orchestrator.ts   # plan→act→observe loop, iteration guard
│   │   │   ├── flow-a.ts         # locked Flow A sequence BACKEND_HANDOFF.md:544
│   │   │   └── flow-b.ts         # locked Flow B sequence BACKEND_HANDOFF.md:574 + summarize phase BACKEND_HANDOFF.md:179
│   │   ├── gateway/
│   │   │   ├── model-gateway.ts  # ModelGateway interface BACKEND_HANDOFF.md:71
│   │   │   ├── registry.ts       # load/validate ModelRegistryEntry ai/contracts.ts:16
│   │   │   ├── openrouter.ts     # OpenAI-compatible /v1/chat/completions adapter
│   │   │   ├── local-llm.ts      # mlx-lm / llama-server adapter (same /v1 contract)
│   │   │   └── normalizer.ts     # strip fences, map finish reasons, cap sizes
│   │   ├── tools/
│   │   │   ├── read_file.ts
│   │   │   ├── ocr_extract.ts    # → VisionModelRequest ai/contracts.ts:59
│   │   │   ├── search_knowledge.ts # Chroma topK≤5
│   │   │   ├── draft_note.ts     # → DraftModelRequest ai/contracts.ts:67
│   │   │   ├── generate_docx.ts  # docx + LibreOffice PDF
│   │   │   ├── draft_code.ts     # → CodeModelRequest ai/contracts.ts:77
│   │   │   ├── execute_python.ts # Bubblewrap --unshare-net 60s
│   │   │   └── generate_xlsx.ts
│   │   ├── validators/
│   │   │   ├── vision.ts
│   │   │   ├── draft.ts
│   │   │   └── code.ts           # Zod schemas for ai/contracts.ts:143,185,195
│   │   ├── persistence/
│   │   │   ├── db.ts             # better-sqlite3 init
│   │   │   ├── schema.sql        # runs, transitions, routing, confirmations, artifacts
│   │   │   └── audit.ts
│   │   ├── confirmation/
│   │   │   └── confirmation-store.ts # PendingAction BACKEND_HANDOFF.md:399, 5-min expiry
│   │   ├── health/
│   │   │   └── health-check.ts   # gateway.health() per ModelId
│   │   └── sovereignty/
│   │       └── monitor-bridge.ts # LAN allowlist (5 hosts), externalRequestCount
│   └── shared/
│       ├── contracts.ts          # re-export from ai/contracts.ts (read-only mirror)
│       ├── errors.ts             # AIErrorCode ai/contracts.ts:218 mapping
│       └── events.ts             # RunEvent union docs/architecture/components-and-contracts.md:124
├── data/                         # gitignored, run-scoped artifacts (via filesystem.ts)
└── tests/
    ├── gateway.test.ts
    ├── validators.test.ts
    ├── filesystem.test.ts
    ├── confirmation.test.ts
    └── flows.test.ts
```

Preload bridge lives in `electron_app/electron/preload.ts:1` but **only exposes** the typed contract in §2 — no Node/fs/raw IPC leakage.

---

## 2. Electron Frontend ↔ Backend — IPC Routes (WorkbenchBridge)

All renderer→main calls are `ipcMain.handle` request/response; main→renderer pushes are `webContents.send` events. Channel names are namespaced `workbench:*`; window controls remain `window-*` `electron_app/electron/main.ts:75`.

### 2.1 Channel Table

| # | IPC Channel | Kind | Renderer API (`preload` → `WorkbenchBridge`) | Main Handler (`backend/src/main/ipc/handlers.ts`) | Request Shape | Response Shape | Notes |
|---|-------------|------|----------------------------------------------|---------------------------------------------------|---------------|---------------|-------|
| 1 | `workbench:startRun` | `invoke` | `startRun(input: StartRunInput)` | `handleStartRun` | `StartRunInput` (see 2.2) | `Promise<{runId: string}>` | Creates `runs/<runId>`, validates token, classifies, kicks orchestrator async, returns immediately |
| 2 | `workbench:confirmAction` | `invoke` | `confirmAction(input: ConfirmActionInput)` | `handleConfirmAction` | `ConfirmActionInput` `BACKEND_HANDOFF.md:408` | `Promise<void>` | Auth: exact `runId+actionId`, expiry 5m, replay reject |
| 3 | `workbench:cancelRun` | `invoke` | `cancelRun(input: {runId})` | `handleCancelRun` | `{runId: string}` | `Promise<void>` | Sets `cancelled`, invalidates pending actions, checked pre-tool/model |
| 4 | `workbench:getArtifact` | `invoke` | `getArtifact({runId,artifactId})` | `handleGetArtifact` | `{runId, artifactId}` | `Promise<ArtifactRef>` | Run-scoped path check; returns run-relative metadata, not abs path |
| 5 | `workbench:getRunHistory` | `invoke` | `getRunHistory({limit?})` | `handleGetRunHistory` | `{limit?: number}` | `Promise<RunSummary[]>` | Bounded, SQLite-backed |
| 6 | `workbench:registerAttachment` | `invoke` | `registerAttachment(fileMeta)` (internal, called on drop) | `handleRegisterAttachment` | `{filename, mediaType, sizeBytes, base64OrBuffer}` | `Promise<AttachmentReference>` `ai/contracts.ts:29` | Main copies to `data/runs/<runId>/input/`, issues token; validates MIME/size |
| 7 | `workbench:getHealth` | `invoke` | `getHealth()` | `handleGetHealth` | `void` | `Promise<ModelHealth[]>` `BACKEND_HANDOFF.md:77` | Called at launch + on demand for sovereignty panel |
| 8 | `workbench:onRunEvent` | `on` (push) | `onRunEvent(listener)` → `()=>void` | `emit RunEvent` | — | `RunEvent` stream | 8 event types per `docs/architecture/components-and-contracts.md:124` |

Existing window channels unchanged: `window-minimize` / `window-maximize` / `window-close` `electron_app/electron/main.ts:75`.

### 2.2 `StartRunInput` (frontend → backend)

```ts
interface StartRunInput {
  userText: string;                 // e.g. "Draft the approval note..." / "Flag out-of-range..."
  attachmentToken?: string;         // opaque ID from registerAttachment; never absolute path
  // no filesystem path from renderer — enforced in validators.ts
}
```

Validation (`backend/src/main/ipc/validators.ts`): `userText` bounded ≤ 8k, `attachmentToken` exists in run dir, no `..` traversal, renderer absolute path rejected `BACKEND_HANDOFF.md:211`.

### 2.3 `ConfirmActionInput`

```ts
interface ConfirmActionInput { runId: string; actionId: string; approved: boolean; } // BACKEND_HANDOFF.md:408
interface PendingAction { actionId: string; runId: string; kind: "generate_docx"|"execute_python"|"generate_xlsx"; prompt: string; createdAt: string; expiresAt: string; } // BACKEND_HANDOFF.md:399
```

Locked prompts `BACKEND_HANDOFF.md:427`:
- `Generate the approval-note DOCX?` (Flow A)
- `Execute the generated Python?` (Flow B step 1)
- XLSX proposal text for Flow B step 2 (derived from validated rows).

### 2.4 `RunEvent` Stream (backend → frontend)

Each event includes `runId` and is emitted via `win.webContents.send("workbench:runEvent", event)`; preload re-exposes as `onRunEvent`.

```ts
type RunEvent =
 | { type:"run_state"; runId:string; state: RunState }                          // RunState BACKEND_HANDOFF.md:251
 | { type:"routing"; runId:string; taskType: TaskType; modelId: ModelId; reason:string } // reasons: "scanned report"|"compose approval note"|"CSV/code intent" docs/demo-requirements.md:102
 | { type:"plan_step"; runId:string; index:number; text:string }
 | { type:"tool_call"; runId:string; tool: ToolName; summary:string }
 | { type:"tool_result"; runId:string; tool: ToolName; summary:string }
 | { type:"confirmation_required"; runId:string; action: PendingAction }
 | { type:"artifact_ready"; runId:string; artifact: ArtifactRef }
 | { type:"error"; runId:string; code: AIErrorCode|ValidationFailure["code"]; message:string; retryable?:boolean }
```

Artifact ref shape (returned by `generate_docx`/`generate_xlsx`/`execute_python`):

```ts
interface ArtifactRef { artifactId:string; runId:string; kind:"docx"|"pdf"|"xlsx"|"csv"; filename:string; relativePath:string; sizeBytes:number; createdAt:string; }
```

Renderer constraints: displays transcript live, routing badge updates on `routing`, confirmation dialog on `confirmation_required`, preview pane on `artifact_ready` — no Node/fs/model access `docs/architecture/components-and-contracts.md:103`.

---

## 3. Backend ↔ AI Models — Gateway Routes

### 3.1 The Single Gateway Interface (`backend/src/main/gateway/model-gateway.ts`)

Per `BACKEND_HANDOFF.md:71` the orchestrator and tools **never** call providers directly:

```ts
interface ModelGateway {
  execute(request: ModelRequest): Promise<AIResult<ModelResponse>>; // AIResult ai/contracts.ts:253 preserves requestId/runId on fail
  health(modelId: ModelId): Promise<ModelHealth>;
  cancel?(requestId: string): Promise<void>;
}
interface ModelHealth { modelId: ModelId; available:boolean; checkedAt:string; latencyMs?:number; message?:string; } // BACKEND_HANDOFF.md:77
```

### 3.2 Model Registry → Endpoint Mapping

Source of truth: `backend/config/models.json` (dev copy = `ai/model-registry.ts:10`; final LAN copy = 5-host allowlist `docs/architecture/deployment-and-sovereignty.md:5`).

| Internal `ModelId` `ai/contracts.ts:5` | `TaskType` `ai/contracts.ts:1` | Runtime `ai/contracts.ts:3` | Dev `baseUrl` | Final LAN `baseUrl` (example) | Model slug `ai/model-registry.ts:16` | Capabilities `ai/contracts.ts:10` | Timeout `ai/model-registry.ts:18` | Purpose |
|---|---|---|---|---|---|---|---|---|
| `vision-qwen25vl` | `vision` | `openrouter`→`mlx-lm` | `https://openrouter.ai/api/v1` | `http://192.168.10.11:8000/v1` (M4 Mini) | `qwen/qwen2.5-vl-3b-instruct` | `text`, `image-input`, `structured-output` | 60 000 ms | Clean typed scan → `VisionResult` `ai/contracts.ts:143` |
| `draft-qwen3` | `draft` | `openrouter`→`llama-server` | `https://openrouter.ai/api/v1` | `http://192.168.10.12:8001/v1` (i7 #1) | `qwen/qwen3-4b` | `text`, `structured-output` | 45 000 ms | Approval note grounded in SOP |
| `code-qwen25coder` | `code` | `openrouter`→`llama-server` | `https://openrouter.ai/api/v1` | `http://192.168.10.13:8002/v1` (i7 #2) | `qwen/qwen2.5-coder-7b-instruct` | `text`, `code-generation` | 60 000 ms | `task.py` + summarize phase |

Embedding (separate service, not a task route) `ai/model-registry.ts:53`:
| Service | Model | Dims | Metric | Dev `baseUrl` | Final `baseUrl` | Timeout |
|---|---|---|---|---|---|---|
| `embeddings` | `BAAI/bge-small-en-v1.5` | 384 | cosine | `http://<local-embedding-host>/v1` | `http://192.168.10.15:8003/v1` (i5) | 10 000 ms |

> Transition `PRODUCT.md:82`: dev validates via `OPENROUTER_API_KEY` env `backend/.env.example:1`; final removes OpenRouter entries and re-runs health checks `docs/architecture/components-and-contracts.md:61`.

### 3.3 Provider HTTP Routes (inside gateway adapters)

Each adapter (`openrouter.ts` / `local-llm.ts`) speaks **OpenAI-compatible** HTTP; these are **never exposed to renderer**.

| Method | Path | Adapter | Used for | Request body (internal) | Success mapping |
|---|---|---|---|---|---|
| `POST` | `/v1/chat/completions` | `openrouter.ts` + `local-llm.ts` | All three `ModelRequest` types | `{model: string, messages:[{role:"system",content:systemPrompt},{role:"user",content:userPrompt (+ image_url for vision)}], response_format:{type:"json_object"} (when structured), temperature, max_tokens}` | Parse `choices[0].message.content` as JSON → `ModelResponse` `ai/contracts.ts:121`; strip markdown fences; attach `requestId/runId` |
| `GET` | `/v1/models` (=`healthPath` `ai/contracts.ts:24`) | both adapters | `gateway.health(modelId)` | `Authorization: Bearer ${process.env[apiKeyEnv]}` only for OpenRouter | `{available, latencyMs, message}`; failure→`model_unavailable` `ai/contracts.ts:218` |
| `POST` | `/v1/embeddings` | embedding client (Chroma) | `search_knowledge` indexing/query | `{model:"BAAI/bge-small-en-v1.5", input: text, dimensions:384}` | Cosine vector stored in Chroma |

Gateway responsibilities checklist `BACKEND_HANDOFF.md:89`:
1. Resolve `modelId` via registry, reject disabled/unknown + task-type mismatch + missing `image-input`/`structured-output`.
2. Read `OPENROUTER_API_KEY` from env only for runtime `openrouter`; never leak to logs/SQLite/renderer.
3. Translate `ModelRequest` → provider chat request; inject `AttachmentReference` image/PDF (read-only `relativePath`).
4. Apply `timeoutMs` from registry + response-size cap; map provider errors → `AIErrorCode` `ai/contracts.ts:218`.
5. Normalize `AIResult<T>` `ai/contracts.ts:253` preserving `requestId`/`runId`.

Provider normalization `BACKEND_HANDOFF.md:108`: OpenAI envelope stripped, fences removed or `invalid_model_response`, finish-reason only diagnostic, truncated→`empty_model_response`, streaming only for UI draft text (final persisted still validated).

### 3.4 Request/Response Shapes (already typed in `ai/contracts.ts`)

- `VisionModelRequest` `ai/contracts.ts:59` → `VisionModelResponse.result: VisionResult` `ai/contracts.ts:106`
- `DraftModelRequest` `ai/contracts.ts:67` → `DraftModelResponse.result: DraftResult` `ai/contracts.ts:111`
- `CodeModelRequest` `ai/contracts.ts:77` → `CodeModelResponse.result: CodeDraftResult` `ai/contracts.ts:116` (generate phase)
- `CodeSummarizeRequest` (added per `BACKEND_HANDOFF.md:179`): `taskType:"code", modelId:"code-qwen25coder", phase:"summarize", execution: PythonExecutionResult` `ai/contracts.ts:204` — summarizes *actual* execution, never model prediction; timeout/non-zero → failed verification `BACKEND_HANDOFF.md:207`.

---

## 4. Tool Routes (Internal — `backend/src/main/tools/`)

Tools are **not HTTP endpoints**; they are orchestrator-called functions validated in `backend/src/main/tools/*.ts` and streamed as `tool_call`/`tool_result` events. All I/O via run-scoped FS; model cannot invent tool names/endpoints `docs/architecture/components-and-contracts.md:88`.

| Tool | Trigger | Input (validated Zod) | Implementation route | Output (validated) | Confirmation | Failure → visible |
|---|---|---|---|---|---|---|
| `read_file` | Flow B auto | `AttachmentReference` token or run-relative path | Local reader, MIME/size allowlist, ro | `InputFileReference` `ai/contracts.ts:37` (columns, rowCount for CSV) | none | `unsupported_task`/`invalid_model_response` |
| `ocr_extract` | Flow A auto | `AttachmentReference` (PDF/image) | `gateway.execute(VisionModelRequest)` → `VisionResult` `ai/contracts.ts:143` + page-ref integrity | findings with page evidence, `sourceText` capped | none | `invalid_model_response` if missing `findingId`/`page`>0 etc |
| `search_knowledge` | Flow A auto | `query:string, topK≤5` | Chroma `query(embeddings)` local only | `RetrievedKnowledgeChunk[]` `ai/contracts.ts:156` stable `documentId`/`sectionId` | none | `no_knowledge_match` |
| `draft_note` | Flow A auto | `findings+pageRefs+chunks+templateRequirements` | `gateway.execute(DraftModelRequest)` → `DraftResult` `ai/contracts.ts:185` | 4 sections `approvalNoteSectionId` `ai/contracts.ts:168`, citations `ai/contracts.ts:163`, `missingInformation` explicit | none | `unsupported_citation`/`missing_required_content` if `[SOP-114 §3.2]` absent `BACKEND_HANDOFF.md:158` |
| `generate_docx` | Flow A confirm | validated `DraftResult` | docx worker + LibreOffice PDF preview in `data/runs/<runId>/output/` | `ArtifactRef` `approval-note-E201.docx` + PDF | **yes** `Generate the approval-note DOCX?` | `docx/pdf conversion failure` no fake preview |
| `draft_code` | Flow B auto | `task+InputFileReference+executionRules` | `gateway.execute(CodeModelRequest)` | `CodeDraftResult` `ai/contracts.ts:195` (`task.py` only `ai/contracts.ts:196`, `allowedImports` advisory) | none | `unsafe_generated_code` if shell/subprocess/network |
| `execute_python` | Flow B confirm | `source+inputRefs` | Bubblewrap fixed runner `docs/architecture/deployment-and-sovereignty.md:52` | `PythonExecutionResult` `ai/contracts.ts:204` capped stdout/stderr, `OUT_OF_RANGE 7/240 (high=5, low=2)` `docs/demo-requirements.md:122` | **yes** `Execute the generated Python?` | `python timeout` (60s) / non-zero exit → failed verification |
| `generate_xlsx` | Flow B confirm 2 | validated `PythonExecutionResult.outputFiles` rows | xlsx worker | `ArtifactRef` `out-of-range-summary.xlsx` | **yes** second approval `BACKEND_HANDOFF.md:388` | `xlsx generation failure` |

Flow policy guard: `docs/architecture/components-and-contracts.md:94` — Flow A auto set ≠ Flow B auto set; unlisted tool → `unsupported_task` + audit event, never overridden by renderer/model.

---

## 5. Attachment & Filesystem Routes

Renderer **never** sends absolute path `BACKEND_HANDOFF.md:211`.

```
Renderer drop  ──▶  workbench:registerAttachment ──▶  main copies to data/runs/<runId>/input/
                                                    ├─ assigns random token / attachmentId
                                                    ├─ validates MIME allowlist + size bound
                                                    └─ returns AttachmentReference{relativePath}
                                                                         │
Orchestrator/Gateway ◀──── resolves token to run-relative path (checks .. , symlink escape, run isolation)
Tools/Workers ────▶ data/runs/<runId>/{intermediate,output,logs}
SQLite ───────────▶ stores metadata/relativePath only  BACKEND_HANDOFF.md:495
```

Layout `BACKEND_HANDOFF.md:235`:
```
data/runs/<runId>/
  input/           # original attachments (read-only for execution)
  intermediate/    # OCR text, chunks, draft JSON
  output/          # approval-note-E201.docx, .pdf, out-of-range-summary.xlsx, task.py outputs
  logs/            # capped stdout/stderr, audit jsonl
```

Guards `BACKEND_HANDOFF.md:227` + `docs/architecture/flows-and-data.md:6`: `..` rejected, absolute path rejected, cross-run access rejected, symlink/junction escape rejected, large `sourceText` truncated/rejected by policy.

---

## 6. Run Lifecycle & Routing Events

### 6.1 State Machine (`backend/src/main/run/state-machine.ts`)

`RunState` `BACKEND_HANDOFF.md:251` + transition diagram `docs/architecture/components-and-contracts.md:8`:

```
created → classifying → planning → acting ⇆ awaiting_confirmation → completed
  ↘ cancelled   (any pre-terminal)        ↘ failed (validation/tool/timeout/iteration>8)
```

Rules `BACKEND_HANDOFF.md:263`: `runId`/`requestId` UUID, transitions persisted to SQLite, `cancelled` cannot later create artifact, max 8 iterations, cancellation checked pre-model/tool `BACKEND_HANDOFF.md:267`.

### 6.2 Deterministic Router (`backend/src/main/router/deterministic-router.ts`)

Spec `docs/architecture/components-and-contracts.md:77` / `BACKEND_HANDOFF.md:277`:

| Input signal | `TaskType` | `ModelId` selected | `reason` emitted in `routing` event |
|---|---|---|---|
| image/PDF to inspect | `vision` | `vision-qwen25vl` | `scanned report` |
| text mentions csv/calculation/script/code/execution/data transformation | `code` | `code-qwen25coder` | `CSV/code intent` |
| after Flow A OCR+retrieval | `draft` | `draft-qwen3` | `compose approval note` |
| else | `draft` | `draft-qwen3` | (fallback, not used in locked demos) |

Every route emits `routing` event `docs/architecture/components-and-contracts.md:126`; UI badges update live per `PRODUCT.md:22`.

### 6.3 Locked Sequences

**Flow A** `BACKEND_HANDOFF.md:543` + `docs/architecture/flows-and-data.md:16` + `docs/demo-requirements.md:24`:
1. `startRun` → `run_state:classifying` → `routing:vision/scanned report` → `ocr_extract` validates 3 findings `docs/demo-requirements.md:80`
2. `search_knowledge` verifies `SOP-114 §3.2`+`TPL-012` top 5 `docs/demo-requirements.md:90`
3. `routing:draft/compose approval note` → `draft_note` validates 4 sections `ai/contracts.ts:168` + citation membership `ai/contracts.md:48`
4. `confirmation_required:generate_docx` → approve → `generate_docx` + PDF → `artifact_ready` → `completed` only after both succeed `BACKEND_HANDOFF.md:559`. Note must contain E-201 header, 3 findings, conditional clearance, `SOP-114 §3.2` grounding `docs/demo-requirements.md:96`.

**Flow B** `BACKEND_HANDOFF.md:573` + `docs/architecture/flows-and-data.md:57` + `docs/demo-requirements.md:52`:
1. `startRun` with `reactor-temperature-log.csv` → `routing:code/CSV/code intent` → `read_file` validates 240 rows `docs/demo-requirements.md:19`
2. `draft_code` validates `task.py` → `confirmation_required:execute_python`
3. Approve → Bubblewrap runner (ro input, rw output, `--unshare-net`, 60s) → `PythonExecutionResult` exit 0, `OUT_OF_RANGE 7/240 (high=5, low=2)` `docs/demo-requirements.md:122`, 7 rows (5 high,2 low)
4. Propose `generate_xlsx` → `confirmation_required:generate_xlsx` → approve → `out-of-range-summary.xlsx`
5. `code summarize` phase `BACKEND_HANDOFF.md:179` with actual `execution` (exitCode, timedOut, capped stdout/stderr, outputFiles) → `completed` only if verified summary consistent `BACKEND_HANDOFF.md:590`.

---

## 7. Validators, Errors, Persistence & Sovereignty

### 7.1 Runtime Validators (`backend/src/validators/*.ts`)

Compile-time `ai/contracts.ts` ≠ runtime `BACKEND_HANDOFF.md:119` / `ai/contracts.md:129`. Use Zod strict schemas; failures stop workflow before persist/use `BACKEND_HANDOFF.md:170`.

- **Common** `ai/contracts.ts:92`: `requestId===request.requestId`, `runId` active, `modelId` matches called model, `completedAt` ISO timestamp, `taskType` discriminator `BACKEND_HANDOFF.md:125`.
- **Vision** `ai/contracts.ts:143`: `sourceText` bounded, `findingId` unique, `pageReferenceIds` → existing refs, `page` positive int, `confidence` enum `ai/contracts.ts:126`, demo 3 findings + no handwriting claim `BACKEND_HANDOFF.md:143`.
- **Draft** `ai/contracts.ts:185`: 4 section IDs present+unique `ai/contracts.ts:168`, bodies bounded, citation `documentId/sectionId` stable, `retrievedChunks` membership `ai/contracts.md:48`, missing info explicit, `[SOP-114 §3.2]` present `BACKEND_HANDOFF.md:158`.
- **Code** `ai/contracts.ts:195`: `filename==="task.py"`, source < cap, `allowedLanguage==="python"` `ai/contracts.ts:83`, no shell/subprocess/network client, imports vs allowlist (model `allowedImports` advisory only) `BACKEND_HANDOFF.md:165`, filenames logical not paths.

### 7.2 Error Mapping

Surface stable `AIErrorCode` `ai/contracts.ts:218` in `error` events `docs/architecture/components-and-contracts.md:132`; internal diagnostics stripped of keys. Must distinguish `BACKEND_HANDOFF.md:497`:

| Code `ai/contracts.ts:218` | When |
|---|---|
| `model_unavailable` / `model_timeout` / `model_rejected_request` | gateway health/timeout/provider 4xx |
| `empty_model_response` / `invalid_model_response` | truncated or failing validator |
| `unsupported_task` | tool not allowed in flow or unknown `ModelId` |
| `no_knowledge_match` | Chroma topK empty |
| `unsupported_citation` / `missing_required_content` | citation not in `retrievedChunks` / missing `[SOP-114 §3.2]` etc |
| `unsafe_generated_code` | shell/network in `CodeDraftResult.source` |
| plus: python timeout / non-zero exit, docx/pdf fail, xlsx fail, user rejection, expiry, cancellation, iteration limit | mapped to same `error` event with `retryable:false` unless transient |

### 7.3 Persistence (SQLite)

Stores `docs/architecture/components-and-contracts.md:137` / `BACKEND_HANDOFF.md:469`: `runId`, created/completed timestamps, `StartRunInput` summary, `AttachmentReference` metadata, state transitions, routing decisions+reasons, `requestId`/`ModelId`, tool calls + bounded results, `PendingAction` + outcomes, citations, `ArtifactRef`, `PythonExecutionResult` capped logs + `exitCode/timedOut/durationMs`, error codes. Excludes keys, abs paths, full confidential docs, unbounded prompts `BACKEND_HANDOFF.md:481`. Large files on disk `data/runs/<runId>/`.

### 7.4 Sovereignty & Health Routes

| Route/Event | Backend impl | Frontend rendering |
|---|---|---|
| `workbench:getHealth` invoke + launch-time `health-check.ts` | `GET <baseUrl>/v1/models` per registry entry, records `latencyMs/available` | Sovereignty panel: 5-host allowlist, per-model badge, `externalRequestCount=0` `PRODUCT.md:92` |
| `sovereignty:monitorState` push (from `monitor-bridge.ts`) | Reads independent monitor/firewall (not fabricated) `docs/architecture/deployment-and-sovereignty.md:34` | `monitor-active` indicator; blocked-egress proof retained `docs/architecture/deployment-and-sovereignty.md:37` |
| OpenRouter egress counter | Gateway logs per `ModelGateway.execute` call | Dev shows real count; final LAN shows 0 `BACKEND_HANDOFF.md:539` |

Network policy `BACKEND_HANDOFF.md:523`: backend never creates arbitrary network clients from model output; embedding is LAN-only; Python `--unshare-net`; final disables `OPENROUTER_API_KEY`.

---

## 8. IPC Wiring Checklist (for `backend/src/main/ipc/handlers.ts`)

```ts
// channels.ts
export const IPC = {
  START_RUN: "workbench:startRun",
  CONFIRM:   "workbench:confirmAction",
  CANCEL:    "workbench:cancelRun",
  GET_ARTIFACT: "workbench:getArtifact",
  GET_HISTORY:  "workbench:getRunHistory",
  REGISTER_ATTACHMENT: "workbench:registerAttachment",
  GET_HEALTH:  "workbench:getHealth",
  RUN_EVENT:   "workbench:runEvent",
} as const;
```

Preload `electron_app/electron/preload.ts:3` replaces wildcard expose with:

```ts
contextBridge.exposeInMainWorld("workbench", {
  startRun: (i: StartRunInput) => ipcRenderer.invoke(IPC.START_RUN, i),
  confirmAction: (i: ConfirmActionInput) => ipcRenderer.invoke(IPC.CONFIRM, i),
  cancelRun: (i:{runId:string}) => ipcRenderer.invoke(IPC.CANCEL, i),
  getArtifact: (i:{runId:string;artifactId:string}) => ipcRenderer.invoke(IPC.GET_ARTIFACT, i),
  getRunHistory: (i?:{limit?:number}) => ipcRenderer.invoke(IPC.GET_HISTORY, i),
  getHealth: () => ipcRenderer.invoke(IPC.GET_HEALTH),
  onRunEvent: (cb:(e:RunEvent)=>void) => { const h=(_:any,e:RunEvent)=>cb(e); ipcRenderer.on(IPC.RUN_EVENT,h); return ()=>ipcRenderer.off(IPC.RUN_EVENT,h); }
});
```

Handler guards: `zod` validate inputs, run-isolation check, pending-action expiry check, iteration-cap check, re-validate before `generate_docx`/`execute_python`/`generate_xlsx`.

---

## 9. Configuration & Secrets

| Key | Location | Allowed values |
|---|---|---|
| `OPENROUTER_API_KEY` | `backend/.env` (gitignored `backend/.gitignore`), example in `backend/.env.example:1` | env var name in `ModelRegistryEntry.apiKeyEnv` `ai/contracts.ts:25`; never in `config/models.json`, logs, SQLite, fixtures |
| `config/models.json` | `backend/config/models.json` | sole model-selection config `docs/architecture/components-and-contracts.md:34`; edited pre-rehearsal only |
| embedding `baseUrl` | same file / `developmentEmbeddingService.baseUrl` `ai/model-registry.ts:58` | final = `http://<i5>/v1` LAN-only |

---

## 10. Testing Matrix (acceptance per `BACKEND_HANDOFF.md:596`)

- **Gateway**: resolve, unknown/disabled reject, env-key only, normalization, timeout map, ID preservation.
- **Validation**: vision missing field / unknown page-ref / draft missing section / unsupported citation / shell-in-code / oversized source.
- **FS**: absolute-path reject, `..` reject, cross-run reject, artifact inside `output/`, no net from Bubblewrap, input ro.
- **Confirmation**: reject→no artifact, expired→no artifact, cancelled invalidates pendings, replay rejected.
- **Flow A/B**: routing reasons exact, findings exact `docs/demo-requirements.md:80`, `OUT_OF_RANGE 7/240` exact, DOCX/XLSX only post-approval.

---

## 11. Implementation Order

Matches `BACKEND_HANDOFF.md:661`:
1. `main/index.ts` + `ipc/*` + window controls wiring.
2. `run/filesystem.ts` + token issuance.
3. `gateway/registry.ts` + `health-check.ts`.
4. `gateway/model-gateway.ts` + adapters + normalizer.
5. `validators/*`.
6. `persistence/*`.
7. `run/state-machine.ts` + event emitter.
8. `router/deterministic-router.ts`.
9. `tools/read_file, ocr_extract, search_knowledge`.
10. `orchestrator/flow-a.ts` + `tools/draft_note, generate_docx`.
11. `tools/draft_code, execute_python` (Bubblewrap) + `validators/code.ts`.
12. Flow B summarize + `generate_xlsx` confirm.
13. `confirmation/*` + cancellation/expiry/retry.
14. `sovereignty/*` + renderer wiring.
15. Rehearsal on final LAN topology per `docs/architecture/deployment-and-sovereignty.md:18`.

## 12. Done Definition

Per `BACKEND_HANDOFF.md:680` + `PRODUCT.md:94` + `docs/demo-requirements.md:134`: renderer can start run via token, gateway routes all three models normalized, every model result validated pre-use, Flow A → cited DOCX/PDF post-approval, Flow B → verified 7/240 + XLSX post-approvals, all routing/tools/confirmations/artifacts/errors streamed + persisted, cancellation/rejection/expiry/timeout/malformed/unavailable paths safe, final LAN config shows 0 external requests and no model escapes run directory / picks shell / bypasses confirmation / selects endpoint.
