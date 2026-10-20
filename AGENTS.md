# AGENTS.md — Codebase Architecture & Reference

> **Purpose of this file**: This document describes the current codebase architecture, module responsibilities, file hierarchy, IPC channels, and execution lifecycles of **Local Workbench**.
> AI coding assistants must read this reference to locate files, understand contracts, and make changes across any directory without needing token-expensive file system searches.

---

## 1. System Overview

**Local Workbench** is a local-first desktop application for document inspection, analysis, file generation, and approved workspace changes. It uses local storage and connects to configured model servers on the same computer or on a private network. Model endpoint validation rejects public IP addresses and public host names. This is an application-level endpoint rule; it is not an operating-system firewall or a guarantee that the computer has no external network access.

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
│   IPC Handlers ────▶ RunManager (validate / persist / dispatch mode)   │
│                              │                                         │
│              ┌───────────────┼────────────────┐                        │
│              ▼               ▼                ▼                        │
│        ChatResponder  WorkOrchestrator    AgentLoop                    │
│              │               │                │                        │
│              └───────────────┴────────────────┘                        │
│                              │                                         │
│          ModelGateway · ResultStore · safety services                  │
│                              │                                         │
│                 ┌────────────┴───────────┐                             │
│                 ▼                        ▼                             │
│           Specialist tools         Workspace tools                     │
│        (extract, compute, files)  (Agent mode only)                    │
│         │                                                              │
│         ▼                                                              │
│   SQLite Persistence (workbench.db) & Scoped Run Files (data/runs/)    │
│   Local RAG Subsystem (Vectra LocalIndex + SQLite FTS5 in data/rag/)   │
└────────────────────────────────────────────────────────────────────────┘
```

### Three-mode execution (v1)

RunManager validates and persists the mode before source preparation or intent classification. Older callers default to Chat. Historical runs with no mode record remain unknown. Each chat can have one active run. Agent runs against the same workspace execute in order. Other chats can continue.

- **Chat** uses one generation call for ordinary text. It can read authorized input snapshots and selected knowledge sources. It receives no workspace authority.
- **Work** owns requirements, input preparation, generation, validation, repair, and delivery. It uses run storage, 24 model calls, and two shared recoveries per run, including resumed work. An incomplete review retries against saved bytes before Partial. A confirmed output defect enters repair. Accepted review evidence is bound to the request, sources, output digests, execution, and reviewer version.
- **Agent** retains AgentLoop, a bound workspace root, approval gates, run-specific mutation scopes, locks, and backups. New Agent runs require existing project tests after code or test changes. The runtime selects related tests when supported and uses the full affected suite when the mapping is uncertain. A direct user request can skip tests, with a visible skipped status. Missing test setup produces Partial. Changing the workspace revokes authority.
- Inference uses one shared local accelerator slot for generation, vision, and embeddings. Calls are non-preemptive. Chat has admission preference with fairness and aging. File processing has two slots; Python has one.
- Work inputs are read-only. Python uses a minimal environment and probes OS isolation. If isolation is unavailable, approval binds the run, source, dependencies, and inputs by digest. This approved fallback does not enforce filesystem or network isolation.
- Schema 3 stores mode and engine version, artifact validation evidence, and streamed drafts. Snapshots restore background runs by chat/run identity. Restart marks interrupted execution Partial and expires approvals; the user must resume. Mutations are not replayed automatically.

The run lifecycle and mode authority are implemented in `backend/src/main/run/`. Verification tests for mode boundaries are in `backend/tests/three-modes.test.ts` and related run tests.

Verification decisions are shared through `run/verification-controller.ts`. The execution ledger stores plans, attempts, user waivers, evidence revisions, repair counts, and stop reasons in its existing JSON column. `agent/test-verification.ts` discovers existing suites and reads machine reports; `agent/verification-stage.ts` schedules approved test commands. Tests run in the command snapshot and do not publish generated files. Reports are saved in ResultStore before cleanup. Completion checks current evidence for each mandatory criterion and confirms the saved final response. See `docs/verification-lifecycle.md` for limits and release checks.

Desktop storage paths are selected in `electron/storage.ts`. Development uses the repository's `data/` folder for backend files. Preview and release use separate `local-workbench/preview/` and `local-workbench/production/` folders under Electron's `appData` path. Each mode sets its own `userData` and `sessionData` paths before Electron is ready. Preview and release use an environment-specific model registry and ignore development path overrides. Explicit backend persistence configuration takes priority over `WORKBENCH_DB_PATH`. Packages exclude the mutable development model registry. The old shared profile is retained without automatic import. Storage boundary tests are in `backend/tests/storage-isolation.test.ts`.

The `prepackage` and `prepackage:dir` hooks run `scripts/reset-dev-defaults.cjs` with Electron's Node runtime. They clear settings in both repository development databases, reset the source model registry, remove its onboarding backup, and clear development browser preferences. Chats, run files, knowledge indexes, preview storage, and production storage remain available. Reset checks are in `backend/tests/package-defaults.test.ts`.

### Core Tech Stack
- **Desktop Shell**: Electron 44 (44.7.0), TypeScript 5.6, esbuild
- **Frontend Renderer**: React 18, Vite 5, Tailwind CSS v4, Lucide icons
- **Backend Orchestrator**: Node.js (22.12+), TypeScript
- **Persistence**: SQLite via `better-sqlite3` with WAL mode (Schema Version 3)
- **Model Gateway**: OpenAI-compatible REST endpoints on localhost or private IP addresses; onboarding and registry loading reject public IPs and public host names
- **Model Roles**: Separate Vision, Coding, Draft, and Embeddings endpoints are supported. Draft is the default model selector choice; duplicate endpoints are consolidated.
- **Local RAG & Vector**: Embedded local vector index (`vectra` `LocalIndex`) + SQLite FTS5 (full-text keyword search with Porter stemmer) with Reciprocal Rank Fusion (RRF), local embedding endpoints (`/v1/embeddings`, e.g. `nomic-embed-text`)
- **Document & Data Processing**: `pdfjs-dist`, `canvas`, `docx`, `exceljs`, `jszip`
- **Testing & Verification**: Vitest 3, custom behavioral and scenario evaluation harnesses (`scripts/behavioral.cjs`, `scripts/certify-v0.cjs`, `tests/acceptance.ts`)

---

## 2. Directory Hierarchy

```
agent/
├── AGENTS.md                      # Codebase architecture and navigation guide (this file)
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
│   │   │   ├── local-network.ts   # Allows localhost and private IP model endpoints only
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
│   │       │   ├── manager.ts            # Lifecycle owner; dispatches persisted mode before routing
│   │       │   ├── chat-responder.ts     # Direct response; no autonomous tools or workspace
│   │       │   ├── work-orchestrator.ts  # Run-scoped generation, repair, and saved-content checks
│   │       │   ├── runtime-scope.ts      # Backend authority, cancellation, and shared Work budgets
│   │       │   ├── source-preparation.ts # Cached extraction and bounded source excerpts
│   │       │   ├── recovery.ts           # Startup interruption recovery; no automatic replay
│   │       │   ├── contract.ts           # RunContract normalization, persistence, completion evaluation
│   │       │   ├── envelope.ts           # ExecutionEnvelope builder (Chat / Work / Agent capabilities)
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
│   │       │   ├── inference-scheduler.ts# Shared inference admission, file and Python slots
│   │       │   ├── model-gateway.ts      # Gateway client (OpenAI-compatible REST, chatWithTools)
│   │       │   ├── registry.ts           # Local/private model registry loader (JSON & DB settings)
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
│   │       │   ├── file-worker.ts        # Bounded independent PDF/DOCX/XLSX/export readers
│   │       │   ├── child-process.ts      # Abortable subprocess and process-tree termination
│   │       │   ├── python.ts             # Probed OS isolation; explicit digest-bound fallback approval
│   │       │   ├── python-runtime.ts     # Platform-aware discovery, launch environments, and isolation probes
│   │       │   ├── execution-capabilities.ts # Host command/Python diagnostics exposed through IPC
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
│   │       │   ├── schema.sql            # SQLite DDL (Schema version 3)
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
│   ├── workbench.db               # SQLite database file (WAL mode, Schema version 3)
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
│   └── diagrams/                  # Architecture and flow diagrams
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
├── demo/                          # Scenario assets only
│   ├── flow_a/scenario-1/         # Original inspection review inputs and prompt
│   ├── flow_a/scenario-2/         # Calibration certificate review
│   ├── flow_a/scenario-3/         # Repair close-out review
│   ├── flow_b/scenario-1/         # Original vendor parser repair inputs and prompt
│   ├── flow_b/scenario-2/         # Cold-room incident review
│   ├── flow_b/scenario-3/         # Agent-mode codebase review
│   ├── flow_c/scenario-1/         # Original P-204 drawing review inputs and prompt
│   ├── flow_c/scenario-2/         # Relief-valve compliance review
│   └── flow_c/scenario-3/         # Utility-manifold compliance review
│
└── scripts/                       # Development, build, and test tooling
    ├── dev.cjs                    # Concurrently spawns Vite dev server and Electron
    ├── build-electron.cjs         # Esbuild bundler for electron main & preload
    ├── build-demo-fixtures.py    # Deterministic scenario fixture generator
    ├── validate-demo-fixtures.py # Scenario fixture verification
    ├── demo-manifest.json        # Scenario asset hashes
    ├── portability-smoke.ts      # Opt-in native package backend checks
    ├── test-packaged-portability.cjs # Runs checks inside the native Electron package
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

