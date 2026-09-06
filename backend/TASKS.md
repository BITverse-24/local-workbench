# Backend TASKS — Derived from `BACKEND_PLANS.md`

> Source: `backend/BACKEND_PLANS.md:1` → locks all IPC, gateway, tool and event contracts.
> Refs: `ai/contracts.ts:1`, `ai/model-registry.ts:10`, `BACKEND_HANDOFF.md:1`, `docs/architecture/components-and-contracts.md:1`, `docs/architecture/flows-and-data.md:1`, `docs/demo-requirements.md:1`, `PRODUCT.md:1`, root `TASKS.md:1`
> Writable scope: `backend/` per `AGENTS.md:1`. No writes outside this dir except `PROPOSALS.md` exception.
> Owner: **Supreet — Backend** (Electron main, router, orchestrator, gateway, tools, persistence, FS, packaging)

How to use: tasks with same prefix can run in parallel. `Phase` = delivery sequence. Each task has one owner, inputs, steps, and verifiable done condition. Check off with `- [x]` when SQLite persisted + event streamed + test in `backend/tests/` passes.

---

## Phase DB — Database setup & working (do first)

> Schema source: `backend/DATABASE.md:1`. This phase must complete before Phase 0 — every later phase persists through it.

### DB.1 Create SQLite file, schema & connection
**Owner:** Supreet | **Depends:** — | **Plan:** `backend/DATABASE.md:35`, `backend/BACKEND_PLANS.md:339`
**Do:**
1. Add deps `better-sqlite3` (+ `@types/better-sqlite3` dev) and `uuid` (or use `node:crypto randomUUID` for uuid4) to `backend/package.json`.
2. Copy DDL from `backend/DATABASE.md:35` into `backend/src/main/persistence/schema.sql` (tables: `chats` uuid4 PK, `messages`, `attachments`, `message_attachments`, `runs` + `run_transitions`, `routing_decisions`, `model_calls`, `tool_calls`, `execution_results`, `confirmations`, `artifacts`, `citations`, `run_errors`, `settings`, `kv_meta`).
3. Implement `backend/src/main/persistence/db.ts`: open `backend/data/workbench.db`, set `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`, run `schema.sql` idempotently, seed `settings` defaults (`selectedModel`, `temperature`, `theme`) and `kv_meta(schema_version='1')` via `INSERT OR IGNORE`.
4. Ensure `backend/.gitignore` covers `data/*.db*`, `data/workbench.db*`, `.env`.
**Done:** Fresh launch creates `data/workbench.db` with all 15 tables; re-launch is a no-op migration; `SELECT name FROM sqlite_master` shows `chats`, `messages`, `runs`, `settings`.

### DB.2 Chat / message / settings data-access working
**Owner:** Supreet | **Depends:** DB.1
**Do:**
1. Implement `backend/src/main/persistence/chats.ts`: `createChat(title?) → uuid4`, `getChat(id)`, `listChats(limit) ORDER BY updated_at DESC`, `touchChat(id)`, `archiveChat(id)`; enforce `z.string().uuid()` on all chat ids.
2. Implement `backend/src/main/persistence/messages.ts`: `addMessage({chat_id, role, content ≤32k, run_id?}) → uuid4 + seq auto-increment per chat`, `listMessages(chat_id) ORDER BY seq`, `editMessage(id, content)` sets `edited_at`; wrap `addMessage + touchChat` in one transaction.
3. Implement `backend/src/main/persistence/settings-store.ts`: `getSetting(key)`, `setSetting(key, JSON value)` upsert + `updated_at`.
4. Wire minimal IPC smoke path: `getChatHistory` → `listChats`, `getMessages({chat_id})` → `listMessages`, `createChat`/`sendMessage` → inserts (full `workbench:*` handlers land in Phase 1).
**Done:** Can create uuid4 chat, post user+assistant messages, reload from disk after restart, edit message, and round-trip a setting — all via `vitest` (`backend/tests/db.test.ts`) without the orchestrator running.

