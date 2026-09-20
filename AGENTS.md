# AGENTS.md — Codebase Architecture & Reference

> **Purpose of this file**: This document serves as the single source of truth for the codebase architecture, module responsibilities, file hierarchy, IPC channels, and execution lifecycles of **Sovereign Workbench**.
> AI coding assistants should read this reference to locate files, understand contracts, and make changes across any directory without needing token-expensive file system searches.

---

## 1. System Overview

**Sovereign Workbench** is a self-hosted, air-gapped, multi-model agentic AI desktop application tailored for industrial, PSU, and defence engineering knowledge work. It enables offline document inspection, code generation/repair, engineering drawing compliance, and local workspace interactions with verifiable model routing and zero external egress.

### High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ELECTRON RENDERER (Vite / React)                 │
│  ChatPanel │ LeftSidebar │ RightSidebar │ FileTree │ ArtifactPane      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ IPC (window.workbenchBridge)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        ELECTRON SHELL (electron/main.ts)                │
│  Window Lifecycle │ CSP Security │ Preload Bridge │ Vite Dev Spawn     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ initBackend()
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     BACKEND RUNTIME (backend/src/main/)                 │
│                                                                        │
│   IPC Handlers ────▶ RunManager ────▶ DeterministicRouter / Classifier │
│         │                  │                      │                    │
│         │                  ▼                      ▼                    │
│         │            HarnessManager          ModelGateway              │
│         │                  │                      │                    │
│         │           ┌──────┴──────┐         ┌─────┴────────┐           │
│         │           ▼             ▼         ▼              ▼           │
│         │       PathGuard    HarnessTools  OpenRouter    LAN Models    │
│         │                                                              │
│         ▼                                                              │
│   SQLite Persistence (workbench.db) & Scoped Run Files (data/runs/)    │
└────────────────────────────────────────────────────────────────────────┘
```

### Core Tech Stack
- **Desktop Shell**: Electron 30, TypeScript, esbuild
- **Frontend Renderer**: React 18, Vite 5, Tailwind CSS v4, Lucide icons
- **Backend Orchestrator**: Node.js, TypeScript
- **Persistence**: SQLite via `better-sqlite3` with WAL mode
- **Model Gateway**: OpenAI-compatible REST endpoints (OpenRouter for dev, LAN `mlx-lm` / `llama-server` / `ollama` for air-gapped production)
- **Local RAG & Vector**: ChromaDB (`chromadb`), local chunking & embeddings
- **Document & Data Processing**: `pdfjs-dist`, `canvas`, `exceljs`
- **Testing**: Vitest 3

---

## 2. Directory Hierarchy

```
agent/
├── AGENTS.md                      # Codebase architecture and navigation guide (this file)
├── BACKEND_HANDOFF.md             # Backend architecture requirements and specifications
├── DEMO.md                        # Scripted demonstration flows (Flow A, B, C)
├── HARNESS.md                     # Local project harness spec (workspace-scoped tool execution)
├── MIGRATION.md                   # Legacy codebase migration reference
├── PRODUCT.md                     # Product vision, user personas, and acceptance criteria
├── PROPOSALS.md                   # Project-level proposed improvements
├── PS.md                          # Problem statement reference
├── RAG.md                         # Retrieval-Augmented Generation implementation spec
├── TASKS.md                       # High-level task tracking and milestones
├── package.json                   # Root workspace scripts and dependencies
├── tsconfig.json                  # Root TypeScript configuration
├── vitest.config.ts               # Test configuration
│
├── electron/                      # Privileged desktop shell
│   ├── main.ts                    # Main process lifecycle, BrowserWindow, Vite spawner, IPC init
│   ├── preload.ts                 # Secure contextBridge exposing window.workbenchBridge
│   ├── tsconfig.json              # Electron TypeScript config
│   ├── electron-builder.json5     # Native application packaging configuration
│   └── dist-electron/             # Bundled output (main.cjs, preload.cjs)
│
├── backend/                       # Core orchestration, agent loop, tools, and persistence
│   ├── index.ts                   # Backend barrel re-export
│   ├── tsconfig.json              # Backend TypeScript config
│   ├── BACKEND_PLANS.md           # Backend IPC routes and implementation blueprints
│   ├── DATABASE.md                # Persistence and SQLite schema documentation
│   ├── TASKS.md                   # Backend-specific implementation task log
│   ├── src/
│   │   ├── shared/                # Shared contracts and type definitions
│   │   │   └── contracts.ts       # Canonical data contracts (TaskType, ModelId, RunEvent, etc.)
│   │   └── main/                  # Backend implementation
│   │       ├── index.ts           # initBackend() entry point
│   │       ├── logger.ts          # Structured event and transition logger
│   │       ├── ipc/               # IPC registration, channel constants, and validators
│   │       ├── run/               # Agent execution lifecycle, filesystem, prompts, store
│   │       ├── harness/           # Scoped workspace file tools, path containment, system prompt
│   │       ├── gateway/           # Multi-model gateway, registry loader, output normalizer
│   │       ├── router/            # Deterministic task router, intent classifier, planner
│   │       ├── persistence/       # SQLite database, schema, chat/message/settings stores
│   │       ├── tools/             # Standalone Python and artifact generation tools
│   │       ├── models/            # Model interfaces and wrappers (chat, code)
│   │       ├── grounding/         # Local SOP criteria and grounding verification
│   │       ├── confirmation/      # Sensitive action confirmation store
│   │       └── validators/        # Model response Zod validators
│   └── tests/                     # Unit and integration test suites
│
├── frontend/                      # User interface (React + Vite)
│   ├── index.html                 # HTML shell
│   ├── vite.config.ts             # Vite configuration
│   ├── tsconfig.json              # Frontend TypeScript config
│   ├── tailwind.config.js         # Tailwind configuration
│   ├── postcss.config.js          # PostCSS configuration
│   └── src/
│       ├── main.tsx               # React entry point
│       ├── App.tsx                # Central state container and layout coordinator
│       ├── App.css / index.css    # Global stylesheet and CSS variables
│       ├── bridge.d.ts            # Type declarations for window.workbenchBridge
│       ├── components/            # UI components (chat, sidebars, modals, telemetry)
│       └── lib/                   # Typed bridge callers, model list, custom hooks, utils
│
├── ai/                            # AI prompts, contracts, vision/code/draft specs, RAG
│   ├── validation.ts              # AI contract validation utilities
│   ├── shared/                    # Shared types, errors, and service contracts
│   ├── vision/                    # Vision/OCR contracts, prompts, and tests
│   ├── code/                      # Coding contracts, prompts, and mocks
│   ├── draft/                     # Approval note drafting contracts and prompts
│   ├── rag/                       # ChromaDB ingestion, chunking, embedding, retrieval
│   ├── tools/                     # Shared AI tool contracts
│   └── mock-responses/            # Fixture responses for offline testing
│
├── config/                        # Runtime configurations
│   ├── models.json                # Active model registry (vision, draft, code, plan)
│   └── models.ollama.example.json # Example configuration for local Ollama endpoints
│
├── data/                          # Runtime data (gitignored / persistent)
│   ├── workbench.db               # SQLite database file
│   └── runs/                      # Scoped directory per run: runs/<runId>/{input,intermediate,output,logs}
│
├── demo/                          # Pre-packaged demo fixtures
│   ├── flow_a/                    # Scanned inspection report bundle & SOP-114
│   ├── flow_b/                    # Reactor logs, vendor log parser, CSVs
│   ├── flow_c/                    # Pump skid SVG drawing & SOP-220
│   ├── manifest.json              # Fixture manifest
│   ├── build_fixtures.py          # Fixture generator script
│   └── validate_fixtures.py       # Fixture verification script
│
└── scripts/                       # Development and build tooling
    ├── dev.cjs                    # Spawns Vite and Electron concurrently in dev
    ├── build-electron.cjs         # Esbuild bundler for electron main & preload
    └── test.cjs                   # Test runner wrapper