1. **`agent/` (Agent mode loop)**:
   - **`agent-loop.ts`**: Agent mode's iterative execution loop. Dispatches turns to the selected model with native tools or the configured JSON tool format. Enforces plan approval, per-turn mutation authorization, loop detection, and completion checks against the `RunContract`. Chat and Work use their own responders and do not run this loop.
   - **`tool-dispatcher.ts`**: Dispatches tool invocations concurrently for read-only tools (`Promise.all`), while strictly serializing workspace mutations via `MutationPolicyGuard.withMutationLock`. Integrates with `ResultStore` to register full intermediate outputs before tool results are published.
   - **`context-manager.ts`**: Sliding-window context compaction. Summarizes tool outputs older than 2 turns to protect local GPU context memory while strictly retaining stable result IDs and retrieval instructions. Enforces token budgets (`enforceContextBudget`).
   - **`source-review.ts`**: Verifies attached Python scripts and proposed code modifications against behavioral checklists prior to execution.
   - **`streaming-filter.ts`**: Filters provider reasoning blocks and inline `<think>` tags from live text chunks to maintain clean transcript streams.

2. **`run/` (Execution Lifecycle & Storage)**:
   - **`manager.ts`**: `RunManager` validates and persists the mode, then dispatches to Chat, Work, or Agent before mode-specific source preparation and intent classification. It owns run persistence, event routing, cancellation, and lifecycle coordination.
   - **`contract.ts`**: Normalizes semantic requests into versioned `RunContract` (v1) records. Persisted insert-once into SQLite `run_contracts`. Serves as the authoritative basis for completion evaluation (`evaluateRunContractCompletion`), without granting execution mutation permissions.
   - **`envelope.ts`**: Builds `ExecutionEnvelope`, establishing the capability boundary (`chat`, `work`, and `agent` execution modes) and gating active capability groups (`source_access`, `document_processing`, `result_retrieval`, `structured_computation`, `artifact_generation`, `workspace_mutation`).
   - **`result-store.ts`**: P1 persistent intermediate result store. Writes immutable typed payloads (`text`, `document`, `table`, `structured`, `execution`) to `data/runs/<runId>/intermediate/results/<uuid>.json|.txt` with SHA-256 digests and SQLite manifests (`intermediate_results` table).
   - **`execution-ledger.ts`**: Tracks compact operational state, authorized operations, disk mutations, and token usage limits.
   - **`verification.ts`**: Runs structural and parser validation on generated deliverables (`verifyArtifactFile`: existence, containment, non-empty, extension match, format parser verification).
   - **`filesystem.ts`**: Manages the scoped data layout: `runRoot(runId)`, `resolveRunPath()`, `absoluteDataPath()`.

