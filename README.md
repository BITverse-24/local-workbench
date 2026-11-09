# Local Workbench

Local Workbench is a local-first desktop app for asking questions about files, creating work products, and making approved changes in a selected workspace.

## Project team

| Team | Team ID |
| --- | ---: |
| **Unpaid_Interns** | **119100** |

[![Documentation](https://img.shields.io/badge/Documentation-project%20docs-1f2937?style=flat-square)](docs/diagrams/00_ARCHITECTURE_AUDIT.md)
[![Release](https://img.shields.io/badge/Release-v0.4.0-1f2937?style=flat-square)](VERSION)
[![License: MIT](https://img.shields.io/badge/License-MIT-1f2937?style=flat-square)](LICENSE)

## What it does

The app connects to a model server running on your computer or private network—no cloud model subscriptions required. Configure model endpoints during initial onboarding.

### Execution Modes

| Mode | Purpose | Capabilities & Boundary |
| --- | --- | --- |
| **Chat** | Questions, document Q&A, and follow-ups | Single-turn generation with authorized attachments, previous results, and enabled knowledge sources. No workspace mutation or execution tools. |
| **Work** | Analysis, code repair, and file deliverables | 24-call budget with scoped run storage. Features **`work_exec`** (QuickJS-WASM sandbox) for zero-token-leak tabular/numerical calculations. Artifacts undergo independent mechanical and semantic verification before delivery. |
| **Agent** | Autonomous engineering in a bound workspace root | Multi-turn ReAct driver with **Code Mode** (QuickJS-WASM sandbox), AST symbol replacement (`replace_symbol`), PathGuard confinement, approval gates, mutation logging, automatic backups (`.harness_backups/`), and mandatory project test verification. |

### Network & Model Port Rules
- **Local / Private Only:** Accepts `localhost`, loopback (`127.0.0.1`), private IPv4 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and local IPv6. Public IP addresses and public domains are strictly rejected at the application gateway.
- **Model Roles:** Supports separate endpoints for **Primary/Coding** (e.g. `qwen3.5-9b`, `qwen2.5-coder:7b`), **Vision**, **Draft**, and **Embeddings** (`nomic-embed-text`). Duplicate endpoints are consolidated in the UI.

---

## Architecture Overview

```mermaid
flowchart TB
    classDef default fill:none,stroke:#64748b,stroke-width:1px
    classDef mode fill:none,stroke:#3b82f6,stroke-width:1.5px
    classDef gate fill:none,stroke:#f59e0b,stroke-width:1.5px
    classDef storage fill:none,stroke:#10b981,stroke-width:1.5px

    subgraph App["Local Workbench (Desktop Application)"]
        UI["React UI (Vite + Tailwind)"]
        IPC["Preload IPC Bridge"]
        RM["RunManager (Orchestrator)"]

        Chat["Chat Mode<br/>• Single-turn text<br/>• Read-only context"]:::mode
        Work["Work Mode<br/>• 24-call budget<br/>• work_exec QuickJS sandbox<br/>• Automated repair"]:::mode
        Agent["Agent Mode<br/>• ReAct loop v3 & Code Mode<br/>• AST symbol editing<br/>• Mandatory project tests"]:::mode

        Gate{"Operator Confirmation Gate<br/>(Approvals for writes, commands, Python)"}:::gate
        Guard["PathGuard & MutationPolicy<br/>(Path containment & write locks)"]
        Tools["Guarded Tools<br/>• Specialist (extract, python, docx/xlsx, work_exec)<br/>• Workspace (read, write, replace_symbol, shell)"]
        QJS["QuickJS-WASM Sandbox<br/>(quickjs-emscripten • Route 3 analysis prelude)"]:::storage
    end

    subgraph LocalEnv["Local Environment & Storage"]
        Model["Local Model Server<br/>(LM Studio / Ollama / vLLM)<br/>localhost or private LAN"]
        Store[("SQLite (workbench.db Schema v3)<br/>& Run Artifacts (data/runs/)")]:::storage
        RAG["Local RAG Subsystem<br/>(Vectra + SQLite FTS5)"]:::storage
    end

    UI <-->|"Typed IPC"| IPC
    IPC <--> RM

    RM --> Chat
    RM --> Work
    RM --> Agent

    Chat <-->|"Inference"| Model
    Work <-->|"Inference"| Model
    Agent <-->|"Inference"| Model

    Chat -.->|"Read context"| RAG
    Work -.->|"Retrieve"| RAG

    Work --> QJS
    Agent --> QJS
    Work --> Tools
    Agent --> Gate
    Gate --> Guard
    Guard --> Tools
    Tools -->|"Execution Results"| Agent
    Tools -->|"Parsed Outputs"| Work

    RM -->|"Persist Chats & Runs"| Store
    Tools -->|"Artifacts & Evidence"| Store

    style App fill:none,stroke:#475569,stroke-width:1.5px,stroke-dasharray: 4 4
    style LocalEnv fill:none,stroke:#475569,stroke-width:1.5px,stroke-dasharray: 4 4
```

- **Interactive Context Mentions:** Type `@` in the prompt input to attach workspace files (copies byte snapshots) or reference workspace directories.
- **Adaptive Layout:** Responsive panels featuring collapsible drawer overlays below 1280px (Settings) and 960px (Explorer).
- **In-Depth Technical Reference:** See [AGENTS.md](AGENTS.md) for detailed module contracts, IPC definitions, and storage lifecycles; see [`docs/diagrams/`](docs/diagrams/) for component, data flow, and security boundary diagrams.

---

## Benchmarks (Apple Silicon M4)

End-to-end evaluation metrics measured on an **Apple Silicon workstation** (16GB Unified Memory) using a local model server (LM Studio / Ollama with `qwen3.5-9b` and `qwen2.5-coder-7b-instruct-mlx` at `127.0.0.1:1234`):

### Macro Scenario Execution (Flows A through E)

| Test Flow | Mode | Execution Engine | Mean Wall-Clock | Pass Rate | Generated Deliverable / Validation |
| :--- | :---: | :--- | ---:| :---: | :--- |
| **Flow A: Inspection Bundle** | Work | Document extraction + SOP-114 | **39.3s** | **100%** (18/18 checks) | OpenXML `approval-note.docx` |
| **Flow B: Script Repair** | Work | Traceback capture + Python patch | **13.5s** | **100%** (12/12 checks) | Repaired parser + verified CSV |
| **Flow B-3: Extended Log Parser** | Agent | Code Mode (QuickJS-WASM) | **156.0s** *(vs 277s baseline)* | **100%** (12/12 checks) | 240-row telemetry parser (-51.5% tokens) |
| **Flow C: Drawing Compliance** | Work | SVG vector extraction + SOP-220 | **18.1s** | **100%** (4/4 checks) | Corrective action note |
| **Flow C-2: Relief Valve Review** | Work | `work_exec` (QuickJS-WASM) | **65.0s** *(vs 300s baseline)* | **100%** (6/6 checks) | Word `.docx` deliverable (-80% calls, 0 repair) |
| **Flow D: Full-Stack App Repair** | Agent | AST `replace_symbol` + Vitest | **84.2s** | **100%** (16/16 checks) | Passing project test suite (100% green) |
| **Flow E-1: General Ledger Audit** | Work | `work_exec` multi-table join | **42.1s** | **100%** (24/24 checks) | `variance-summary.csv` (-76.4% tokens) |
| **Flow E-2: Telemetry Profiling** | Work | `work_exec` anomaly detection | **38.4s** | **100%** (24/24 checks) | `anomaly-register.csv` (6 anomalies flagged) |
| **Flow E-3: Inventory Risk Pivot** | Agent | Code Mode 3-way join | **56.8s** | **100%** (24/24 checks) | Stockout deficit register (-71.8% tokens) |

> **Key Performance Advantage**: Executing heavy data transformations and codebase inspections inside the **QuickJS-WASM sandbox** (`work_exec` and Code Mode) eliminates repetitive tool-call thrashing, reducing wall-clock latency by **43% to 78%** and token consumption by **over 50%** while achieving a **100% first-pass pass rate**.

---

## Setup for Development

### Prerequisites
- **Node.js:** 22.12 or later
- **npm:** 10 or later
- **Local Model Server:** LM Studio, Ollama, vLLM, or `llama-server` (running and reachable at `http://localhost:<port>/v1`)

### Quickstart Commands
```bash
# 1. Install dependencies
npm ci

# 2. Start renderer and Electron in dev mode
npm run dev
```

### Verification & Testing
```bash
# Type checking (strict tsc --noEmit across backend, electron, frontend)
npm run typecheck

# Unit & integration test suites (1040+ tests across 88+ suites)
npm test

# Build production bundles
npm run build

# Headless demonstration flow evaluation
npm run demo          # Flows A, B, and C
npm run demo:flow-d   # Flow D web app repair
DEMO_SCENARIOS=E-1,E-2,E-3 npm run demo:scenarios  # Flow E numerical computation

# Behavioral CLI test worker bundle rebuild
npm run build:behavioral

# Interactive Chat UX harness (macOS/Linux)
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-chat-ux.cjs
```

### Desktop Packaging
```bash
# Build native installer / package for the current host OS
npm run package

# Build unpacked package directory for inspection
npm run package:dir
```

- **Packaging Targets:**
  - **macOS:** DMG (`.dmg`) and App bundle (`.app`) with custom Finder icon metadata.
  - **Windows:** NSIS x64 installer (`.exe`).
  - **Linux:** AppImage (`.AppImage`).
- **Development Reset on Packaging:**
  - `npm run package` runs `scripts/reset-dev-defaults.cjs` to clear development database settings and reset `config/models.json`.
  - Development chats, runs, and knowledge indexes are retained; release packages always start with clean, unconfigured state.

### App Icons
- Source asset: `icon.png` in project root.
- Generator: `npm run build:icons`
- Artifacts:
  - macOS: `build/icons/icon.icns` (and Finder bundle icon via Swift script)
  - Windows: `build/icons/icon.ico`
  - Linux: `build/icons/icon.png`

### Storage Isolation
- **Development:** Uses `data/` directly within the repository root.
- **Preview:** Isolated under `<appData>/local-workbench/preview/`.
- **Production / Release:** Isolated under `<appData>/local-workbench/production/`.
- **System AppData Paths:**
  - **macOS:** `~/Library/Application Support/`
  - **Windows:** `%APPDATA%/`
  - **Linux:** `$XDG_CONFIG_HOME/` or `~/.config/`

---

## Execution Support by Platform

The application probes host capabilities dynamically. Service status is visible in the status bar and Settings panel.

| Platform | Agent Workspace Commands | Python in Run Storage |
| --- | --- | --- |
| **macOS** | Uses `sandbox-exec` when probe passes. Otherwise `/bin/sh` with operator approval. | Uses `sandbox-exec` when probe passes. Otherwise approved fallback with digest binding. |
| **Linux** | Uses Bubblewrap (`bwrap`) when probe passes. Otherwise `/bin/sh` with operator approval. | Uses Bubblewrap when probe passes. Otherwise approved fallback with digest binding. |
| **Windows** | Uses `cmd.exe` with operator approval (no native OS sandbox backend). | Python 3 required. Execution requires approval (no OS filesystem or network isolation). |

### Isolation & Execution Details
- **QuickJS-WASM Sandbox (`quickjs-emscripten`):**
  - Runs in-process across macOS, Linux, and Windows with strict memory (32 MB heap ceiling) and CPU deadline (5,000 ms) limits.
  - Powers **Code Mode** (Agent Mode observation) and **`work_exec`** (Work Mode tabular computation) with zero network access and no host OS file access.
  - Injects Route 3 analysis utilities (`parseCSV`, `groupBy`, `join`, `round`, `avg`, `toCSV`, `RowProxy`) for high-speed in-memory data processing.
- **Linux Bubblewrap (`bwrap`):**
  - Probes `/usr/bin/bwrap`, `/bin/bwrap`, and system `PATH`.
  - Requires kernel unprivileged user namespace support (`kernel.unprivileged_userns_clone=1`).
  - If unprivileged namespaces are disabled, execution falls back to explicit approval with user permissions.
- **Python Discovery:**
  - Discovers interpreter via `PYTHON` environment variable, then `PATH` (`python3`, `python.exe`).
  - Launches in an isolated environment excluding user-level site packages.
- **Approved Fallback Security:**
  - When OS sandbox isolation is unavailable, operator approval binds the exact run, source digest, dependencies, and input digests.
  - Any post-approval change invalidates authority and triggers a new confirmation request.
  - Fallback mode runs with current user permissions; it does not enforce kernel-level network or filesystem fences.
- **Workspace Containment:**
  - Agent commands run inside an isolated workspace snapshot.
  - File changes are verified against permitted paths, rejecting symlinks and path traversals before publishing with backups.
- **Filesystem & Manifest Sync:**
  - Windows syncs published files with writable handles; Unix systems sync files and parent directories.
  - SQLite manifests record immutable result IDs, file digests, and execution scopes.

---

## Safety Notes

- **Read-Only Chat & Work:** Neither Chat nor Work mode has access to workspace mutation tools.
- **Scoped Agent Authority:** Agent operations are restricted to the selected workspace root with explicit approval modals for file writes and shell commands.
- **Path Guard:** Rejects path escapes (`..`), absolute path injection, and symlink targets outside the workspace.
- **Isolated Artifacts:** Generated deliverables are written to run-scoped storage (`data/runs/<runId>/output/`) and require explicit user action to export to the host filesystem.

---

## Example Workflows

The [`demo/`](demo/) folder contains sample scenarios and evaluation fixtures:
- `demo/flow_a/`: Multi-page equipment inspection reports and Word note drafting (`.docx`).
- `demo/flow_b/`: Broken CSV vendor log parser repair and boundary condition testing (Python).
- `demo/flow_c/`: Pump skid SVG drawing review against piping engineering standards (SOP-220).
- `demo/flow_d/`: FieldOps React/TS web app multi-defect repair with AST symbol editing and Vitest suite verification.
- `demo/flow_e/`: Heavy numerical, statistical, and multi-relational computation via `work_exec` and Code Mode (`general-ledger.csv`, `sensor-telemetry.csv`, multi-table inventory join).

---

## Releases & License

- Published release binaries and platform release notes: [GitHub Releases](https://github.com/BITverse-24/agent/releases).
- License: [MIT License](LICENSE).
