# 00 — Verified Architecture Audit: Sovereign Workbench

Source of truth: current source code in `/backend`, `/electron`, `/frontend`, `/ai`, `/config` (inspected Oct 2026).
Docs, PPT claims, and marketing copy were treated as unverified until confirmed in code.
`PPT.md` itself already flags several corrections; those flags were independently re-verified below.

## Verified runtime sequence (V2 default path, `WORKBENCH_AGENT_V2 != "false"`)

```
User action (React composer + optional files)
  -> window.workbenchBridge.startRun (preload invoke, zod-validated)
  -> RunManager.start (createRun + data/runs/<runId>/{input,intermediate,output,logs}, stash temperature/mode/model hint)
  -> resolveModelSelection + semantic intent -> versioned RunContract persisted (SQLite run_contracts)
  -> buildExecutionEnvelope + composeTools/constrainToolsToIntent (capability-gated tool surface)
  -> AgentLoop.run (maxTurns 100): gateway.chatWithTools (native tools, tool_choice auto)
       -> upfront + per-turn plan/mutation confirmation gate (operator approve/reject)
       -> ToolDispatcher.dispatchConcurrent (read-only parallel, mutations serialised)
       -> context compaction, loop detection, completion evaluation
  -> verifyArtifactFile -> persistArtifact (SQLite artifacts + output/) -> run_state completed/partial/failed/cancelled/limit_exceeded
  -> UI renders transcript, ArtifactCard, error banner; diagnostics via getRunLogs/getRunLogFile
```

Key entry files: `electron/main.ts:171-194` (`initBackend`), `backend/src/main/index.ts:80-127`,
`frontend/src/App.tsx:678-799` (send flow), `backend/src/main/run/manager.ts:~399-557` (`start`) and `~925` (`execute`),
`backend/src/main/agent/agent-loop.ts` (`AgentLoop.run`), `backend/src/main/gateway/model-gateway.ts:1479ff` (`chatWithTools`).

## 1. IMPLEMENTED (directly substantiated)