### DB.3 Verify DB working end-to-end
**Owner:** Supreet | **Depends:** DB.2
**Do:**
1. Add `backend/tests/db.test.ts`: insert chat → assert PK matches uuid4 regex; insert 2 messages → assert `seq` 0,1 ordering; update setting → re-read; delete chat → assert messages cascade-deleted; insert oversized `content` (>32k) and abs-path `relative_path` → assert rejected at app layer.
2. Run `npm --prefix backend run test -- db.test.ts` green; open `data/workbench.db` in sqlite viewer and confirm rows.
3. Record DB file path + `schema_version` in `backend/DATABASE.md:5` §5 checklist as done.
**Done:** `db.test.ts` passes; DB proven working before any scaffold/IPC work starts; Phase 0 may begin.

---

## Phase 0 — Backend scaffold & config

### 0.1 Bootstrap `backend/package.json` & toolchain
**Owner:** Supreet | **Depends:** DB.3 (Phase DB first) | **Plan:** `BACKEND_PLANS.md:26`
**Do:**
1. Init `backend/package.json` (type:module, scripts: build, test, lint). Deps: `zod`, `better-sqlite3`, `chromadb`, `docx`, `exceljs`, `uuid`, `vitest`.
2. Add `backend/tsconfig.json` (strict), `backend/config/models.json` seeded from `ai/model-registry.ts:10` (3 entries + `developmentEmbeddingService` `ai/model-registry.ts:53`).
3. Create empty barrel `backend/index.ts:1` re-exporting `src/shared/contracts.ts`.
4. Ensure `backend/.env.example:1` contains `OPENROUTER_API_KEY=` and `backend/.gitignore` ignores `data/`, `.env`, `*.db`.
**Done:** `npm --prefix backend install && npm --prefix backend run build` succeeds; `config/models.json` validates against `ModelRegistryEntry` `ai/contracts.ts:16`.

### 0.2 Create directory skeleton
**Owner:** Supreet | **Depends:** 0.1
**Do:** `mkdir -p` full tree from `BACKEND_PLANS.md:32` (`src/main/{ipc,run,router,orchestrator,gateway,tools,validators,persistence,confirmation,health,sovereignty}`, `src/shared`, `data/runs`, `tests`). Add `.gitkeep` where needed.
**Done:** Tree matches plan; no stray files outside `backend/`.

---

## Phase 1 — IPC & Electron main wiring — `BACKEND_PLANS.md:95`

### 1.1 IPC channel constants & validators
**Owner:** Supreet | **Depends:** 0.2
**Do:**
1. Create `backend/src/main/ipc/channels.ts` with `IPC` const from `BACKEND_PLANS.md:358` (`workbench:startRun`, `confirmAction`, `cancelRun`, `getArtifact`, `getRunHistory`, `registerAttachment`, `getHealth`, `runEvent`).
2. Create `backend/src/main/ipc/validators.ts` with Zod schemas: `StartRunInput` `{userText ≤8k, attachmentToken?}` and `ConfirmActionInput` `{runId, actionId, approved}` `BACKEND_HANDOFF.md:408`, rejecting absolute paths / `..` `BACKEND_HANDOFF.md:211`.
**Done:** `validators.test.ts` rejects abs path, `..`, oversized `userText`.

### 1.2 IPC handlers & preload contract
**Owner:** Supreet | **Depends:** 1.1
**Do:**
1. Implement `backend/src/main/ipc/handlers.ts` handlers for table `BACKEND_PLANS.md:101` #1-7 (`handleStartRun`, `handleConfirmAction`, `handleCancelRun`, `handleGetArtifact`, `handleGetRunHistory`, `handleRegisterAttachment`, `handleGetHealth`) — all `ipcMain.handle`, Zod-validated, run-isolation checked.
2. Replace wildcard `electron_app/electron/preload.ts:3` expose with typed `workbench` object from `BACKEND_PLANS.md:372` (`startRun`, `confirmAction`, `cancelRun`, `getArtifact`, `getRunHistory`, `getHealth`, `onRunEvent`).
3. Keep `electron_app/electron/main.ts:75` window controls; add `backend/src/main/index.ts` wiring `whenReady → register handlers`.
**Done:** Renderer calls `window.workbench.startRun()` → main handler fires; wildcard `ipcRenderer` no longer exposed; `vitest` mock IPC passes.

---

