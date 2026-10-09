# AGENTS.md — Codebase Architecture & Reference

> **Purpose of this file**: This document serves as the single source of truth for the codebase architecture, module responsibilities, file hierarchy, IPC channels, and execution lifecycles of **Local Workbench** (Team: Unpaid_Interns, Team ID: 119100).
> AI coding assistants must read this reference to locate files, understand contracts, and make changes across any directory without needing token-expensive file system searches.

---

## 1. System Overview

**Local Workbench** is a self-hosted, air-gapped, local-first agentic AI desktop application tailored for industrial, PSU, and defence engineering knowledge work. It enables offline document inspection, code modification and repair, engineering drawing review, and local workspace interactions with verifiable model routing, hard execution safety boundaries, and zero external egress.

### High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ELECTRON RENDERER (Vite / React)                │
│  ChatArea │ LeftSidebar │ RightSidebar │ FileTree │ RunWaitingIndicator │
│  AgentExecutionTimeline │ RunTranscript │ ArtifactCard │ ConfirmationModal│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ IPC (window.workbench / window.electronAPI)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        ELECTRON SHELL (electron/main.ts)               │
│  Window Lifecycle │ CSP Security │ Preload Bridge │ Vite Dev Spawner   │
│  Log Inspection   │ Native Dialogs │ Shell Open / Save / Clipboard     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ initBackend(ipcMain, emit, config)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     BACKEND RUNTIME (backend/src/main/)                │
│                                                                        │
│   IPC Handlers ────▶ RunManager ────▶ ContextualRouter / Intent        │
│         │                  │                      │                    │
│         │                  ▼                      ▼                    │
│         │            AgentLoop               ModelGateway              │
│         │                  │                      │                    │
│         │           ┌──────┴──────┐         ┌─────┴──────────┐         │
│         │           ▼             ▼         ▼                ▼         │
│         │     ToolDispatcher  ResultStore  Primary Model   Vision      │
│         │           │         (P1 Storage) (LM Studio/MLX) Fallback    │
│         │     ┌─────┴─────────┐                                        │
│         │     ▼               ▼                                        │
│         │  WorkspaceTools  SpecialistTools                             │
│         │  (PathGuard)     (extract, python, docx/xlsx, RAG)           │
│         │                                                              │
│         ▼                                                              │
│   SQLite Persistence (workbench.db) & Scoped Run Files (data/runs/)    │
│   Local RAG Subsystem (Vectra LocalIndex + SQLite FTS5 in data/rag/)   │
└────────────────────────────────────────────────────────────────────────┘
```

### Core Tech Stack
- **Desktop Shell**: Electron 44 (44.7.0), TypeScript 5.6, esbuild
- **Frontend Renderer**: React 18, Vite 5, Tailwind CSS v4, Lucide icons
- **Backend Orchestrator**: Node.js (22.12+), TypeScript
- **Persistence**: SQLite via `better-sqlite3` with WAL mode (Schema Version 2)
- **Model Gateway**: OpenAI-compatible REST loopback endpoints (LM Studio, `mlx-lm`, `llama-server`, `ollama` for air-gapped deployment; default `http://127.0.0.1:1234/v1` or configured port)
- **Primary Model Architecture**: Single primary text/code model (e.g. `qwen2.5-coder-7b-instruct-mlx` or `qwen/qwen3.5-9b`) with capability-based fallback for vision (`qwen/qwen3-vl-4b`)
- **Local RAG & Vector**: Embedded local vector index (`vectra` `LocalIndex`) + SQLite FTS5 (full-text keyword search with Porter stemmer) with Reciprocal Rank Fusion (RRF), local embedding endpoints (`/v1/embeddings`, e.g. `nomic-embed-text`)
- **Document & Data Processing**: `pdfjs-dist`, `canvas`, `docx`, `exceljs`, `jszip`
- **Testing & Verification**: Vitest 3, custom behavioral and scenario evaluation harnesses (`scripts/behavioral.cjs`, `scripts/certify-v0.cjs`, `tests/acceptance.ts`)

---

## 2. Directory Hierarchy