- **Electron desktop shell.** `electron/main.ts:99-151` (`BrowserWindow`, preload-only renderer, `setWindowOpenHandler` deny + `shell.openExternal`),
  `electron/preload.ts:1-129` (narrow `workbench` bridge, no wildcard ipcRenderer), dev Vite spawn + `waitForFrontend` (`main.ts:60-92,345-355`),
  fail-closed backend init (`main.ts:336-343`). Window-control channels are `send`-based without validation (`main.ts:359-374).
- **Validated IPC boundary.** Channel constants `backend/src/main/ipc/channels.ts`, zod schemas `backend/src/main/ipc/validators.ts:1-175`
  enforced in `backend/src/main/ipc/handlers.ts:109-170`. Run/workspace/chat/settings all `.strict()`. Direct `electron/main.ts:202-335`
  handlers add UUID allowlisting, 1 MB log caps, run-root containment for `getRunLogs/getRunLogFile/open/save/copyArtifact`.
- **V2 unified agent loop.** `RunManager.execute` -> `AgentLoop.run({maxTurns:100})` (`backend/src/main/agent/agent-loop.ts`).
  Native `tools` + `tool_choice:"auto"` via `ModelGateway.chatWithTools` (`model-gateway.ts:1479-1569`), streaming chunks,
  `finishReason==length` -> `partial`, loop detection (repeat / A-B-A over last 8 calls), ≤3 completion/validation nudges,
  `evaluateRunContractCompletion` terminal accounting (`backend/src/main/run/contract.ts`).
- **RunContract + envelope + compositor.** `run/contract.ts` (`normalizeRunContract`, zod `schemaVersion:1`, `persistRunContract` 64 KB insert-once
  into SQLite `run_contracts`); `run/envelope.ts` (`CHAT` vs `AGENT` capabilities); `router/tool-compositor.ts` (`composeTools`,
  `constrainToolsToIntent`, single-model pruning of `generate_code/generate_text`); `router/contextual-router.ts` (gated LLM semantic intent,
  60 s deadline, 1 JSON-repair retry, `validateAndNormalizeIntent`).
- **Local loopback inference, OpenAI-compatible.** Single transport: `POST {baseUrl}/chat/completions`, `GET {baseUrl}/models` health
  (`model-gateway.ts:1027-1189,1426-1461`). Shipped `config/models.json`: 3 roles, all `runtime:"ollama"`,
  all `baseUrl http://127.0.0.1:1234/v1`. `runtime` is a label only — no `OllamaClient/MlxClient/VllmClient` classes exist.
  `isLocal` regex only tunes temperature/timeout/format (`model-gateway.ts:918,1509-1518`).
- **Workspace tools + PathGuard (app-level).** `harness/tools/*` (`list_dir` depth 4 + ignore list + 5 s cache; `read_file` 200 KB hard reject;
  `search` ripgrep-or-grep 50 hits, 10 s timeout; `write_file` atomic tmp+rename; `delete_file` refuses root; `run_command` cwd-locked).
  `harness/path-guard.ts:resolveSafe` (reject NUL/absolute/`.harness_backups`, realpath containment, missing-path ancestor walk).
  `MutationPolicyGuard` (`harness/policy-guard.ts`): protected paths, target restrictions, per-op `grantScope`, `withMutationLock` serialisation.
- **Python execution with bounded opportunistic isolation.** `tools/python.ts` (stage inputs basename-only into `output/`, 60 s timeout,
  stdout/stderr sliced to 8000 chars, `maxBuffer 16 KB`): Linux `bwrap --die-with-parent --unshare-net` if present;
  macOS `sandbox-exec` only if `WORKBENCH_USE_MAC_SANDBOX=1`, else direct spawn with locked cwd/env. Same pattern in
  `harness/tools/run-command.ts:84-192` (denylist `rm -rf/sudo/curl|wget|ssh|/dev/tcp/...`, fail-closed `SAFE_UNCONTAINED_BINARIES`
  allowlist when uncontained). Without bwrap/sandbox-exec there is **no OS network/filesystem isolation** — only cwd lock + denylist.
- **Operator confirmation gates.** `confirmation/store.ts` (`createConfirmation`, 5-min expiry, SQLite `confirmations`,
  kinds `plan_approval/generate_docx/generate_xlsx/execute_python`); `manager.ts:~3531 awaitConfirmation` /
  `~558 confirm` with `continuations` map; AgentLoop upfront plan gate + per-turn unauthorised-mutation gate
  (`agent-loop.ts` upfront block and `~1538` auth check; deny -> `cancelled`). Frontend `ConfirmationModal.tsx` + `App.tsx:644-668`
  (approve/reject/cancel wiring, Esc=reject).
- **Artifact verification + persistence.** `tools/artifacts.ts` (`verifyArtifactFile`: exists/inside-run/non-empty/ext-match/parser-open;
  staging `intermediate/staging-<uuid>-<name>` -> promote to `output/`); `run/filesystem.ts` (`data/runs/<runId>/{input,intermediate,output,logs}`);
  P1 `run/result-store.ts` (immutable `intermediate/results/<uuid>.json|txt`, 64 MB cap, SHA-256, run isolation) +
  `tools/result-retrieval.ts` (`retrieve_result`, slices ≤3000 chars, observation ≤3800 chars).
- **SQLite persistence (better-sqlite3, WAL).** `persistence/db.ts` (`journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`),
  `persistence/schema.sql` (`SCHEMA_VERSION=2`, 18 tables incl. `runs/run_transitions/routing_decisions/tool_calls/artifacts/confirmations/run_contracts/intermediate_results`).
  `run/store.ts` (`createRun/transition/recordRouting/recordError`; terminal states `completed/partial/failed/cancelled/limit_exceeded`).
- **Cancellation + failure surfacing.** `manager.ts:589 cancel` (revoke scopes, `cancelPending`, `transition(cancelled)`),
  `AgentLoop` + `ToolDispatcher` cancellation checks, `classifyToolError` taxonomy
  (`permission_denied/file_not_found/invalid_arguments/timeout/validation_failure/sandbox_failure/gateway_failure/...`),
  `error` events + `App.tsx` error banner + `AgentExecutionTimeline`/`RunTranscript` states, `getRunLogs/getRunLogFile` diagnostics.
- **Local RAG substrate (conditional).** `ai/rag/*` + `backend/src/main/rag/rag-service.ts`: SQLite FTS5 (`chunks_fts`, porter/unicode61) +
  Vectra `LocalIndex`, `MAX_CHUNK_TOKENS=350`, OpenAI-compatible embeddings (`/embeddings`, default `127.0.0.1:11434 nomic-embed-text`,
  offline FTS-only fallback), hybrid RRF retrieval (`retrieval.ts`). Gated: `retrieve_knowledge` only composed when KB non-empty
  (`tool-compositor.ts:139-141`, `manager.ts:1086-1098`); empty KB -> tool hidden, provider returns `[]`.

## 2. PARTIALLY IMPLEMENTED (present but restricted / not main-path)

- **OS sandbox isolation.** Linux-only `bwrap --unshare-net` (`run-command.ts:152-192`, `python.ts:157-173`); macOS opt-in only;
  otherwise direct execution. `PPT.md:136` already flags this: state "Linux-namespaced isolation", never universal sandboxing.
- **Direct-UI workspace mutation bypasses the policy guard.** `handlers.ts:162-169` calls `harness.executeTool` with `runId=undefined`;
  `MutationPolicyGuard` explicit-scope enforcement only applies when a runId is supplied (agent loop). UI-invoked `writeFile/runCommand`
  skips plan approval. Chat-mode tool prohibition (`write/delete/run` blocked in chat envelope) still applies at dispatch.
- **Renderer absolute-path exposure.** `WorkspaceInfo.root` (absolute) and `pickFolder` result reach the renderer
  (`harness-manager.ts:62-77`, `main.ts:319-335`); only artifact/log paths stay backend-resolved. "Never exposes absolute paths" holds for
  attachments/artifacts, not workspace roots.
- **Bridge type drift.** `preload.ts` vs `bridge.d.ts` vs `validators.ts` disagree on `startRun` extras
  (`preferredRoute/selectedModel/mode`) and `copyArtifact` shape (`kind` vs `mode`, missing `content`). Runtime passes input through verbatim
  so execution works, but the "fully typed bridge" claim is overstated. Missing channels in `channels.ts`
  (`getRunLogs/getRunLogFile/copyArtifact/pickFolder`) are registered as string literals in `main.ts`.
- **Legacy branches retained.** `manager.ts` legacy `executeStandaloneFileCreation/executeWorkspaceTask/executeVisionTask/executeChatTask`,
  `router/driver-router.ts:pickDriverModel`, `router/deterministic-router.ts`, `router/intent-classifier.ts`,
  `router/planner.ts:generatePlan` are unused in the V2 path (strangler-verification only). Do not diagram them as active.
- **Grounding providers.** `grounding/provider.ts` is a no-op seam; `rag-grounding-provider.ts` returns `[]` when KB empty/uninitialised;
  `sop114-engine.ts` / `spec-compliance.ts` are deterministic/RAG-first helpers invoked through tools, not an always-on verification layer.

## 3. OPTIONAL / CONFIGURABLE (supported, not required)

- **Three-role model routing.** `draft-qwen3 / code-qwen25coder / vision-qwen25vl` are registry roles, and current `config/models.json`
  points all three at the **same** `qwen/qwen3.5-9b` endpoint. Single-model mode (`model-selection.ts:161ff`, `isSingleModel`)
  strips delegation tools and runs everything through one endpoint. Multi-model is an extension: diagram with dashed lines.
- **Alternative runtimes/hosts.** Registry accepts any valid URL + optional `apiKeyEnv` bearer (`registry.ts:7,25ff`); `isLocal=false`
  only increments `externalRequestCount` and adjusts timeouts. LAN `mlx-lm`/`llama-server` work the same OpenAI-compatible path.
  Remote inference is technically possible; loopback is the shipped default, not a code-enforced restriction.
- **Embedding model choice.** `rag-service.ts:22` default loopback embedding endpoint, overridable via `settings.embedding_config`
  or `configured_models[role=embedding]`.
- **Strict sandbox env flags.** `WORKBENCH_STRICT_SANDBOX=1` (deny uncontained shell entirely), `WORKBENCH_USE_MAC_SANDBOX=1` (opt into sandbox-exec).

## 4. NOT VERIFIED (claimed elsewhere, no implementation found)

- **ChromaDB.** Zero `chromadb` dependency (`package.json:30-43` lists `vectra`, no chroma). `ai/rag/db.ts` imports Vectra `LocalIndex`.
  `AGENTS.md:50` and a `specialist-tools.ts` comment still say "ChromaDB" — stale. Say "embedded local vector index (Vectra) + SQLite FTS5".
- **OS-enforced zero-egress / firewall / packet capture.** No iptables, OS firewall rule, packet sniffer, or egress telemetry exists in
  `backend/`, `electron/`, or `frontend/` (only matches are UI strings: `TitleBar.tsx:15`, `ConfirmationModal.tsx:309`,
  `OnboardingPage.tsx:617`, and `model-gateway.ts:1016` non-local counter). Air-gap is a **deployment condition** (loopback defaults,
  no mandatory cloud dependency), not an application-enforced network block. `PRODUCT.md:70` itself notes a firewall would need pairing
  with a real OS-level rule.
- **Cryptographic run logs / namespaces as audit primitives.** No signing, hash-chained log, or namespace-based audit trail in
  `run/`, `persistence/`, or `logger.ts` (console-only logging). `run_transitions` + `tool_calls` + `model_calls` tables are ordinary SQLite rows.
- **Mandatory three-model / multi-GPU / distributed inference.** Contradicted by single-endpoint fallback
  (`model-gateway.ts:718ff`, `model-selection.ts:161ff`) and the shipped config (one shared 9B model). Normal operation is single-workstation,
  single-endpoint capable.
- **`citations` table / 8-tool CHECK / `DATABASE.md` §2 as written.** `schema.sql` has no `citations` table and its `tool_calls` CHECK lists 5
  legacy tool names, not 8. Trust `schema.sql` + `db.ts` migrations over `DATABASE.md`.
- **BackendAttachment 25 MB vs composer 10 MB agreement.** `lib/workbench.ts:103` (25 MB) vs `App.tsx:23` (10 MB composer cap);
  backend `registerAttachment` schema sets no max size. Minor, but do not quote a single limit.

## Files that matter most (for diagram claims)

- Shell/IPC: `electron/main.ts`, `electron/preload.ts`, `backend/src/main/index.ts`, `backend/src/main/ipc/channels.ts`,
  `backend/src/main/ipc/validators.ts`, `backend/src/main/ipc/handlers.ts`, `frontend/src/bridge.d.ts`, `frontend/src/lib/workbench.ts`.
- Orchestration: `backend/src/main/run/manager.ts`, `backend/src/main/agent/agent-loop.ts`,
  `backend/src/main/agent/tool-dispatcher.ts`, `backend/src/main/agent/context-manager.ts`,
  `backend/src/main/run/contract.ts`, `backend/src/main/run/envelope.ts`, `backend/src/main/router/tool-compositor.ts`,
  `backend/src/main/router/contextual-router.ts`, `backend/src/main/confirmation/store.ts`, `backend/src/shared/contracts.ts`.
- Inference: `backend/src/main/gateway/model-gateway.ts`, `backend/src/main/gateway/registry.ts`,
  `backend/src/main/gateway/model-selection.ts`, `config/models.json`.
- Tools: `backend/src/main/harness/path-guard.ts`, `backend/src/main/harness/harness-manager.ts`,
  `backend/src/main/harness/tools/*`, `backend/src/main/tools/workspace-tools.ts`, `backend/src/main/tools/specialist-tools.ts`,
  `backend/src/main/tools/python.ts`, `backend/src/main/tools/artifacts.ts`, `backend/src/main/run/result-store.ts`.
- Memory: `backend/src/main/persistence/*`, `backend/src/main/rag/rag-service.ts`, `ai/rag/*`, `backend/src/main/grounding/*`.
- UI: `frontend/src/App.tsx`, `frontend/src/components/ChatArea.tsx`, `frontend/src/components/AgentExecutionTimeline.tsx`,
  `frontend/src/components/ConfirmationModal.tsx`, `frontend/src/components/ArtifactCard.tsx`.