## Phase 2 — Run filesystem & attachment tokens — `BACKEND_PLANS.md:243`

### 2.1 Run-scoped filesystem
**Owner:** Supreet | **Depends:** 1.2
**Do:**
1. Implement `backend/src/main/run/filesystem.ts`: `createRunDir(runId)` → `data/runs/<runId>/{input,intermediate,output,logs}` `BACKEND_HANDOFF.md:235`; `resolveAttachmentToken(token)` with checks: no `..`, no symlink/junction escape, run isolation `BACKEND_HANDOFF.md:227`, MIME allowlist (`application/pdf`, `image/*`, `text/csv`), size cap (e.g. 20MB).
2. Move large artifacts to disk; SQLite stores only `AttachmentReference` `ai/contracts.ts:29` relativePath `BACKEND_HANDOFF.md:495`.
**Done:** `filesystem.test.ts` passes: abs path rejected, `..` rejected, cross-run rejected, symlink escape rejected, MIME/size rejected, `run-scoped artifact` inside `output/` only.

### 2.2 Attachment registration flow
**Owner:** Supreet | **Depends:** 2.1
**Do:** `handleRegisterAttachment(fileMeta)` copies dropped file into `data/runs/<runId>/input/`, generates `attachmentId = uuid`, returns `AttachmentReference` `ai/contracts.ts:29`. Enforced before `startRun` uses token.
**Done:** Drop in renderer → token returned → `ocr_extract` receives `AttachmentReference`, never renderer path `BACKEND_HANDOFF.md:211`.

---

## Phase 3 — Registry & health — `BACKEND_PLANS.md:179`

### 3.1 Registry loader
**Owner:** Supreet | **Depends:** 0.1
**Do:** `backend/src/main/gateway/registry.ts` loads `backend/config/models.json`, validates `ModelRegistryEntry` `ai/contracts.ts:16`, rejects unknown/disabled `ModelId` `BACKEND_HANDOFF.md:60`, enforces `taskTypes` + `capabilities` `ai/contracts.ts:10` per `BACKEND_HANDOFF.md:89`. `apiKeyEnv` only name, never value.
**Done:** Unknown/disabled model → `model_unavailable` `ai/contracts.ts:218`; wrong `taskType` → `unsupported_task`.

### 3.2 Health checks & sovereignty probe
**Owner:** Supreet | **Depends:** 3.1
**Do:** `backend/src/main/health/health-check.ts` implements `health(modelId)` `BACKEND_HANDOFF.md:77` via `GET <baseUrl>/v1/models` `BACKEND_PLANS.md:202`; measures `latencyMs`, maps failure → `model_unavailable`. Run at launch; `workbench:getHealth` exposes to renderer. Also probe `BAAI/bge-small-en-v1.5` embeddings `ai/model-registry.ts:53`.
**Done:** Launch shows per-model `available` badge; unavailable model blocks `startRun` with clear error `docs/architecture/components-and-contracts.md:61`.

---

## Phase 4 — Model gateway & normalizer — `BACKEND_PLANS.md:164`