```
agent/
├── AGENTS.md                      # Codebase architecture and navigation guide (this file)
├── FRAMEWORK.md                   # V0 MVP shipping criteria and acceptance framework
├── README.md                      # Quickstart and reference setup guide
├── VERSION                        # Application version string (0.1.0)
├── LICENSE                        # MIT License
├── package.json                   # Root workspace scripts and dependencies
├── tsconfig.json                  # Root TypeScript configuration
├── vitest.config.ts               # Test configuration
│
├── electron/                      # Privileged desktop shell
│   ├── main.ts                    # Main process lifecycle, BrowserWindow, Vite spawner, IPC handlers
│   ├── preload.ts                 # Secure contextBridge exposing window.workbench & window.electronAPI
│   ├── tsconfig.json              # Electron TypeScript config
│   ├── electron-builder.json5     # Native application packaging configuration
│   └── dist-electron/             # Bundled output (main.cjs, preload.cjs)
│
├── backend/                       # Core orchestration, agent loop, tools, and persistence
│   ├── index.ts                   # Backend barrel re-export
│   ├── tsconfig.json              # Backend TypeScript config
│   ├── DATABASE.md                # Persistence and SQLite schema documentation
│   ├── P1_FOUNDATION.md           # P1 canonical run contracts and result store architecture
│   ├── STREAMING.md               # Model output streaming, progress events, and waiting state
│   ├── src/
│   │   ├── shared/                # Shared contracts and type definitions
│   │   │   ├── contracts.ts       # Canonical data contracts (RunContract, ModelId, RunEvent, ToolName, etc.)
│   │   │   └── task-progress.ts   # Checkpoint stages and task progress helpers
│   │   └── main/                  # Backend implementation
│   │       ├── index.ts           # initBackend() entry point
│   │       ├── logger.ts          # Structured event and audit logger
│   │       ├── agent/             # Unified agent loop execution
│   │       │   ├── agent-loop.ts         # AgentLoop (turn driver, native tool calling, completion evaluation)
│   │       │   ├── tool-dispatcher.ts    # ToolDispatcher (concurrent read / serial mutation dispatch, P1 store)
│   │       │   ├── context-manager.ts    # Sliding-window context compaction, budget enforcement
│   │       │   ├── code-extractor.ts     # Markdown code block / shell command extractors
│   │       │   ├── source-review.ts      # Python / source review checklist validation
│   │       │   └── streaming-filter.ts   # Reasoning tag <think> streaming filter
│   │       ├── ipc/               # IPC registration, channel constants, and validators
│   │       │   ├── channels.ts           # Channel constant definitions (IPC_CHAT, IPC_RUN, IPC_WORKSPACE, etc.)
│   │       │   ├── handlers.ts           # Chat, Run, and Workspace IPC handlers
│   │       │   ├── kb-handlers.ts        # Knowledge Base IPC handlers
│   │       │   ├── onboarding-handlers.ts# First-launch model onboarding IPC handlers
│   │       │   └── validators.ts         # Strict Zod input validators for all IPC requests
│   │       ├── run/               # Run lifecycle, storage, contracts, and filesystem
│   │       │   ├── manager.ts            # RunManager (start, cancel, confirm, resume, execution coordination)
│   │       │   ├── contract.ts           # RunContract normalization, persistence, completion evaluation
│   │       │   ├── envelope.ts           # ExecutionEnvelope builder (CHAT vs AGENT capabilities)
│   │       │   ├── execution-ledger.ts   # Operational state and mutation tracking ledger
│   │       │   ├── result-store.ts       # P1 immutable intermediate result store and SQLite manifests
│   │       │   ├── store.ts              # Run state persistence in SQLite (transitions, errors, routing)
│   │       │   ├── filesystem.ts         # Scoped run directory resolution (data/runs/<runId>/...)
│   │       │   ├── prompts.ts            # Driver system prompt and intent prompts
│   │       │   ├── task-progress.ts      # Runtime task progress tracking
│   │       │   ├── verification.ts       # Deliverable file verification (parsers, digests, checks)
│   │       │   ├── partial-result.ts     # Partial execution summaries
│   │       │   └── images.ts             # PDF/SVG/Image rendering and vision token estimation
│   │       ├── gateway/           # Model communication and inference abstraction
│   │       │   ├── model-gateway.ts      # Gateway client (OpenAI-compatible REST loopback, chatWithTools)
│   │       │   ├── registry.ts           # Model registry loader (config/models.json & DB overrides)
│   │       │   ├── model-selection.ts    # Model selection resolution (single model vs multi-role)
│   │       │   ├── completion-stream.ts  # SSE streaming parser, token & reasoning extraction
│   │       │   ├── normalizer.ts         # Response normalizer and error classifying
│   │       │   ├── structured-data.ts    # JSON schema / structured output parser
│   │       │   └── telemetry.ts          # Inference timing, token counts, reasoning control
│   │       ├── router/            # Intent classification and tool compositing
│   │       │   ├── contextual-router.ts  # Contextual LLM intent classifier with JSON repair
│   │       │   ├── tool-compositor.ts    # Capability-gated tool surface compositor (composeTools)
│   │       │   ├── output-expectation.ts # Output expectations (chatResponse, expectedFiles, mutations)
│   │       │   ├── driver-router.ts      # Lead driver model routing helper
│   │       │   ├── deterministic-router.ts# Rule-based routing fallback
│   │       │   └── planner.ts            # Execution planning utilities
│   │       ├── harness/           # Workspace harness execution and security containment
│   │       │   ├── harness-manager.ts    # WorkspaceManager lifecycle and active workspace tracking
│   │       │   ├── path-guard.ts         # resolveSafe path containment (realpath, symlink & escape reject)
│   │       │   ├── policy-guard.ts       # MutationPolicyGuard (grantScope, protected paths, write locks)
│   │       │   ├── harness-prompt.ts     # Workspace context injection prompt
│   │       │   └── tools/                # Scoped harness tools: list-dir, read-file, search, write-file, delete-file, run-command
│   │       ├── tools/             # Agent tools and specialist implementations
│   │       │   ├── workspace-tools.ts    # Workspace tool wrappers for AgentLoop
│   │       │   ├── specialist-tools.ts   # extract_document, retrieve_knowledge, execute_python, generate_deliverable
│   │       │   ├── result-retrieval.ts   # retrieve_result tool for P1 ResultStore slices
│   │       │   ├── capabilities.ts       # request_capability tool and capability group mappings
│   │       │   ├── python.ts             # Bounded Python execution with opportunistic isolation
│   │       │   ├── python-contract.ts    # Behavioral and return validation runners for Python
│   │       │   ├── artifacts.ts          # Deliverable generation (docx, xlsx) and validation
│   │       │   ├── document-reader.ts    # Text/table extraction from PDF and DOCX
│   │       │   └── types.ts              # AgentTool, ToolExecutionContext, ToolExecutionResult
│   │       ├── rag/               # Local RAG orchestrator
│   │       │   └── rag-service.ts        # RAGService bridge between backend and ai/rag/
│   │       ├── grounding/         # Grounding and compliance verification
│   │       │   ├── rag-grounding-provider.ts # Grounding chunks retriever from RAGService
│   │       │   ├── inspection-evidence.ts    # Evidence extraction from inspection reports
│   │       │   ├── spec-compliance.ts       # Standard specification compliance checks
│   │       │   └── provider.ts               # Grounding provider interface
│   │       ├── persistence/       # SQLite storage
│   │       │   ├── db.ts                 # SQLite connection manager, WAL config, schema migrations
│   │       │   ├── schema.sql            # SQLite DDL (Schema version 2, 18 tables)
│   │       │   ├── chats.ts              # Chat session store
│   │       │   ├── messages.ts           # Message persistence store
│   │       │   ├── settings-store.ts     # Key-value settings store
│   │       │   └── paths.ts              # Database and persistence paths
│   │       ├── confirmation/      # Operator confirmation gate
│   │       │   └── store.ts              # ConfirmationStore (actionId, kind, prompt, expiry, outcomes)
│   │       ├── models/            # Model port abstractions (chat-model, code-model, ports)
│   │       └── validators/        # Zod validators for model outputs
│   └── tests/                     # Backend unit and integration test suites
│
├── frontend/                      # User interface (React 18 + Vite 5 + Tailwind CSS v4)
│   ├── index.html                 # HTML shell
│   ├── vite.config.ts             # Vite configuration
│   ├── tsconfig.json              # Frontend TypeScript config
│   ├── tailwind.config.js         # Tailwind configuration
│   ├── postcss.config.js          # PostCSS configuration
│   └── src/
│       ├── main.tsx               # React entry point
│       ├── App.tsx                # Central state container, layout coordinator, and IPC event listener
│       ├── App.css / index.css    # Global stylesheet and CSS variables
│       ├── bridge.d.ts            # Type declarations for window.workbench and window.electronAPI
│       ├── components/            # UI components
│       │   ├── ChatArea.tsx              # Main message feed, transcript rendering, and artifact chips
│       │   ├── ChatPanel.tsx             # Chat session header, model selector, and health badge
│       │   ├── InputBar.tsx              # Prompt input, attachment dropzone, and send controls
│       │   ├── LeftSidebar.tsx           # Collapsible left panel (chats, files, knowledge base tabs)
│       │   ├── RightSidebar.tsx          # Collapsible right panel (model traces, telemetry, run details)
│       │   ├── FileTree.tsx              # Scoped workspace directory tree browser
│       │   ├── WorkspacePicker.tsx       # Folder selector dialog trigger and current root display
│       │   ├── TitleBar.tsx              # Custom frameless title bar with window controls
│       │   ├── ConfirmationModal.tsx     # Operator approval gate modal (plan, python, docx/xlsx, mutations)
│       │   ├── ArtifactCard.tsx          # Deliverable card (open, save to disk, copy to clipboard)
│       │   ├── AgentExecutionTimeline.tsx# Multi-stage execution timeline and activity view
│       │   ├── RunTranscript.tsx         # Detailed tool execution trace, arguments, and results
│       │   ├── RunWaitingIndicator.tsx   # Live generation skeleton, draft previews, and progress state
│       │   ├── RunTelemetryWidget.tsx    # Token count, duration, and inference telemetry
│       │   ├── ModelTracePanel.tsx       # Full request/response gateway log inspector
│       │   ├── HealthPanel.tsx           # Endpoint connectivity and model availability monitor
│       │   ├── KnowledgeBase.tsx         # Document ingestion, indexing status, and search tester
│       │   ├── RouteBadge.tsx            # Active model and routing intent indicator
│       │   ├── PlusDropup.tsx            # Attachment and modal trigger menu
│       │   ├── sidebar/                  # Sidebar tabs: ChatsPanel, FilesPanel, KnowledgePanel
│       │   ├── modals/                   # Auxiliary modals: UploadModal, CameraModal, VoiceModal
│       │   └── onboarding/               # First-time model configuration: OnboardingPage
│       └── lib/                   # Frontend utilities and bridge wrappers
│           ├── workbench.ts              # Typed wrapper functions around window.workbench IPC
│           ├── models.ts                 # Model definitions and formatting utilities
│           ├── run-progress.ts           # Progress event formatting and tracking helpers
│           ├── time.ts                   # Date/time formatting helpers
│           └── hooks/                    # Custom hooks: useUpload, useCamera, useVoice, useDropdownPosition
│
├── ai/                            # AI contracts, shared prompts, vision/code/draft specs, RAG
│   ├── validation.ts              # AI contract validation utilities
│   ├── shared/                    # Shared types, errors, and service contracts
│   ├── vision/                    # Vision/OCR contracts, prompts, and tests
│   ├── code/                      # Coding contracts, prompts, and mocks
│   ├── draft/                     # Approval note drafting contracts and prompts
│   ├── rag/                       # Local RAG engine implementation
│   │   ├── db.ts                  # RAGDatabase (Vectra LocalIndex + SQLite FTS5 keyword.db)
│   │   ├── ingestion.ts           # Document parsing, chunking, and index insertion
│   │   ├── chunker.ts             # Text chunking with sliding window and token limits
│   │   ├── embedding.ts           # EmbeddingService (local OpenAI-compatible /v1/embeddings)
│   │   ├── retrieval.ts           # RetrievalPipeline (Hybrid Vector + Keyword Reciprocal Rank Fusion)
│   │   ├── types.ts               # DocumentRecord, ChunkRecord, RetrievalResult, EmbeddingConfig
│   │   └── index.ts               # AI RAG barrel re-export
│   ├── tools/                     # Shared AI tool contracts
│   └── mock-responses/            # Fixture responses for offline testing
│
├── config/                        # Runtime configurations
│   ├── models.json                # Active model registry (primary-model + vision-fallback)
│   └── models.v0.example.json     # Reference template for local LM Studio / OpenAI-compatible servers
│
├── data/                          # Runtime persistent data (gitignored)
│   ├── workbench.db               # SQLite database file (WAL mode, Schema version 2)
│   ├── rag/                       # RAG storage: keyword.db (FTS5) and index.json (Vectra vector index)
│   └── runs/                      # Unique UUID directory per execution run
│       └── <runId>/
│           ├── input/             # Uploaded user files and registered attachments
│           ├── intermediate/      # Generated code, raw responses, scratch files
│           │   └── results/       # P1 immutable typed intermediate result payloads (<resultId>.json/.txt)
│           ├── output/            # Final deliverables (report.docx, output.xlsx, modified scripts)
│           └── logs/              # model-gateway.log JSONL, per-request payloads, execution traces
│
├── docs/                          # Architecture diagrams and specifications
│   └── diagrams/                  # Verified architecture audit and flow charts (00_ARCHITECTURE_AUDIT.md, etc.)
│
├── tests/                         # Comprehensive acceptance and behavioral test suite
│   ├── acceptance.ts              # High-level acceptance test runner
│   ├── core.test.ts               # Core system invariants and contracts test
│   ├── metamorphic.ts             # Metamorphic testing suite
│   ├── findings.ts                # Findings verification
│   ├── supervisor.ts              # Execution supervisor
│   ├── runner.ts                  # Test runner
│   ├── recorder.ts                # Test execution recorder
│   ├── benchmark/                 # Latency and throughput benchmarks
│   ├── evaluator/                 # Task completion quality evaluator
│   ├── gremlin/                   # Chaos, fuzzing, and fault-injection probes
│   ├── harness/                   # Behavioral test adapters, mock models, preflight checks
│   ├── helpers/                   # Test helpers (cancellation, fakes, redacting)
│   ├── profiles/                  # Test execution profiles (local, deployed)
│   └── scenarios/                 # Test corpus and evaluation scenarios
│
├── demo/                          # Verification and demonstration fixtures
│   ├── flow_a/                    # Inspection report bundle & SOP requirements
│   ├── flow_b/                    # Sensor logs and vendor log parser script
│   ├── flow_c/                    # Engineering drawing SVG & compliance requirements
│   ├── manifest.json              # Demo fixture manifest
│   ├── build_fixtures.py          # Fixture generator script
│   └── validate_fixtures.py       # Fixture verification script
│
└── scripts/                       # Development, build, and test tooling
    ├── dev.cjs                    # Concurrently spawns Vite dev server and Electron
    ├── build-electron.cjs         # Esbuild bundler for electron main & preload
    ├── preview.cjs                # Runs production Electron build against static frontend
    ├── test.cjs                   # Vitest test runner wrapper (spawns under Electron Node environment)
    ├── behavioral.cjs             # Behavioral test suite runner
    ├── build-behavioral.cjs       # Behavioral test compiler
    ├── certify-v0.cjs             # V0 MVP certification runner
    ├── certify-vision-v0.cjs      # Vision capability certification runner
    ├── benchmark-demo-latency.cjs # Latency benchmark suite
    ├── run-demo-flows.cjs         # End-to-end demonstration flow runner
    ├── test-all-flows.cjs         # Automated test runner across all flows
    ├── test-flow-a.cjs            # Flow A verification script
    ├── test-flow-b.cjs            # Flow B verification script
    ├── test-flow-c.cjs            # Flow C verification script
    └── patch-vectra.cjs           # Post-install patch utility for vectra
```