```

---

### 3.3 Electron Shell (`electron/`)

- **`electron/main.ts`**:
  - Initializes Electron app lifecycle (`app.whenReady()`, `app.on("window-all-closed")`).
  - In development, spawns the Vite development server (`npm run dev:frontend`) on port 5173 and waits for readiness before creating `BrowserWindow`.
  - In production, serves built assets from `frontend/dist/`.
  - Configures security headers and Content Security Policy (CSP).
  - Calls `initBackend(ipcMain, emit, config)` to connect backend modules to IPC.
  - Handles window control IPC (`window-minimize`, `window-maximize`, `window-close`, `window-open-dev-tools`).
- **`electron/preload.ts`**:
  - Uses `contextBridge.exposeInMainWorld("workbenchBridge", {...})` to safely expose IPC channels to the renderer without exposing Node's `require`, `process`, or `fs`.
---

### 3.5 Runtime Data Layout (`data/`)

```
data/
├── workbench.db              # SQLite persistence database (WAL enabled)
└── runs/
    └── <runId>/              # Unique UUID directory per execution run
        ├── input/            # User-uploaded files and original attachments
        ├── intermediate/     # Generated code, raw model outputs, scratch files
        ├── output/           # Final deliverables (approval-note.docx, output.xlsx)
        └── logs/             # Step traces and execution logs