3. **`gateway/` (Inference & Model Gateway)**:
   - **`model-gateway.ts`**: Provides OpenAI-compatible REST communication (`POST {baseUrl}/chat/completions`, `GET {baseUrl}/models`). Handles native tool calling (`tools` parameter) and JSON-schema fallback modes, streaming chunk consumption, retry logic, timeout enforcement, and token tracking.
   - **`registry.ts`**: Loads model registry entries from `config/models.json` and SQLite settings (`configured_models`). It accepts localhost and private IP endpoints and rejects public IPs and public host names.
   - **`model-selection.ts`**: Resolves the explicit user choice or the configured default. Draft is the default choice; identical model endpoints are deduplicated.
   - **`completion-stream.ts`**: Parses Server-Sent Events (SSE) streams, split UTF-8 chunks, reasoning content, tool call fragments, and finish reasons.

4. **`router/` (Contextual Routing & Tool Compositing)**:
   - **`contextual-router.ts`**: Used by Work and Agent to analyze intent, capabilities, and deliverable expectations with a bounded classification and repair pass. Chat bypasses this router.
   - **`tool-compositor.ts`**: Uses the runtime environment and persisted envelope to compose allowed tools for Work and Agent. Chat has no autonomous tool surface. Unknown tools fail closed.
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
     - `execute_python`: Input-staged Python execution with timeouts and captured output. The backend probes operating-system isolation; when unavailable, a separate user-approved fallback runs without filesystem or network isolation.
     - `generate_deliverable`: Produces structured output documents (`.docx`, `.xlsx`, `.md`, `.csv`, `.json`, `.txt`) with structural parser verification.
   - **`result-retrieval.ts`**: `retrieve_result` allows the agent to inspect bounded slices of immutable stored results from previous turns.
   - **`capabilities.ts`**: `request_capability` can activate a capability only when the persisted mode policy permits it.
   - **`workspace-tools.ts`**: Adapts workspace harness operations for native agent tool calling.