---

## 3. Subsystem & Module Architecture

### 3.1 Backend Runtime Subsystems (`backend/src/main/`)

The backend coordinates the execution lifecycle, security enforcement, model gateway, tools, and local storage:

1. **`agent/` (Unified Agent Loop)**:
   - **`agent-loop.ts`**: The core iterative execution loop (`AgentLoop.run({ maxTurns: 100 })`). Dispatches conversation turns to the driver model with native `tools` and `tool_choice: "auto"`. Enforces upfront plan approval, per-turn mutation authorization, loop detection (repetition and A-B-A call patterns over the last 8 turns), and terminal completion evaluation against the `RunContract`.
   - **`tool-dispatcher.ts`**: Dispatches tool invocations concurrently for read-only tools (`Promise.all`), while strictly serializing workspace mutations via `MutationPolicyGuard.withMutationLock`. Integrates with `ResultStore` to register full intermediate outputs before tool results are published.
   - **`context-manager.ts`**: Sliding-window context compaction. Summarizes tool outputs older than 2 turns to protect local GPU context memory while strictly retaining stable result IDs and retrieval instructions. Enforces token budgets (`enforceContextBudget`).
   - **`source-review.ts`**: Verifies attached Python scripts and proposed code modifications against behavioral checklists prior to execution.
   - **`streaming-filter.ts`**: Filters provider reasoning blocks and inline `<think>` tags from live text chunks to maintain clean transcript streams.