### 4.1 `ModelGateway` interface + adapters
**Owner:** Supreet | **Depends:** 3.1, 3.2
**Do:**
1. `backend/src/main/gateway/model-gateway.ts` — `interface ModelGateway { execute(request: ModelRequest): Promise<AIResult<ModelResponse>>; health(modelId): Promise<ModelHealth> }` `BACKEND_HANDOFF.md:71`, `AIResult` `ai/contracts.ts:253`.
2. `openrouter.ts` adapter: `POST <baseUrl>/v1/chat/completions` with `Authorization: Bearer ${process.env[OPENROUTER_API_KEY]}` (only when `runtime==="openrouter"`), `response_format:{type:"json_object"}`, bounded `temperature/max_tokens`, timeout from registry `ai/model-registry.ts:18` (60s vision/code, 45s draft).
3. `local-llm.ts` adapter: same OpenAI path for final LAN (`mlx_lm.server` on M4 `192.168.10.11:8000`, `llama-server` on i7#1/#2 `192.168.10.12:8001`/`13:8002`) `BACKEND_PLANS.md:183` — no key header.
4. Resolve `modelId`→`model` slug (e.g. `qwen/qwen2.5-vl-3b-instruct`) per table `BACKEND_PLANS.md:183`.
**Done:** `gateway.test.ts`: each `ModelId` resolves to correct `baseUrl/model`; disabled/unknown rejected; key only from env.

### 4.2 Normalizer & error mapping
**Owner:** Supreet | **Depends:** 4.1
**Do:** `backend/src/main/gateway/normalizer.ts` strips OpenAI envelope, strips markdown fences or → `invalid_model_response`, records `finish_reason` diagnostic only, truncated→`empty_model_response`, caps response size, preserves `requestId`/`runId` on all paths `BACKEND_HANDOFF.md:108`, maps provider errors → `AIErrorCode` `ai/contracts.ts:218` (`model_timeout`, `model_rejected_request`, etc.), never logs full prompt/confidential doc `BACKEND_HANDOFF.md:89`.
**Done:** Fenced JSON parsed; truncated/timeout/provider 4xx mapped to stable codes; `requestId/runId` preserved on failure.

---

## Phase 5 — Runtime validators (Zod, strict) — `BACKEND_PLANS.md:314`

### 5.1 Common + vision validators
**Owner:** Supreet | **Depends:** 4.2
**Do:** `backend/src/main/validators/vision.ts` validates `VisionResult` `ai/contracts.ts:143`: `sourceText` bounded, `findingId` unique, `pageReferenceIds` → existing `PageReference` `ai/contracts.ts:128`, `page` positive int, `confidence` enum `ai/contracts.ts:126`, exactly 3 demo findings `docs/demo-requirements.md:80`, no handwriting claim `BACKEND_HANDOFF.md:143`. Also common fields `requestId===request.requestId`, `runId` active, `modelId` matches, `completedAt` ISO `BACKEND_HANDOFF.md:125`.
**Done:** Malformed vision / unknown page-ref → `invalid_model_response` / `ValidationFailure` `ai/contracts.ts:241` and run fails before next step `BACKEND_HANDOFF.md:170`.

### 5.2 Draft validator
**Owner:** Supreet | **Depends:** 5.1
**Do:** `backend/src/main/validators/draft.ts` validates `DraftResult` `ai/contracts.ts:185`: 4 sections present+unique `equipment-header|findings-summary|recommendation|grounding-references` `ai/contracts.ts:168`, bodies bounded, `Citation` `ai/contracts.ts:163` stable `documentId/sectionId`, membership vs `retrievedChunks` `ai/contracts.md:48`, `missingInformation` explicit, contains `[SOP-114 §3.2]` `BACKEND_HANDOFF.md:158`.
**Done:** Missing section / unsupported citation / missing `SOP-114 §3.2` → `unsupported_citation` / `missing_required_content`; DOCX not created.

### 5.3 Code validator
**Owner:** Supreet | **Depends:** 5.1
**Do:** `backend/src/main/validators/code.ts` validates `CodeDraftResult` `ai/contracts.ts:195`: `filename==="task.py"` `ai/contracts.ts:196`, `source` < cap, `allowedLanguage==="python"` `ai/contracts.ts:83`, no shell/subprocess/network client strings, imports vs backend allowlist (model `allowedImports` advisory `BACKEND_HANDOFF.md:165`), `inputFiles`/`outputFiles` logical names not paths.
**Done:** Shell/network in source → `unsafe_generated_code`; oversized source → `invalid_model_response`.

---

## Phase 6 — Persistence & audit — `BACKEND_PLANS.md:339`

### 6.1 SQLite schema & `db.ts`
**Owner:** Supreet | **Depends:** 2.1
**Do:**
1. `backend/src/main/persistence/schema.sql` + `db.ts` (better-sqlite3): tables `runs(id, createdAt, completedAt, state, userTextSummary)`, `transitions(runId, from, to, at)`, `routing(runId, requestId, taskType, modelId, reason, at)`, `tool_calls(runId, tool, inputSummary, boundedResult)`, `confirmations(actionId, runId, kind, prompt, createdAt, expiresAt, outcome, decidedAt)`, `artifacts(artifactId, runId, kind, filename, relativePath, sizeBytes)`, `errors(runId, code, message, retryable)`, per `docs/architecture/components-and-contracts.md:137` / `BACKEND_HANDOFF.md:469`.
2. Do NOT store keys, abs paths, full confidential docs, unbounded prompts `BACKEND_HANDOFF.md:481`.
**Done:** Migrations run on launch; `getRunHistory` returns bounded `RunSummary[]`.

### 6.2 Audit writer
**Owner:** Supreet | **Depends:** 6.1
**Do:** `backend/src/main/persistence/audit.ts` logs every state transition, routing decision, `requestId`/`ModelId`, tool call/bounded result, confirmation outcome, citation refs, `PythonExecutionResult` (`exitCode`, `timedOut`, `durationMs`, capped `stdout/stderr`) `ai/contracts.ts:204`.
**Done:** Re-opening app shows prior runs with artifacts; `data/runs/<runId>/logs/` capped logs match DB.

---

## Phase 7 — Run state machine & event bus — `BACKEND_PLANS.md:271`

### 7.1 State machine
**Owner:** Supreet | **Depends:** 6.1
**Do:** `backend/src/main/run/state-machine.ts` implements `RunState` `BACKEND_HANDOFF.md:251` transitions `docs/architecture/components-and-contracts.md:8` (`created→classifying→planning→acting⇆awaiting_confirmation→completed`, `→failed` on validation/timeout/iteration>8, `→cancelled` anytime). Persist transitions; enforce `cancelled` cannot later emit artifact `BACKEND_HANDOFF.md:263`.
**Done:** Illegal transition throws + logs; max 8 iterations enforced; `failed` never reported as `completed`.

### 7.2 Event emitter (`RunEvent`)
**Owner:** Supreet | **Depends:** 7.1
**Do:** Typed `backend/src/shared/events.ts` union from `BACKEND_PLANS.md:142` (`run_state`, `routing`, `plan_step`, `tool_call`, `tool_result`, `confirmation_required`, `artifact_ready`, `error`). All emitted via `win.webContents.send("workbench:runEvent", e)` and re-exposed in preload `onRunEvent` `BACKEND_PLANS.md:372`; every event includes `runId` `BACKEND_HANDOFF.md:459`.
**Done:** Mock renderer receives ordered events; no API keys/abs paths in payloads.

---

## Phase 8 — Deterministic router — `BACKEND_PLANS.md:284`

**Owner:** Supreet | **Depends:** 7.2
**Do:** `backend/src/main/router/deterministic-router.ts` per `docs/architecture/components-and-contracts.md:77`:
- image/PDF → `vision-qwen25vl` reason `scanned report` `docs/demo-requirements.md:102`
- text matching `csv|calculation|script|code|execution|data transformation` → `code-qwen25coder` reason `CSV/code intent`
- else → `draft-qwen3`
- After Flow A OCR+retrieval auto-switch vision→draft reason `compose approval note`
- Model never selects endpoint; router emits `routing` event `docs/architecture/components-and-contracts.md:126`.
**Done:** Unit tests for each branch; Flow A emits 2 routing events, Flow B 1 routing event visible in UI badge `PRODUCT.md:22`.

---

## Phase 9 — Tools: `read_file`, `ocr_extract`, `search_knowledge` — `BACKEND_PLANS.md:228`

### 9.1 `read_file`
**Owner:** Supreet | **Depends:** 2.1, 7.1
**Do:** `backend/src/main/tools/read_file.ts` `BACKEND_HANDOFF.md:306`: resolve token, enforce run boundary, inspect CSV → return bounded `InputFileReference` `ai/contracts.ts:37` (`columns`, `rowCount` 240 for demo `docs/demo-requirements.md:19`), reject unsupported/oversized.
**Done:** Flow B CSV metadata shown; absolute path from renderer rejected.

### 9.2 `ocr_extract`
**Owner:** Supreet | **Depends:** 4.2, 5.1
**Do:** `backend/src/main/tools/ocr_extract.ts` `BACKEND_HANDOFF.md:318`: build `VisionModelRequest` `ai/contracts.ts:59` (`inputMode:"typed-scan"`), `gateway.execute()`, validate `VisionResult`, confirm page-ref integrity, emit bounded transcript summary, persist full validated result to `intermediate/`.
**Done:** Produces fixed 3 findings + page refs `docs/demo-requirements.md:80`; malformed vision rejected before `search_knowledge`.

### 9.3 `search_knowledge`
**Owner:** Supreet | **Depends:** 9.2
**Do:** `backend/src/main/tools/search_knowledge.ts` `BACKEND_HANDOFF.md:326`: query local Chroma only, `topK≤5`, return `RetrievedKnowledgeChunk[]` `ai/contracts.ts:156` with stable `documentId/sectionId`/`excerpt`, structured `no_knowledge_match` when empty, assert `SOP-114 §3.2` + `TPL-012` in top 5 `docs/demo-requirements.md:90`. Never let drafting model invent retrieval `BACKEND_HANDOFF.md:326`.
**Done:** Demo retrieval returns expected chunks; absent retrieval → `no_knowledge_match` and draft not called.

---

## Phase 10 — Flow A orchestrator + `draft_note` + `generate_docx` — `BACKEND_PLANS.md:296`

### 10.1 `draft_note`
**Owner:** Supreet | **Depends:** 5.2, 9.3
**Do:** `backend/src/main/tools/draft_note.ts` `BACKEND_HANDOFF.md:338`: build `DraftModelRequest` `ai/contracts.ts:67` from validated findings + chunks, `gateway.execute()`, validate `DraftResult`, check citation membership before DOCX `BACKEND_HANDOFF.md:343`.
**Done:** Draft cites `[SOP-114 §3.2]` `docs/demo-requirements.md:90`; unsupported citation → fails before generation.

### 10.2 `generate_docx` + PDF preview
**Owner:** Supreet | **Depends:** 10.1
**Do:** `backend/src/main/tools/generate_docx.ts` `BACKEND_HANDOFF.md:348`: require active `PendingAction` `avail`, accept only validated `title/sections/body/citations`, write `approval-note-E201.docx` to `data/runs/<runId>/output/`, derive PDF via LibreOffice locally, refuse fake preview if conversion fails `docs/architecture/flows-and-data.md:13`, return `ArtifactRef`s.
**Done:** Artifact pane shows DOCX + PDF only post-approval; missing citation blocks generation.

### 10.3 `flow-a.ts` sequence
**Owner:** Supreet | **Depends:** 9.2, 9.3, 10.1, 10.2, 8
**Do:** `backend/src/main/orchestrator/flow-a.ts` per `BACKEND_HANDOFF.md:543` + `docs/architecture/flows-and-data.md:16`: `classifying` → `routing:vision/scanned report` → `ocr_extract` → `search_knowledge` → `routing:draft/compose approval note` → `draft_note` → `confirmation_required:Generate the approval-note DOCX?` → stop until approve/reject/expiry `BACKEND_HANDOFF.md:427`. On approve → `generate_docx`+PDF → `artifact_ready` → `completed` only after both succeed. Note contains E-201 header, 3 findings, conditional clearance pending retubing, grounding refs `SOP-114 §3.2` `docs/demo-requirements.md:96`.
**Done:** End-to-end Flow A completes from real file-drop within 3 min `docs/demo-requirements.md:49`; reject/expired confirmation creates no artifact `BACKEND_HANDOFF.md:601`.

---

## Phase 11 — Tools: `draft_code` + `execute_python` & Flow B drafting — `BACKEND_PLANS.md:228`

### 11.1 `draft_code`
**Owner:** Supreet | **Depends:** 5.3, 9.1
**Do:** `backend/src/main/tools/draft_code.ts` `BACKEND_HANDOFF.md:359`: build `CodeModelRequest` `ai/contracts.ts:77` from `task` + `InputFileReference` + `executionRules`, `gateway.execute()`, validate `CodeDraftResult` (`task.py` only `ai/contracts.ts:196`, never shell `BACKEND_HANDOFF.md:363`), display source/summary in `tool_result`.
**Done:** Returns `task.py` for `reactor-temperature-log.csv`; unsafe code rejected.

### 11.2 `execute_python` (Bubblewrap)
**Owner:** Supreet | **Depends:** 11.1
**Do:** `backend/src/main/tools/execute_python.ts` `BACKEND_HANDOFF.md:369` + `docs/architecture/deployment-and-sovereignty.md:52`: require active confirmation `Execute the generated Python?` `BACKEND_HANDOFF.md:427`, use fixed `python3` path, mount CSV dir read-only, output dir writable run-scoped, `--unshare-net` (no network), 60 s timeout, cap `stdout/stderr` before persist, capture `PythonExecutionResult` `ai/contracts.ts:204` (`exitCode`, `timedOut`, `durationMs`, `outputFiles`), treat timeout/non-zero as failed verification `BACKEND_HANDOFF.md:381`.
**Done:** `bubblewrap.test` verifies no net, ro input, rw output only; timeout→`model_timeout`/failed verification, never successful calculation.

---

## Phase 12 — Flow B completion + `generate_xlsx` + summarize — `BACKEND_PLANS.md:296`

### 12.1 `generate_xlsx`
**Owner:** Supreet | **Depends:** 11.2
**Do:** `backend/src/main/tools/generate_xlsx.ts` `BACKEND_HANDOFF.md:384`: from validated `PythonExecutionResult.outputFiles` rows (7 rows: 5 high, 2 low `docs/demo-requirements.md:110`), require second confirmation `BACKEND_HANDOFF.md:388`, write `out-of-range-summary.xlsx` to `output/`, return `ArtifactRef`, reject rows not in validated output `BACKEND_HANDOFF.md:392`.
**Done:** XLSX contains 7 flagged rows + summary count `docs/demo-requirements.md:122`; second approval required; no XLSX on invalid rows.

### 12.2 `flow-b.ts` sequence + summarize phase
**Owner:** Supreet | **Depends:** 9.1, 11.1, 11.2, 12.1, 8
**Do:** `backend/src/main/orchestrator/flow-b.ts` per `BACKEND_HANDOFF.md:573` + `BACKEND_HANDOFF.md:179` + `docs/architecture/flows-and-data.md:57`: `routing:code/CSV/code intent` → `read_file` (240 rows) → `draft_code` → `confirmation_required:execute_python` → Bubblewrap → verify `exitCode===0` + `OUT_OF_RANGE 7/240 (high=5, low=2)` in stdout `docs/demo-requirements.md:122` → propose `generate_xlsx` → second confirmation → create XLSX → call final `CodeSummarizeRequest` `BACKEND_HANDOFF.md:189` with actual `execution` (exitCode, timedOut, capped stdout/stderr, outputFiles, original task, expectedResult) → treat timeout/non-zero as failed verification → `completed` only if verified summary consistent `BACKEND_HANDOFF.md:590`. Orchestrator enforces 8-step cap `BACKEND_HANDOFF.md:266`.
**Done:** Fixed CSV completes <2.5 min `docs/demo-requirements.md:77`; stdout verified; XLSX only post-approvals; summarize uses actual execution not model prediction.

---

## Phase 13 — Confirmation, cancellation & expiry — `BACKEND_PLANS.md:395` / `BACKEND_HANDOFF.md:586`

**Owner:** Supreet | **Depends:** 7.1, 10.2, 11.2, 12.1
**Do:**
1. `backend/src/main/confirmation/confirmation-store.ts` implements `PendingAction` `BACKEND_HANDOFF.md:399` + `ConfirmActionInput` `BACKEND_HANDOFF.md:408`: 5-min expiry, exact `runId+actionId` match, replay of resolved → reject, approval checked again immediately before `generate_docx`/`execute_python`/`generate_xlsx`.
2. `handleCancelRun` sets `cancelled`, invalidates pending actions, checked pre-model/tool `BACKEND_HANDOFF.md:267`.
3. Stream `confirmation_required` / `error` with codes `user rejection`, `confirmation expiry`, `run cancellation` `BACKEND_HANDOFF.md:498`.
**Done:** Tests: rejecting DOCX → no file, expired → no artifact, rejecting Python → no exec, rejecting XLSX → no spreadsheet, cancelled→pendings invalid, replay→rejected `BACKEND_HANDOFF.md:601` + `confirmation.test.ts`.

---

## Phase 14 — Sovereignty & health UI wiring — `BACKEND_PLANS.md:343`

**Owner:** Supreet (with Ayush on renderer) | **Depends:** 3.2, 7.2
**Do:**
1. `backend/src/main/sovereignty/monitor-bridge.ts` exposes independent monitor state (not fabricated `docs/architecture/deployment-and-sovereignty.md:34`) + `externalRequestCount` from gateway logs.
2. Wire `sovereignty:monitorState` push to renderer sovereignty panel: 5-host LAN allowlist `PRODUCT.md:92`, `monitor-active`, `externalRequestCount`. Dev shows true OpenRouter count; final LAN shows 0 `BACKEND_HANDOFF.md:539`.
3. Never create arbitrary network clients from model output `BACKEND_HANDOFF.md:523`; embedding remains LAN-only `ai/model-registry.ts:58`.
**Done:** Panel visible throughout both flows; final config + monitor proof shows 0 external + one blocked egress `docs/demo-requirements.md:149`.

---

## Phase 15 — Testing, rehearsal & packaging — `BACKEND_PLANS.md:399` / `BACKEND_HANDOFF.md:661`

### 15.1 Backend test suites (`backend/tests/`)
**Owner:** Supreet | **Depends:** all above
**Do:** Implement `gateway.test.ts` (3.1–4.2), `validators.test.ts` (5.1–5.3), `filesystem.test.ts` (2.1), `confirmation.test.ts` (Phase 13), `flows.test.ts` (10.3, 12.2) per matrix `BACKEND_HANDOFF.md:596` + `BACKEND_PLANS.md:399`. All `vitest` green.
**Done:** Malformed vision, unknown page-ref, missing draft section, unsupported citation, shell-in-code, oversized source, abs/`..`/cross-run, confirmation replay all covered.

### 15.2 Final LAN switch & rehearsal
**Owner:** Supreet (with Sid on models/corpus, Ayush on UI) | **Depends:** 15.1
**Do:** Per `docs/architecture/deployment-and-sovereignty.md:18` + `TASKS.md:566` (11a):
1. Remove OpenRouter entries, point `config/models.json` to LAN (`mlx_lm.server` M4, `llama-server` i7#1/#2), verify `/v1/models` + fixture request from orchestrator host.
2. Re-run health checks, re-freeze prompts against `Qwen2.5-VL`/`Qwen3`/`Qwen2.5-Coder` with Sid (tasks 5b/6b/8a in root `TASKS.md:257`).
3. Disconnect external networking, retain private LAN, run Flow A + Flow B end-to-end via real file-drop; confirm 0 external egress + blocked-egress proof `docs/architecture/deployment-and-sovereignty.md:34`.
**Done:** `BACKEND_HANDOFF.md:680` Definition of Done + `PRODUCT.md:94` + `docs/demo-requirements.md:134`: token start, normalized 3-model gateway, validated results, cited DOCX/PDF post-approval, verified 7/240 + XLSX post-approvals, streamed+persisted events, safe failure paths, 0 external requests, no model escapes run dir / picks shell / bypasses confirmation / selects endpoint. `TASKS.md:620` final checklist passes.

---

## Dependencies summary (Gantt-ready)

```
0.1 → 0.2 → 1.1 → 1.2 → 2.1 → 2.2 ─┐
0.1 → 3.1 → 3.2 ─────────────────┤
              3.1 → 4.1 → 4.2 → 5.1 → 5.2 → 5.3 ─┐
              2.1 → 6.1 → 6.2 → 7.1 → 7.2 → 8 ─┤→ 9.1 → 9.2 → 9.3 →10.1→10.2→10.3
              7.1 →13 ←── 10.2,11.2,12.1 ──────┤→11.1→11.2→12.1→12.2→13→14→15.1→15.2
```

## Definition of backend completion

Per `BACKEND_PLANS.md:428` / `BACKEND_HANDOFF.md:680`: renderer can start run via token, gateway routes 3 models normalized, every model result validated pre-use, Flow A cited DOCX/PDF after approval, Flow B verified Python + XLSX after approvals, all routing/tools/confirmations/artifacts/errors streamed + persisted, cancellation/rejection/expiry/timeout/malformed/unavailable safe, final local config produces 0 external requests, no model output escapes run directory / chooses shell / bypasses confirmation / selects endpoint.