7. **`rag/` & `grounding/` (Local RAG & Grounding)**:
   - **`rag-service.ts`**: Orchestrates document indexing, chunking, embedding generation, and hybrid search. Interacts with the persistent store in `data/rag/`.
   - **`rag-grounding-provider.ts`**: Injects relevant SOP and standard clauses into the run execution context.

8. **`persistence/` (SQLite Storage)**:
   - **`db.ts`**: Initializes `better-sqlite3` with WAL mode (`journal_mode = WAL`, `synchronous = FULL`, `foreign_keys = ON`). Handles idempotent schema creation and version migrations.
   - **`schema.sql`**: SQLite DDL defining Schema Version 3: `chats`, `messages`, `attachments`, `message_attachments`, `run_attachments`, `runs`, `run_transitions`, `routing_decisions`, `model_calls`, `tool_calls`, `execution_results`, `confirmations`, `artifacts`, `run_errors`, `settings`, `kv_meta`, `run_contracts`, `run_execution_ledgers`, `run_verification_reports`, `intermediate_results`, `run_mode_details`, `run_artifact_validations`, and `run_drafts`.
   - **`chats.ts`**, **`messages.ts`**, **`settings-store.ts`**: Structured query repositories for chats, messages, and settings.

9. **`confirmation/` (Operator Confirmation Gate)**:
   - **`store.ts`**: `ConfirmationStore` manages pending approvals and their outcomes. Python fallback approval is tied to the run, source, dependencies, and inputs by digest.

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
├── workbench.db              # SQLite persistence database (WAL enabled, schema version 3)
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
| `workbench:getRunSnapshot` | Renderer → Main | `getRunSnapshotInputSchema` | Restores mode, state, queue, progress, draft, approval, artifacts, and verification by chat or run |
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
| `workspace:runCommand` | Renderer → Main | `runCommandInputSchema` | Command execution in a workspace copy; probed OS isolation or exact approved fallback |
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

### 5.1 Shared run lifecycle and mode dispatch

`RunManager` validates and persists the requested mode before it prepares sources or classifies intent. A prompt cannot change the selected mode. New runs store their mode and engine version. Older callers with no mode use Chat; older records with no reliable mode remain unknown.

The manager then dispatches to one of three paths:

| Path | Lifecycle owner | Authority |
| --- | --- | --- |
| **Chat** | `ChatResponder` | One ordinary response generation. Reads authorized attachment snapshots, prior artifact snapshots, and selected knowledge sources. No autonomous tool loop or workspace access. |
| **Work** | `WorkOrchestrator` | Requirements, source preparation, generation, validation, repair, and delivery. Reads run inputs and results, and writes only to run storage. |
| **Agent** | `AgentLoop` | Workspace tasks through the harness. The run is bound to a workspace root and uses path containment, approvals, mutation scopes, locks, backups, and verification. |

The RunManager owns persistence, cancellation, event routing, per-chat concurrency, and restart recovery. One run can execute in each chat. Agent runs for the same workspace are serialized. Chat and Work runs in other chats can continue.

Work and Agent compose tools from the persisted execution envelope. Unknown tools fail closed. Chat does not enter the tool loop. Work is limited to 24 model turns and two recovery attempts. A useful result with a missing or unverified required check is Partial, not Complete.

Generation, vision, and embeddings use the shared inference scheduler. Calls are non-preemptive. Queued calls can be cancelled. The scheduler gives Chat preference while admitting waiting background work and ages long waits. File processing uses two slots; Python uses one.

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
6. Command execution (`run_command`):
   - Runs in a workspace copy and uses operating-system isolation when its probe passes.
   - If isolation is unavailable, exact run-bound command approval permits native shell execution with user permissions. The approval states that files outside the workspace and the network can be accessed. The copy does not provide OS isolation.
   - Publishes only changes that pass the configured scope and verification checks.
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