2. **`run/` (Execution Lifecycle & Storage)**:
   - **`manager.ts`**: `RunManager` controls the state machine for each execution (`created` → `classifying` → `planning` → `acting` → `awaiting_confirmation` → terminal: `completed` / `partial` / `failed` / `cancelled` / `limit_exceeded`). Coordinates run directory creation, contract persistence, execution envelope creation, and confirmation pauses.
   - **`contract.ts`**: Normalizes semantic requests into versioned `RunContract` (v1) records. Persisted insert-once into SQLite `run_contracts`. Serves as the authoritative basis for completion evaluation (`evaluateRunContractCompletion`), without granting execution mutation permissions.
   - **`envelope.ts`**: Builds `ExecutionEnvelope`, establishing the capability boundary (`CHAT` vs `AGENT` execution mode) and gating active capability groups (`source_access`, `document_processing`, `result_retrieval`, `structured_computation`, `artifact_generation`, `workspace_mutation`).
   - **`result-store.ts`**: P1 persistent intermediate result store. Writes immutable typed payloads (`text`, `document`, `table`, `structured`, `execution`) to `data/runs/<runId>/intermediate/results/<uuid>.json|.txt` with SHA-256 digests and SQLite manifests (`intermediate_results` table).
   - **`execution-ledger.ts`**: Tracks compact operational state, authorized operations, disk mutations, and token usage limits.
   - **`verification.ts`**: Runs structural and parser validation on generated deliverables (`verifyArtifactFile`: existence, containment, non-empty, extension match, format parser verification).
   - **`filesystem.ts`**: Manages the scoped data layout: `runRoot(runId)`, `resolveRunPath()`, `absoluteDataPath()`.

3. **`gateway/` (Inference & Model Gateway)**:
   - **`model-gateway.ts`**: Provides OpenAI-compatible REST communication (`POST {baseUrl}/chat/completions`, `GET {baseUrl}/models`). Handles native tool calling (`tools` parameter) and JSON-schema fallback modes, streaming chunk consumption, retry logic, timeout enforcement, and token tracking.
   - **`registry.ts`**: Loads model registry entries from `config/models.json` and overrides stored in SQLite settings (`configured_models`).
   - **`model-selection.ts`**: Resolves model endpoints. Supports single-model mode (where one model handles driver and specialized tasks, stripping delegation tools) and multi-model mode with vision fallback.
   - **`completion-stream.ts`**: Parses Server-Sent Events (SSE) streams, split UTF-8 chunks, reasoning content, tool call fragments, and finish reasons.

