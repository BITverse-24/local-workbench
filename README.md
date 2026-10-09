# Local Workbench

Air-gapped, multi-model agentic AI desktop application tailored for industrial, PSU, and defence engineering knowledge work.

[![Documentation](https://img.shields.io/badge/Documentation-local--workbench.mintlify.site-1f2937?style=flat-square)](https://local-workbench.mintlify.site/)
[![Team: Unpaid_Interns](https://img.shields.io/badge/Team-Unpaid__Interns-1f2937?style=flat-square)](https://local-workbench.mintlify.site/)
[![Team ID: 119100](https://img.shields.io/badge/Team%20ID-119100-1f2937?style=flat-square)](https://local-workbench.mintlify.site/)
[![Release](https://img.shields.io/badge/Release-v0.1.0-1f2937?style=flat-square)](VERSION)
[![License: MIT](https://img.shields.io/badge/License-MIT-1f2937?style=flat-square)](LICENSE)

---

### Technical Documentation

The complete architectural dossier, component specifications, execution traces, and benchmark data are maintained on the documentation portal:

**Documentation Portal**: [https://local-workbench.mintlify.site/](https://local-workbench.mintlify.site/)

---

## 1. System Overview

Local Workbench is a self-hosted, local-first agentic execution platform engineered for environments where external data egress is strictly prohibited by security and compliance requirements—such as refineries, power utilities, manufacturing facilities, and defence engineering installations.

Traditional cloud-hosted AI assistants cannot be deployed in air-gapped facilities due to data governance restrictions governing confidential technical documentation, including Piping and Instrumentation Diagrams (P&IDs), unreleased mechanical drawings, non-disclosure vendor logs, and statutory inspection reports.

Local Workbench provides an on-premises desktop environment running against local model servers. Operating beyond conversational chat interfaces, it executes multi-turn autonomous agent loops that parse technical source documents, query offline standard operating procedures (SOPs), execute verified Python routines within security boundaries, and generate structured engineering deliverables (`.docx`, `.xlsx`, `.py`, `.csv`, `.md`).

### Team Metadata
- **Team Name**: `Unpaid_Interns`
- **Team ID**: `119100`

---

## 2. Core Architectural Capabilities

### 2.1 Complete Air-Gap & Zero Data Egress
- **Local Loopback Inference**: Dispatches all requests exclusively over local loopback HTTP endpoints (`127.0.0.1`) compatible with the OpenAI REST schema (LM Studio, `mlx-lm`, `llama-server`, Ollama).
- **Network Containment**: No remote telemetry, external licensing calls, or cloud dependencies exist in the execution path. All model queries, vector operations, and document processors operate within the local workstation boundary.

### 2.2 Intent Routing & Multimodal Fallback
- **Intent-Driven Routing**: Contextual classifier analyzes prompts and attachments to route tasks to appropriate model endpoints based on required capabilities (e.g., `qwen2.5-coder-7b-instruct` or `qwen3.5-9b` for primary text and coding execution).
- **Multimodal Visual Fallback**: Detects visual attachments (PDF scans, SVGs, schematics) and automatically invokes local multimodal vision models (`qwen/qwen3-vl-4b` or `qwen2.5-vl`) for OCR and spatial feature extraction without requiring manual user toggling.

### 2.3 Unified Agent Execution Loop
- **Autonomous Loop Driver**: Employs an iterative execution cycle (`AgentLoop`) utilizing native tool calling schemas (`tool_choice: "auto"`).
- **Concurrency & Compaction**: Executes independent read operations in parallel while enforcing strict serialization on file mutations. Applies sliding-window context compaction on tool outputs older than two turns to prevent GPU memory saturation.
- **P1 Immutable Result Store**: Registers raw intermediate tool outputs (full text extractions, calculation arrays, script outputs) into an immutable file-backed result store (`intermediate/results/<resultId>`), allowing bounded slice retrieval (`retrieve_result`) without polluting conversation context.

### 2.4 Filesystem Security & Operator Confirmation Gates
- **Harness Path Containment (`PathGuard`)**: Restricts all workspace file operations to the declared workspace directory using canonical path resolution (`resolveSafe`). Directory traversals (`../`), symbolic link escapes, and attempts to access backup caches are rejected.
- **Mutation Policy & Backups**: Workspace mutations require explicit operator approval scope, maintain atomic write locks, and automatically create point-in-time file snapshots in `.harness_backups/` before any write or delete operation.
- **Sandboxed Script Execution**: Sandboxes command and Python executions with directory locking, strict execution timeouts, and sanitized environment variables (utilizing Linux namespaces via `bwrap` or macOS sandbox execution where available).
- **Operator Review Gates**: Pauses execution to solicit operator review via interactive confirmation modals prior to applying multi-step workspace plans, running arbitrary Python code, or emitting file deliverables.

### 2.5 Embedded Hybrid Retrieval-Augmented Generation (RAG)
- **Local Ingestion Engine**: Parses and chunks standard operating procedures and technical manuals locally, storing vector embeddings via local `/v1/embeddings` endpoints.
- **Hybrid Search Fusion**: Combines vector cosine similarity from an embedded index (`vectra` `LocalIndex`) with BM25 keyword retrieval from a SQLite FTS5 index (Porter stemmer), merging results using Reciprocal Rank Fusion (RRF, `k=60`) to surface grounded citations with page references.

---

## 3. Representative Industrial Workflows

| Identifier | Input Artifacts | Agent Execution Pipeline | Generated Deliverable |
|---|---|---|---|
| **Flow A: Inspection Audit** | Scanned NDT inspection report PDFs and notes | Multimodal visual extraction, cross-document thickness fusion, automated SOP compliance check | Verified `.docx` clearance approval note with statutory citations |
| **Flow B: Tooling Repair** | Broken vendor sensor log parser (`.py`) and CSV logs | Automated trace diagnosis, sandboxed test execution, source repair, data integrity verification | Repaired Python script and verified processed CSV dataset |
| **Flow C: Drawing Review** | Equipment skid schematic (SVG/PDF) | Vector geometry extraction, cross-referencing against piping specifications | Formatted compliance review memorandum with cited discrepancy log |

---

## 4. System Architecture

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

For detailed specifications regarding modules, contracts, and IPC channels, refer to [AGENTS.md](AGENTS.md).

---

## 5. Runtime Requirements & Build Procedures

### Prerequisites
- **Node.js**: Version `22.12` or later
- **Package Manager**: `npm` `10+`
- **Local Model Server**: An OpenAI-compatible REST server (e.g., LM Studio, `mlx-lm`, `llama-server`, or Ollama) running locally on `http://127.0.0.1:1234/v1`.
  - Primary Model: `qwen2.5-coder-7b-instruct` or `qwen3.5-9b`
  - Vision Fallback: `qwen/qwen3-vl-4b` or `qwen2.5-vl`
  - Embedding Endpoint: `text-embedding-nomic-embed-text-v1.5`

### Build and Verification Commands
```bash
# Install root and workspace dependencies
npm ci

# Start local development environment (concurrent Vite dev server and Electron shell)
npm run dev

# Run TypeScript type verification across backend, electron, and frontend
npm run typecheck

# Execute unit and contract verification test suite
npm test

# Build application assets and package native desktop binary
npm run build
npm run package
```

---

## 6. Repository Reference Documents

- **Technical Documentation Portal**: [https://local-workbench.mintlify.site/](https://local-workbench.mintlify.site/)
- **Codebase Architecture & File Reference**: [AGENTS.md](AGENTS.md)
- **V0 MVP Shipping Framework & Verification Gates**: [FRAMEWORK.md](FRAMEWORK.md)
- **Database Schema & Persistence Layout**: [backend/DATABASE.md](backend/DATABASE.md)
- **Streaming Output & Task Progress Contracts**: [backend/STREAMING.md](backend/STREAMING.md)
- **Canonical Run Contracts & Result Store Specification**: [backend/P1_FOUNDATION.md](backend/P1_FOUNDATION.md)