```

---

## 5. Core Execution Lifecycles

### 5.1 Unified Agent Execution Loop (`RunManager` & `AgentLoop` — v2 Architecture)
```
1. User enters prompt (and optional attachment) in InputBar
2. Frontend calls workbench:startRun(input)
3. RunManager creates Run ID and directory data/runs/<runId>/
4. Driver Router selects lead model based on request modality (code vs draft)
   - Emits 'routing' event (TaskType + ModelId + Reason) to UI
5. Tool Surface Compositor inspects runtime environment (workspace mounted? attachments? KB docs?)
   - Assembles available tools: file tools (list_dir, read_file, write_file...), specialist tools (extract_document, generate_code, generate_text, retrieve_knowledge, execute_python, generate_deliverable)
6. AgentLoop dispatches turn to driver model with native `tools` and `tool_choice: "auto"`
   - Model outputs scratchpad thinking/plan -> emits 'agent_thinking' event to UI transcript
   - Pure Chat: If model emits no tool calls on turn 1, completes immediately with zero tool overhead
   - Agentic Plan Confirmation Gate: If model invokes tools on turn 1, pauses for upfront user review of plan + proposed actions
7. Autonomous Tool Execution:
   - ToolDispatcher runs independent tool calls concurrently via Promise.all()
   - Emits 'tool_call', 'tool_result', and 'artifact_ready' events to UI
   - Sliding-Window Context Compaction automatically summarizes tool outputs older than 2 turns to protect local GPU VRAM
8. Loop repeats (up to maxTurns) until model provides final text answer
9. RunManager persists assistant message to SQLite and transitions to 'completed'
```

### 5.2 Workspace Harness Loop (`HarnessManager`)
```
1. User selects local project folder via WorkspacePicker
2. Backend validates path and checks for directory existence
3. HarnessManager canonicalizes path and persists it as active workspace
4. PathGuard (resolveSafe) wraps all future tool calls:
   - path.resolve(workspaceRoot, requestedPath) must start with workspaceRoot
   - Any escaping path (e.g. ../../etc/passwd) throws PermissionError
5. Tools available to the agent:
   - list_dir: returns filtered directory tree
   - read_file: reads file content up to 200KB limit
   - search: executes fast ripgrep scoped to workspace
   - write_file: copies existing file to .harness_backups/ before writing new content
   - run_command: runs sandboxed process with cwd set to workspace root
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

# Run TypeScript type check across all subprojects (backend, electron, frontend)
npm run typecheck

# Run test suite (Vitest)
npm test

# Package native desktop application (electron-builder)
npm run package
```

### Key Rules for AI Coding Assistants
1. **Full Workspace Write Access**: AI assistants have standard read and write permissions across the codebase (`backend/`, `frontend/`, `electron/`, `ai/`, `config/`, `scripts/`, etc.) to implement requested features and bug fixes.
2. **Path Containment Integrity**: Never bypass `resolveSafe` in `backend/src/main/harness/path-guard.ts`. All workspace harness tools must strictly remain within the registered workspace root.
3. **IPC Boundary**: Do not import Electron or Node.js filesystem modules directly into `frontend/src/`. All OS interactions must go through the typed `window.workbenchBridge` IPC API.
4. **Testing & Verification**: Always run `npm run typecheck` and `npm test` after making structural changes to ensure contracts and type signatures remain intact.
5. **ZERO HARDCODED DEMO / FIXTURE DATA (CRITICAL)**:
   - **Absolute Prohibition**: NEVER hardcode specific demo fixtures, entity names, synthetic measurements, or scripted findings into runtime production logic (`backend/src/main/`, `frontend/src/`, `electron/`). Examples of prohibited hardcoding: `E-201`, `E201`, `RECHECK WELD JOINT 4B`, `SOP-114` (unless explicitly requested in prompt or retrieved via RAG), synthetic tube wall/pitting measurements, hardcoded filenames like `approval-note-E201.docx`, or pre-canned fallback draft strings.
   - **Universal Deployment Requirement**: Flows A, B, and C in `DEMO.md` are demonstration scripts/playbooks. The application is deployed for real-world use by judges, PSU/defence engineers, and operators who will upload arbitrary documents, datasets, and scripts.
   - **Dynamic Architecture**:
     - All findings must be genuinely extracted from the attached files via the model gateway or document extractors.
     - Cross-document fusion must dynamically aggregate whatever findings the model returned from each document with real page numbers and source filenames.
     - Grounding / compliance evaluation must query real knowledge bases via RAG/ChromaDB or user-specified SOPs dynamically, not pre-scripted if-statements.
     - Generated file deliverables must use descriptive, request-derived names (e.g., `approval-note.docx`, `<basename>-report.docx`), never hardcoded demo IDs.
     - When a model or tool fails, surface the real error—NEVER substitute fake success data or hardcoded mock text.