4. **`router/` (Contextual Routing & Tool Compositing)**:
   - **`contextual-router.ts`**: Analyzes user prompt and attachments to determine semantic intent, required capabilities, and deliverable expectations. Uses a fast LLM pass with bounded JSON-repair retry.
   - **`tool-compositor.ts`**: Inspects the runtime environment (active workspace mounted? attachments present? knowledge base non-empty?) and envelope permissions to assemble the active tool surface for the agent turn (`composeTools`, `filterToolsForTurn`).
   - **`output-expectation.ts`**: Determines expected output modes and deliverable files.

5. **`harness/` (Workspace Harness & Security)**:
   - **`harness-manager.ts`**: Manages the active workspace directory, registration/deregistration, and state restoration on startup.
   - **`path-guard.ts`**: `resolveSafe(workspaceRoot, requestedPath)` ensures that all workspace file operations strictly stay within the registered workspace root. Canonicalizes real paths, rejects NUL bytes, prevents traversal (`../`), and disallows access to `.harness_backups`.
   - **`policy-guard.ts`**: `MutationPolicyGuard` enforces write/delete target restrictions, requires explicit `grantScope` authorization, creates automatic file backups in `.harness_backups/` before overwriting, and serializes mutations via `withMutationLock`.
   - **`tools/`**: Core workspace tools: `list_dir`, `read_file` (200 KB limit), `search` (ripgrep/grep), `write_file`, `delete_file`, and `run_command` (locked to workspace cwd).

6. **`tools/` (Agent & Specialist Tools)**:
   - **`specialist-tools.ts`**:
     - `extract_document`: Extracts text, tables, and visual evidence from attached PDFs, images, or SVGs via multimodal vision models or document extractors.
     - `retrieve_knowledge`: Performs hybrid vector + keyword search over indexed standard operating procedures and technical documents in the local RAG subsystem.
     - `execute_python`: Sandboxed Python execution with input staging, 60-second timeouts, and stdout/stderr capture (macOS sandbox / Linux bwrap if enabled).
     - `generate_deliverable`: Produces structured output documents (`.docx`, `.xlsx`, `.md`, `.csv`, `.json`, `.txt`) with structural parser verification.
   - **`result-retrieval.ts`**: `retrieve_result` allows the agent to inspect bounded slices of immutable stored results from previous turns.
   - **`capabilities.ts`**: `request_capability` enables dynamic expansion of active capability groups within the execution envelope.
   - **`workspace-tools.ts`**: Adapts workspace harness operations for native agent tool calling.

7. **`rag/` & `grounding/` (Local RAG & Grounding)**:
   - **`rag-service.ts`**: Orchestrates document indexing, chunking, embedding generation, and hybrid search. Interacts with the persistent store in `data/rag/`.
   - **`rag-grounding-provider.ts`**: Injects relevant SOP and standard clauses into the run execution context.

8. **`persistence/` (SQLite Storage)**:
   - **`db.ts`**: Initializes `better-sqlite3` with WAL mode (`journal_mode = WAL`, `synchronous = FULL`, `foreign_keys = ON`). Handles idempotent schema creation and version migrations.
   - **`schema.sql`**: SQLite DDL defining Schema Version 2 across 18 tables: `chats`, `messages`, `attachments`, `message_attachments`, `run_attachments`, `runs`, `run_transitions`, `routing_decisions`, `model_calls`, `tool_calls`, `execution_results`, `confirmations`, `artifacts`, `run_errors`, `settings`, `kv_meta`, `run_contracts`, `run_execution_ledgers`, `run_verification_reports`, and `intermediate_results`.
   - **`chats.ts`**, **`messages.ts`**, **`settings-store.ts`**: Structured query repositories for chats, messages, and settings.

9. **`confirmation/` (Operator Confirmation Gate)**:
   - **`store.ts`**: `ConfirmationStore` manages pending sensitive actions (`plan_approval`, `execute_python`, `generate_docx`, `generate_xlsx`) with 5-minute expirations and user approval tracking.

---

### 3.2 Electron Shell (`electron/`)

- **`electron/main.ts`**:
  - Manages Electron app lifecycle (`app.whenReady()`, `app.on("window-all-closed")`).
  - In development, spawns the Vite development server (`npm run dev:frontend` on port 5173) and waits for readiness before creating `BrowserWindow`.
  - In production, serves built assets from `frontend/dist/`.
  - Configures strict Content Security Policy (CSP) headers, denies arbitrary new window creation (`setWindowOpenHandler` deny), and opens external web links safely via `shell.openExternal`.
  - Invokes `initBackend(ipcMain, emit, config)` to attach backend services to Electron IPC.
  - Registers main-process desktop handlers:
    - `workbench:getRunLogs` & `workbench:getRunLogFile`: Inspects run log JSON files with path containment and 1 MB safety caps.
    - `workbench:openArtifact`: Uses Electron `shell.openPath` with backend run-scope path validation.
    - `workbench:saveArtifact`: Shows native `dialog.showSaveDialog` to save deliverables to user-chosen paths.
    - `workbench:copyArtifact`: Copies artifact text to clipboard or formats native file payloads (macOS pasteboard).
    - `workspace:pickFolder`: Shows native `dialog.showOpenDialog` for workspace directory selection.
    - Window control IPC: `window-minimize`, `window-maximize`, `window-close`.
- **`electron/preload.ts`**:
  - Uses `contextBridge.exposeInMainWorld("workbench", { ... })` and `contextBridge.exposeInMainWorld("electronAPI", { ... })` to expose strictly typed, parameter-validated IPC channels to the renderer without exposing raw Node `require`, `process`, or `fs`.

---

### 3.3 Frontend Renderer (`frontend/`)

Built with React 18, Vite 5, Tailwind CSS v4, and Lucide icons:

- **State & Layout**:
  - **`App.tsx`**: Central orchestrator. Manages active chat session, messages, attachment staging, run state, confirmation modals, workspace binding, and IPC push event subscriptions (`workbench.onRunEvent`, `workbench.onWorkspaceEvent`).
  - **`bridge.d.ts`**: Comprehensive TypeScript definitions for the renderer bridge (`window.workbench`, `window.electronAPI`).
  - **`lib/workbench.ts`**: Typed bridge client providing ergonomic async helper functions (`startRun`, `confirmAction`, `registerWorkspace`, `kbQuery`, etc.).
- **Key UI Components**:
  - **`ChatArea.tsx`**: Renders message history, interactive markdown, tool execution chips, thinking accordions, and downloadable artifact cards.
  - **`InputBar.tsx`**: Text entry with multiline support, attachment pill rendering, drag-and-drop file upload, model selection indicator, and cancel/send actions.
  - **`LeftSidebar.tsx`**: Tabbed sidebar containing `ChatsPanel` (chat history & session management), `FilesPanel` (file tree browser for active workspace), and `KnowledgePanel` (SOP document index & search).
  - **`RightSidebar.tsx`**: Telemetry and inspection panel featuring `ModelTracePanel` (gateway request/response viewer) and `HealthPanel` (model connectivity status).
  - **`ConfirmationModal.tsx`**: Operator gate modal presenting upfront agent plans, proposed code changes, file generation requests, or command executions for operator approval or rejection.
  - **`RunWaitingIndicator.tsx`**: Generation state display showing live activity skeletons, draft text previews, current tool execution, and activity disclosures without synthetic elapsed clocks.
  - **`AgentExecutionTimeline.tsx`**: Step-by-step visual trace of agent planning, tool dispatching, verification, and completion.
  - **`ArtifactCard.tsx`**: Delivers generated artifacts with one-click Open, Save, or Copy actions.
  - **`OnboardingPage.tsx`**: First-time configuration view for testing and registering local OpenAI-compatible endpoints.

---

### 3.4 AI Contracts & RAG Subsystem (`ai/`)

- **`ai/rag/`**:
  - **`db.ts`**: `RAGDatabase` initializes the local SQLite keyword database (`data/rag/keyword.db`) with FTS5 virtual tables (`chunks_fts`) using the Porter stemmer, and the embedded `vectra` vector index (`LocalIndex`) for vector similarity.
  - **`ingestion.ts`**: Ingests PDF and text documents, splits them into semantic chunks (`MAX_CHUNK_TOKENS = 350`), generates vector embeddings via the configured endpoint, and writes entries to both SQLite FTS5 and Vectra.
  - **`retrieval.ts`**: `RetrievalPipeline` executes hybrid search combining vector cosine similarity and FTS5 BM25 text match using Reciprocal Rank Fusion (RRF, `k = 60`), returning grounded citations with source document metadata and page references.
  - **`embedding.ts`**: `EmbeddingService` connects to OpenAI-compatible local `/v1/embeddings` endpoints (default `nomic-embed-text:v1.5`).
- **`ai/shared/`**: Common types (`service-contract.ts`, `errors.ts`, `types.ts`).
- **`ai/vision/`**, **`ai/code/`**, **`ai/draft/`**: Task contracts, prompts, and schema validation for specialized extraction and drafting tasks.

---

### 3.5 Runtime Data Layout (`data/`)

```
data/
├── workbench.db              # SQLite persistence database (WAL enabled, schema version 2)
├── rag/                      # RAG persistence directory
│   ├── keyword.db            # SQLite FTS5 keyword index and document metadata
│   └── index.json            # Vectra embedded vector index
└── runs/
    └── <runId>/              # Unique UUID directory per execution run
        ├── input/            # Dropped files and registered attachments
        ├── intermediate/     # Working scripts, raw model responses, scratch files
        │   └── results/      # P1 immutable typed intermediate result files (<resultId>.json|.txt)
        ├── output/           # Final deliverables (report.docx, output.xlsx, modified scripts)
        └── logs/             # model-gateway.log JSONL, per-request payloads, execution traces
```

---

## 4. IPC Architecture & Channel Reference

All communication between the React renderer and the Electron/Node backend occurs over explicit IPC channels exposed via `window.workbench` and `window.electronAPI`. The renderer never imports Node.js modules or accesses files directly.

### 4.1 Channel Inventory

| Channel | Direction | Payload Schema / Validator | Description |
|---|---|---|---|
| `workbench:startRun` | Renderer → Main | `startRunInputSchema` | Begins run execution; creates Run ID and directories |
| `workbench:resumeRun` | Renderer → Main | `resumeRunInputSchema` | Resumes an interrupted or truncated run |
| `workbench:cancelRun` | Renderer → Main | `cancelRunInputSchema` | Cancels active run execution and revokes scopes |
| `workbench:confirmAction`| Renderer → Main | `confirmActionInputSchema` | Approves or rejects a pending operator confirmation |
| `workbench:registerAttachment`| Renderer → Main | `registerAttachmentInputSchema`| Registers file upload (base64) into run input directory |
| `workbench:getArtifact` | Renderer → Main | `getArtifactInputSchema` | Retrieves artifact metadata and content |
| `workbench:getVerificationReport`| Renderer → Main | `getVerificationReportInputSchema`| Retrieves structural verification report for a run |
| `workbench:getRunHistory` | Renderer → Main | `getRunHistoryInputSchema` | Retrieves historical run summaries |
| `workbench:getHealth` | Renderer → Main | None | Queries model gateway connectivity and endpoint health |
| `workbench:getRunLogs` | Renderer → Main | `{ runId: string, limit?: number }` | Retrieves model gateway trace entries for a run |
| `workbench:getRunLogFile` | Renderer → Main | `{ runId: string, filename: string }` | Reads specific JSON log file within run log scope |
| `workbench:openArtifact`| Renderer → Main | `{ runId: string, artifactId: string }`| Launches native OS application for an artifact file |
| `workbench:saveArtifact`| Renderer → Main | `{ runId: string, artifactId: string }`| Prompts native save dialog to copy artifact |
| `workbench:copyArtifact`| Renderer → Main | `{ runId: string, artifactId: string }`| Copies artifact content to system clipboard |
| `workbench:createChat` | Renderer → Main | `createChatInputSchema` | Creates new chat session |
| `workbench:getChatHistory`| Renderer → Main | `getChatHistoryInputSchema` | Lists chat sessions ordered by update time |
| `workbench:archiveChat`| Renderer → Main | `archiveChatInputSchema` | Soft-deletes a chat session |
| `workbench:renameChat` | Renderer → Main | `renameChatInputSchema` | Updates chat session title |
| `workbench:getMessages`| Renderer → Main | `getMessagesInputSchema` | Retrieves ordered messages for a chat session |
| `workbench:sendMessage`| Renderer → Main | `sendMessageInputSchema` | Persists user or assistant message to database |
| `workbench:editMessage`| Renderer → Main | `editMessageInputSchema` | Edits persisted message content |
| `workbench:getSetting` | Renderer → Main | `getSettingInputSchema` | Retrieves configuration setting value |
| `workbench:setSetting` | Renderer → Main | `setSettingInputSchema` | Upserts configuration setting value |
| `workspace:pickFolder` | Renderer → Main | None | Opens native dialog to select workspace root folder |
| `workspace:register` | Renderer → Main | `registerWorkspaceInputSchema` | Sets active workspace root directory |
| `workspace:deregister`| Renderer → Main | None | Unbinds current workspace root directory |
| `workspace:getCurrent` | Renderer → Main | None | Returns active workspace info (root path, registered date) |
| `workspace:listDir` | Renderer → Main | `listDirInputSchema` | Scoped directory tree listing (depth 4 limit) |
| `workspace:readFile` | Renderer → Main | `readFileInputSchema` | Scoped file read (200 KB safety limit) |
| `workspace:search` | Renderer → Main | `searchInputSchema` | Scoped ripgrep/grep search (50 matches max) |
| `workspace:writeFile` | Renderer → Main | `writeFileInputSchema` | Scoped atomic file write with backup |
| `workspace:runCommand` | Renderer → Main | `runCommandInputSchema` | Sandboxed command execution locked to workspace cwd |
| `kb:listDocs` | Renderer → Main | None | Lists all indexed documents in Knowledge Base |
| `kb:ingestDoc` | Renderer → Main | `ingestDocInputSchema` | Ingests and indexes document into vector and FTS5 index |
| `kb:deleteDoc` | Renderer → Main | `deleteDocInputSchema` | Removes document and all chunks from index |
| `kb:reindex` | Renderer → Main | `reindexInputSchema` | Reindexes document chunks |
| `kb:query` | Renderer → Main | `queryInputSchema` | Executes hybrid search over indexed documents |
| `kb:stats` | Renderer → Main | None | Returns document count and chunk statistics |
| `workbench:getOnboardingStatus`| Renderer → Main | None | Checks if model configuration has been completed |
| `workbench:saveModelConfig`| Renderer → Main | `saveModelConfigInputSchema` | Saves configured models to settings and updates registry |
| `workbench:testModelEndpoint`| Renderer → Main | `testModelEndpointInputSchema`| Tests HTTP connectivity to a model endpoint |
| `workbench:resetOnboarding`| Renderer → Main | None | Resets onboarding completion flag |
| `workbench:runEvent` | Main → Renderer | Push event: `RunEvent` | Streams live run status, tool execution, and thinking |
| `workspace:event` | Main → Renderer | Push event: `WorkspaceEvent` | Pushes workspace registration and file change events |
| `window-minimize` / `maximize` / `close` | Renderer → Main | None | Native frameless window controls |

---

## 5. Core Execution Lifecycles

### 5.1 Unified Agent Execution Loop (`RunManager` & `AgentLoop` — v2 Architecture)

```
1. User enters prompt (and optional attachment) in InputBar
2. Frontend calls workbench.startRun(input)
3. RunManager initializes Run ID and directory tree under data/runs/<runId>/
4. ContextualRouter analyzes prompt + attachments via fast LLM pass
   - Normalizes into a versioned RunContract (v1) and persists it in SQLite (run_contracts)
   - Determines ExecutionMode ('chat' vs 'agent') and permitted capability groups
   - Builds ExecutionEnvelope with authorization state and context limit
5. ToolSurfaceCompositor inspects runtime environment (workspace mounted? attachments? KB docs?)
   - Assembles active tool definitions for the turn:
     Workspace tools: list_dir, read_file, search, write_file, delete_file, run_command
     Specialist tools: extract_document, retrieve_knowledge, execute_python, generate_deliverable
     Result & capability tools: retrieve_result, request_capability
6. AgentLoop dispatches turn to driver model with native `tools` and `tool_choice: "auto"`:
   - Model streams thinking / reasoning -> emitted via 'agent_thinking' or 'model_progress'
   - Pure Chat: If model generates text without tool calls, completes immediately
   - Agentic Plan Confirmation Gate: If tools are invoked on turn 1, pauses for upfront operator review
     of plan and proposed actions via ConfirmationModal
7. Autonomous Tool Execution:
   - ToolDispatcher runs independent read-only tool calls concurrently via Promise.all()
   - Workspace mutations (write_file, delete_file, run_command) are serialized under MutationPolicyGuard
   - Full tool outputs are registered in P1 ResultStore (intermediate/results/<uuid>)
   - Emits 'tool_call', 'tool_result', and 'artifact_ready' events to UI
   - ContextManager applies sliding-window context compaction to summarize tool outputs older than 2 turns
8. Loop repeats (up to maxTurns = 100) until model generates final response or contract completion evaluates to true
9. Deliverables verified via verifyArtifactFile (parser checks, digest generation, integrity check)
10. RunManager persists assistant message to SQLite and transitions state to 'completed' (or 'partial'/'failed')
```

### 5.1.1 Streaming Output, Model Progress, and Task Checkpoints

- **Live Activity Streaming**: Transient progress is delivered via `model_progress` and `task_progress` events through the existing `RunEvent` channel. The renderer waiting view displays live activity skeletons, draft text previews (up to 800 characters for specialist text generation), and stage transitions without synthetic elapsed clocks or artificial percentages.
- **Answer Streaming**: Live response text streams via `assistant_message_chunk` with 50 ms batching. Reasoning content (`<think>` blocks or provider reasoning tokens) is filtered and separated from the validated answer bubble.
- **Task Stages**: Explicit checkpoints track lifecycle stages: `source_inspection`, `repair_generation`, `draft_generation`, `pre_execution_review`, `post_execution_review`, `source_coverage_review`, `correction`, and `result_verification`.
- See `backend/STREAMING.md` for output boundaries and transport limits.

### 5.1.2 P1 Persistent Execution Data & Result Store

- **Authoritative RunContract**: The semantic interpretation is normalized into an immutable `RunContract` record stored in SQLite (`run_contracts`). Model selection, tool composition, and completion evaluation consume this contract. The contract establishes expectations but never grants mutation authority.
- **Immutable Result Store**: Intermediate outputs from document extractions, full file reads, Python executions, and tabular calculations are persisted to `data/runs/<runId>/intermediate/results/<uuid>.json|.txt` with SHA-256 digests and SQLite manifests (`intermediate_results` table).
- **Bounded Result Retrieval**: The `retrieve_result` tool enables the model to inspect specific character offsets or line slices (≤ 3000 chars) of stored results in subsequent turns, allowing context compaction to purge large observations from active memory without data loss.
- See `backend/P1_FOUNDATION.md` for full P1 specification and schemas.

### 5.2 Workspace Harness Loop (`HarnessManager`, `PathGuard`, and `MutationPolicyGuard`)

```
1. User selects local project folder via WorkspacePicker (native dialog)
2. Backend validates directory existence and canonicalizes path
3. HarnessManager registers root and persists it in SQLite settings
4. PathGuard (resolveSafe) wraps all future workspace file operations:
   - Validates path.resolve(workspaceRoot, requestedPath) stays strictly within workspace root
   - Rejects traversal attempts (../), NUL bytes, and access to .harness_backups
5. MutationPolicyGuard controls write and delete operations:
   - Enforces target restrictions and explicit grantScope authorization
   - Automatically archives existing files to .harness_backups/ prior to modification
   - Serializes concurrent mutations with withMutationLock
6. Sandboxed command execution (run_command):
   - Cwd locked to workspace root; sanitized environment variables
   - Command denylist rejects dangerous calls (rm -rf, sudo, curl, wget, network pipes)
   - Opportunistic Linux bwrap network unsharing or macOS sandbox-exec when configured
```

### 5.3 Knowledge Base RAG & Grounding Subsystem

```
1. User adds SOP or engineering specification (PDF, TXT, MD) via Knowledge Base UI
2. IngestionPipeline extracts text, applies sliding-window chunking (MAX_CHUNK_TOKENS = 350)
3. EmbeddingService generates vector embeddings via local /v1/embeddings endpoint
4. RAGDatabase inserts chunk metadata and text into SQLite FTS5 (keyword.db)
   and vector representations into Vectra LocalIndex (index.json)
5. When retrieve_knowledge is invoked:
   - Computes query vector embedding and queries Vectra for top vector matches
   - Queries SQLite FTS5 chunks_fts table using BM25 with Porter stemmer
   - Merges results via Reciprocal Rank Fusion (RRF, k = 60)
   - Returns ranked, grounded citations with source document ID, section label, and page numbers
```

---

## 6. Developer & Build Workflows

### Primary Commands
```bash
# Start full development environment (Vite frontend + Electron main concurrently)
npm run dev

# Start frontend dev server only (Vite on http://localhost:5173)
npm run dev:frontend

# Start Electron pointing to existing dev server
npm run dev:electron

# Build both frontend and Electron main/preload
npm run build

# Preview production build (spawns Electron against built frontend)
npm run preview

# Run TypeScript type check across all subprojects (backend, electron, frontend)
npm run typecheck

# Run unit and integration test suite (Vitest via Electron Node runtime)
npm test

# Run V0 MVP behavioral evaluation and certification
npm run certify:v0

# Run behavioral testing suite
npm run behavioral

# Run end-to-end demo flow tests
npm run demo

# Package native desktop application (electron-builder)
npm run package
```

### Key Rules for AI Coding Assistants
1. **Full Workspace Write Access**: AI assistants have standard read and write permissions across the codebase (`backend/`, `frontend/`, `electron/`, `ai/`, `config/`, `scripts/`, `docs/`, `tests/`, etc.) to implement requested features and bug fixes.
2. **Path Containment Integrity**: Never bypass `resolveSafe` in `backend/src/main/harness/path-guard.ts`. All workspace harness tools must strictly remain within the registered workspace root.
3. **IPC Boundary**: Do not import Electron or Node.js filesystem modules directly into `frontend/src/`. All desktop operations must go through the typed `window.workbench` and `window.electronAPI` bridge interface (`frontend/src/lib/workbench.ts`).
4. **Testing & Verification**: Always run `npm run typecheck` and relevant test commands after making structural changes to ensure contracts and type signatures remain intact.
5. **ZERO HARDCODED DEMO / FIXTURE DATA (CRITICAL)**:
   - **Absolute Prohibition**: NEVER hardcode specific demo fixtures, entity names, synthetic measurements, or scripted findings into runtime production logic (`backend/src/main/`, `frontend/src/`, `electron/`). Examples of prohibited hardcoding: `E-201`, `E201`, `RECHECK WELD JOINT 4B`, `SOP-114` (unless explicitly requested in prompt or retrieved via RAG), synthetic tube wall/pitting measurements, hardcoded filenames like `approval-note-E201.docx`, or pre-canned fallback draft strings.
   - **Universal Deployment Requirement**: Flow scripts and fixtures in `demo/` are demonstration guides. The application is deployed for real-world use by PSU/defence engineers and operators who upload arbitrary documents, datasets, and code files.
   - **Dynamic Architecture**:
     - All findings must be genuinely extracted from attached files via the model gateway or document extractors.
     - Cross-document fusion must dynamically aggregate whatever findings the model returned from each document with real page numbers and source filenames.
     - Grounding and compliance evaluation must query real knowledge bases via RAG or user-specified SOPs dynamically, not pre-scripted if-statements.
     - Generated file deliverables must use descriptive, request-derived names (e.g. `approval-note.docx`, `<basename>-report.docx`), never hardcoded demo IDs.
     - When a model or tool fails, surface the real error—NEVER substitute fake success data or hardcoded mock text.
