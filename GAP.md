# Sovereign Workbench — MVP Gap Analysis & Implementation Roadmap

> **Reference Documents:**
> - [`PS.md`](./PS.md) — Problem Statement & High-Level Scope
> - [`PRODUCT.md`](./PRODUCT.md) — Vision, Core USPs, and Definition of Done
> - [`DEMO.md`](./DEMO.md) — Canonical SIH 2026 Demo Playbook (Flows A, B, and C)
> - [`BACKEND_HANDOFF.md`](./BACKEND_HANDOFF.md) — Backend Architecture Specifications
> - [`AGENTS.md`](./AGENTS.md) — System Overview and Module Hierarchy

---

## 1. Executive Summary

**Sovereign Workbench** is an air-gapped, multi-model agentic desktop application built for high-security industrial, PSU, and defence engineering workflows. Its value proposition is built on three pillars:
1. **Verifiable Model Auto-Routing**: Dynamically routing tasks across specialized models (Vision/OCR, Drafting/Reasoning, Coding) based on task intent and input media.
2. **Live Sovereignty Proof**: Continuous proof of zero external network egress via a visible monitor displaying a 5-host LAN allowlist, zero external request counter, and a demonstrable blocked outbound attempt.
3. **Grounded Agentic Deliverables**: Multi-step, iterative agent workflows that reason against local SOPs and produce production-grade deliverables (`.docx`, verified code, `.xlsx`, `.csv`, `.md`) rather than conversational answers.

### Current Codebase Status
A solid foundation is in place:
- **Desktop Shell & IPC**: Electron 30 with secure context preload bridge (`workbenchBridge`).
- **Frontend UI**: React 18 / Vite 5 / Tailwind CSS layout with dark theme, collapsible sidebars, model dropdown, streaming plan transcript, confirmation modal, and artifact pane.
- **Persistence**: SQLite (`better-sqlite3`) with WAL mode, normalized schema for chats, messages, runs, artifacts, and settings.
- **Gateway & Execution**: Model gateway adapter for OpenRouter (dev) with strict JSON normalization, token limiting, and a sandboxed Python executor with an auto-repair loop.
- **Test Oracles**: Deterministic fixtures and validation scripts (`demo/validate_fixtures.py`) that pass offline verification.

### Key Finding
**Major core functional requirements specified in `DEMO.md` and `PRODUCT.md` remain unbuilt, stubbed out, or deferred.** Most notably:
- The **Vision/OCR execution pipeline is explicitly disabled** with an error thrown in `RunManager`.
- The **Sovereignty Monitor** (USP #2) does not exist in either frontend UI or backend.
- The **Local Knowledge Base / SOP Grounding Engine (RAG)** is completely unbuilt; the grounding provider is an empty dummy file.
- The **Multi-Attachment System** is missing; runs can only accept one file token.
- **Word Document (`.docx`) Generation** is not implemented, and the `docx` library is not installed.
- **Flow B** only generates new scripts from CSVs; it cannot ingest, diagnose, or patch an uploaded `.py` script.
- **Flow C** (SVG engineering drawing compliance) has no implementation.

---

## 2. Core Pillars & USPs Gap Analysis

### 2.1 Pillar 1: Verifiable Multi-Model Auto-Routing
- **Requirement (`PRODUCT.md §5.1`, `DEMO.md §10`)**: Automatic task classification into distinct task types (`vision`, `draft`, `code`), routing to separate endpoints, and visual badge indication in the UI. In multi-step runs (e.g. Flow A: Vision $\rightarrow$ Draft), the system must hand off intermediate state from one specialized model to another.
- **Current State**:
  - `backend/src/main/router/deterministic-router.ts`: Contains lightweight classification logic (`routeTask` and `routeSubtask`).
  - `backend/src/main/router/planner.ts`: Breaks prompts into subtasks with types (`vision`, `code`, `draft`).
- **Gaps**:
  - **No State Handoff Between Models**: In `backend/src/main/run/manager.ts`, subtasks are looped over, but each subtask executes in isolation without passing outputs from earlier steps (e.g. OCR text $\rightarrow$ SOP check $\rightarrow$ draft prompt).
  - **Vision Flow Deferred**: `manager.ts:289` explicitly blocks vision execution:
    ```ts
    if (route.taskType === "vision") {
      throw new Error("vision flow is deferred in this build");
    }
    ```
  - **SVG / Drawing Intent Missing**: The router does not classify SVG engineering drawings or route them to vision-reasoning endpoints.

### 2.2 Pillar 2: Live Sovereignty Proof (Air-Gap & Network Monitor)
- **Requirement (`PRODUCT.md §5.2`, `DEMO.md §29-31, §95, §149, §202`)**:
  - A permanently visible sovereignty panel in the UI.
  - Display of the 5-host LAN allowlist (`192.168.10.11:8000`, `192.168.10.12:8001`, `192.168.10.13:8002`, `192.168.10.14:8003`, `192.168.10.15:8004`).
  - Real-time external request counter showing `0`.
  - A demonstrable "blocked outbound attempt" event (e.g. simulated or blocked outbound package download/cloud call).
- **Current State**:
  - `frontend/src/components/RightSidebar.tsx`: Contains only model selector, temperature slider, service health indicators, and a telemetry widget.
  - `backend/src/main/gateway/model-gateway.ts`: Increments an in-memory `externalRequestCount = 0` but never exposes or monitors system sockets.
- **Gaps**:
  - **No UI Sovereignty Panel**: No widget or dashboard displaying LAN allowlist, monitor status, external request counts, or blocked attempt history.
  - **No Network Egress Monitor / Interceptor**: No network socket tracker, proxy, or iptables/system-level monitor.
  - **No Blocked Event Trigger / Demonstration**: No IPC endpoint or agent hook to trigger and display a blocked external egress attempt.

### 2.3 Pillar 3: Grounded Agentic Deliverables (RAG & Tooling)
- **Requirement (`PRODUCT.md §6`, `PS.md §7`)**:
  - Grounding in local SOPs and specifications (`SOP-114`, `SOP-220`).
  - Production-grade deliverables (`.docx`, verified code, `.xlsx`, `.csv`, `.md`).
- **Current State**:
  - Only `.xlsx` generation from Python stdout/CSV is implemented (`backend/src/main/tools/artifacts.ts`).
- **Gaps**:
  - **No RAG / Vector Retrieval**: ChromaDB is listed in `backend/package.json` but is never instantiated, connected, or queried.
  - **Grounding Provider is an Empty Stub**: `backend/src/main/grounding/provider.ts` contains only an unused placeholder interface:
    ```ts
    // This build performs no pre-model preparation step...
    export interface GroundingProvider { prepare(input: GroundingRequest): Promise<GroundingResult>; }
    ```
  - **No `.docx` Generator**: Generating Word approval notes (`approval-note-E201.docx`) is completely missing. `docx` is not in root `package.json`.

---

## 3. Flow-by-Flow Gap Analysis

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FLOW A: Scanned Inspection Bundle -> SOP Grounding -> DOCX Note         │
│ Status: BLOCKED / NOT IMPLEMENTED                                       │
└─────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│ FLOW B: Vendor Log Script Repair -> Sandbox Execution -> Verified Output│
│ Status: PARTIALLY IMPLEMENTED (Wrong Scenario: CSV only, no .py ingest) │
└─────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│ FLOW C: Engineering Drawing -> SOP-220 Spec Check -> Compliance Note    │
│ Status: NOT IMPLEMENTED                                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Flow A: Scanned Inspection Bundle $\rightarrow$ Approval Note (Flagship Flow)

| Step | Expected Behavior (`DEMO.md §32-96`) | Current Implementation Status | Gap / Required Action |
| :--- | :--- | :--- | :--- |
| **1. Ingestion** | User drops bundle of two PDFs (`inspection-report-E201-annotated.pdf` + `inspection-report-E202-followup.pdf`). | `RunManager` only accepts a single `attachmentToken`. | Refactor attachment registration and `RunManager` to support multi-attachment bundles. |
| **2. Routing** | Router selects Vision/OCR model with reason `scanned inspection bundle`. | Router detects single PDF as vision, but fails on bundle. | Update `routeTask` and `routeSubtask` to identify bundle uploads. |
| **3. Plan Streaming** | Transcript streams: OCR pages, extract measurements/defects/handwriting, flag uncertain notes, check SOP-114, draft note, generate Word doc. | `planner.ts` generates generic subtasks. | Align planner prompts or hardcoded deterministic plan with Flow A steps. |
| **4. OCR / Vision Execution** | Model processes scanned PDF pages, extracts tube thickness, pitting, gasket degradation, and handwritten annotation `"RECHECK WELD JOINT 4B"`. | `manager.ts:289` throws `Error("vision flow is deferred in this build")`. | Implement `VisionModel` in `backend/src/main/models/vision-model.ts`, call gateway with rendered page images, parse and validate `VisionResult` via `ai/vision/contract.ts`. |
| **5. SOP-114 Grounding** | Compare findings with `demo/flow_a/sop-114-pressure-equipment-inspection.md`. Produce structured statuses: `fail` (thickness < 3.2mm), `pass`, `unknown` (weld joint 4B). | `grounding/provider.ts` is an empty stub. | Implement SOP-114 rules engine / local knowledge retrieval to match findings to SOP-114 §3.2 limits. |
| **6. Drafting Route Switch** | Router dynamically switches to drafting model with reason `compose grounded approval note`. | Subtask routing exists, but no context is passed to drafting step. | Pass vision findings and SOP evaluation results into `DraftModelRequest`. |
| **7. Grounded Draft** | Draft contains evidence table, citation `[SOP-114 §3.2]`, corrective actions, and warning that approval authority is missing. | Chat model only produces raw plain text answers. | Implement `DraftModel` in `backend/src/main/models/draft-model.ts` that enforces `DraftResult` structure and SOP citations. |
| **8. Confirmation & DOCX Tool** | User confirms document generation; creates `approval-note-E201.docx` with letterhead, findings, handwritten evidence, and references. | No `.docx` tool exists. `docx` npm library is missing. | Add `docx` library and build `generateDocx()` in `backend/src/main/tools/artifacts.ts`. |

---

### 3.2 Flow B: Vendor-Log Utility Repair & Verification

| Step | Expected Behavior (`DEMO.md §97-150`) | Current Implementation Status | Gap / Required Action |
| :--- | :--- | :--- | :--- |
| **1. Ingestion** | User uploads broken script (`broken-vendor-log-parser.py`) AND test data (`vendor-maintenance-log.csv`). | Only single attachment supported. `executeDataTask` only handles raw CSV. | Add dual-file attachment support (script + dataset). |
| **2. Routing** | Router selects Code model with reason `Python repair and verification`. | Matches `code` if CSV or code keywords are present. | Update router reason to distinguish script repair from generic CSV summarization. |
| **3. Plan & 1st Sandbox Run** | Run existing script in sandbox; visibly fail with traceback on blank temperature cell. | `executeDataTask` immediately calls code model to write a new `task.py` instead of running the broken script first. | Add initial execution step: stage uploaded `broken-vendor-log-parser.py` and run it to observe actual failure traceback. |
| **4. Auto-Repair Loop** | Code model receives traceback, fixes blank cell and inclusive threshold (`val >= limit`), writes patch. | Auto-repair retry loop exists in `manager.ts:381-426`. | Adapt repair prompt to specifically patch the existing script structure rather than re-generating from scratch. |
| **5. 2nd Sandbox Run** | Script executes successfully, outputs `ROWS 5; MALFORMED 1; ABOVE_LIMIT 1` and creates repaired CSV. | Sandboxed execution runs and validates exit code 0. | Verified working for synthetic scripts; wire to use `vendor-maintenance-log.csv`. |
| **6. Deliverables** | Present repaired Python script (`repaired-parser.py`) AND verified output CSV as downloadable artifacts. | Only creates output CSV/XLSX. Repaired `.py` is kept in `intermediate/` and not exposed as an artifact. | Register `intermediate/task.py` (or `repaired-parser.py`) as an official run artifact. |
| **7. Blocked Attempt Proof** | Show sovereignty monitor record of blocked package download (e.g. `pip install`). | Not implemented. | Wire simulated/sandbox blocked egress event to sovereignty monitor. |

---

### 3.3 Flow C: Engineering Drawing Cross-Check Against Piping SOP

| Step | Expected Behavior (`DEMO.md §151-204`) | Current Implementation Status | Gap / Required Action |
| :--- | :--- | :--- | :--- |
| **1. Ingestion** | User drops `pump-skid-P204.svg` and requests compliance check against piping spec. | SVG media type not routed to drawing compliance. | Support `.svg` attachments and image conversion/rasterization for vision input. |
| **2. Routing** | Router selects Vision-Reasoning model with reason `engineering drawing interpretation`. | No SVG / drawing route rule exists. | Add SVG drawing classification in `deterministic-router.ts`. |
| **3. Vision Interpretation** | Model extracts labels: `XV-204 Class 150` valve and `DN80` discharge line diameter. | Not implemented. | Add vision prompt/extractor for engineering drawings. |
| **4. SOP-220 Spec Check** | Compare against `piping-spec-SOP-220.md`: Class 150 < 300 (non-compliant) and DN80 < 100 (non-compliant). Cites `[SOP-220 §4.2]` and `[SOP-220 §4.3]`. | Not implemented. | Implement SOP-220 compliance checking rule evaluator. |
| **5. Deliverable** | Generate concise reviewer corrective-action note (`corrective-action-note.md`) stating drawing is NOT approved. | Not implemented. | Generate Markdown compliance artifact and register in run artifact pane. |
| **6. Blocked Attempt Proof** | Show sovereignty monitor record of blocked cloud vendor API attempt. | Not implemented. | Trigger sovereignty blocked egress event in monitor. |

---

## 4. Architectural & Subsystem Gaps

### 4.1 Multi-Attachment Architecture
- **Problem**: `StartRunInput` only has `attachmentToken?: string`. The database schema table `runs` has a single `attachment_id TEXT`.
- **Requirement**: Runs in Flows A & B require 2 attachments.
- **Solution Needed**:
  - Update `schema.sql` to support multiple attachments per run via `message_attachments` or a `run_attachments` join table.
  - Update `IPC_RUN.REGISTER_ATTACHMENT` and `IPC_RUN.START_RUN` to accept an array of `attachmentTokens?: string[]`.
  - Update `RunManager.start()` to resolve and stage multiple attachments in `data/runs/<runId>/input/`.

### 4.2 Sovereignty Monitor Subsystem
- **Problem**: No sovereignty UI panel or backend network monitor exists.
- **Solution Needed**:
  - **Backend**: Implement `backend/src/main/sovereignty/monitor.ts`:
    - Track active LAN allowlist (5 IPs).
    - Track external connection attempts (counter: 0).
    - Provide a method `recordBlockedAttempt(destination, reason)` storing blocked events.
    - Expose IPC channels: `workbench:getSovereigntyState`, `workbench:simulateBlockedAttempt`, and push event `workbench:sovereigntyEvent`.
  - **Frontend**:
    - Add a dedicated **Sovereignty Dashboard Widget** in `RightSidebar.tsx` or as an expandable status bar.
    - Display LAN allowlist nodes with live green status pings.
    - Prominently display the `0 External Requests` badge.
    - Render blocked outbound attempt alerts in red/amber with timestamp and blocked host.

### 4.3 Local Knowledge Base / RAG & Grounding Engine
- **Problem**: `grounding/provider.ts` is completely empty. SOP files (`sop-114`, `sop-220`) are not indexed.
- **Solution Needed**:
  - Implement a deterministic local knowledge retrieval module `backend/src/main/grounding/local-grounding.ts`:
    - Ingest markdown SOPs from `demo/flow_a/sop-114-pressure-equipment-inspection.md` and `demo/flow_c/piping-spec-SOP-220.md`.
    - Provide a rule evaluation engine that checks extracted parameters against SOP thresholds (e.g. wall thickness, pitting, weld joint rechecks, valve class, pipe diameter).
    - Format citations matching oracle specifications (`[SOP-114 §3.2]`, `[SOP-220 §4.2]`, `[SOP-220 §4.3]`).

### 4.4 Vision & Draft Model Contracts in Backend
- **Problem**: `backend/src/main/models/` only has `chat-model.ts` and `code-model.ts`.
- **Solution Needed**:
  - Implement `backend/src/main/models/vision-model.ts`:
    - Calls gateway with PDF page images or SVG raster.
    - Validates output using `ai/vision/contract.ts` (`VisionResult`).
  - Implement `backend/src/main/models/draft-model.ts`:
    - Feeds findings + SOP citations into approval note prompt (`ai/draft/prompts/approval-note-drafting-prompt.md`).
    - Validates output using `ai/draft/contract.ts` (`DraftResult`).

### 4.5 Deliverable Generators (`.docx` & `.md`)
- **Problem**: Only Excel (`.xlsx`) generation exists.
- **Solution Needed**:
  - Install `docx` package (`npm install docx`).
  - Implement `generateDocx(runId, draftResult)` in `backend/src/main/tools/artifacts.ts`:
    - Format formal letterhead, equipment metadata, findings table, handwritten observations, grounding citations, and signature blocks.
    - Save to `data/runs/<runId>/output/approval-note-E201.docx`.
  - Implement `generateMarkdownArtifact(runId, filename, content)` for Flow C's `corrective-action-note.md`.

---

## 5. Implementation Roadmap & Priority Matrix

| Phase | Component | Tasks | Target Files |
| :---: | :--- | :--- | :--- |
| **Phase 1** | **Multi-Attachment Support** | 1. Extend DB schema & IPC validators to accept array of attachment tokens.<br>2. Update `RunManager` staging to copy all input files to run input dir. | `backend/src/main/ipc/validators.ts`<br>`backend/src/main/run/filesystem.ts`<br>`backend/src/main/run/manager.ts`<br>`frontend/src/bridge.d.ts` |
| **Phase 2** | **Sovereignty Monitor (USP #2)** | 1. Create `backend/src/main/sovereignty/monitor.ts` tracking allowlist, 0 egress, and blocked attempts.<br>2. Add IPC handlers & push events.<br>3. Build Sovereignty Panel UI in React sidebar. | `backend/src/main/sovereignty/`<br>`backend/src/main/ipc/`<br>`frontend/src/components/RightSidebar.tsx`<br>`frontend/src/components/SovereigntyPanel.tsx` |
| **Phase 3** | **Flow A: Vision & OCR Pipeline** | 1. Implement `VisionModel` wrapper with Zod validation.<br>2. Unblock vision route in `RunManager`.<br>3. Parse handwritten annotations & defect measurements. | `backend/src/main/models/vision-model.ts`<br>`backend/src/main/run/manager.ts`<br>`backend/src/main/gateway/model-gateway.ts` |
| **Phase 4** | **Flow A: SOP Grounding & DOCX Generation** | 1. Implement SOP-114 rule evaluation & citation provider.<br>2. Implement `DraftModel` for structured approval notes.<br>3. Install `docx` and build `generateDocx` artifact tool. | `backend/src/main/grounding/`<br>`backend/src/main/models/draft-model.ts`<br>`backend/src/main/tools/artifacts.ts`<br>`package.json` |
| **Phase 5** | **Flow B: Script Repair Alignment** | 1. Update Code Flow to ingest uploaded `.py` script + `.csv`.<br>2. Run initial execution to produce real traceback.<br>3. Auto-repair script and expose repaired `.py` as deliverable artifact.<br>4. Trigger blocked `pip` attempt in sovereignty monitor. | `backend/src/main/run/manager.ts`<br>`backend/src/main/tools/python.ts` |
| **Phase 6** | **Flow C: Drawing Compliance** | 1. Add SVG drawing input support in router and vision pipeline.<br>2. Implement SOP-220 rule reasoning engine.<br>3. Generate `corrective-action-note.md` deliverable artifact.<br>4. Trigger blocked vendor cloud attempt in sovereignty monitor. | `backend/src/main/router/`<br>`backend/src/main/grounding/`<br>`backend/src/main/run/manager.ts` |

---

## 6. Conclusion

The current repository provides a solid and working core for chat, database persistence, and isolated Python data tasks. However, to fulfill the requirements of **`DEMO.md`**, **`PRODUCT.md`**, and the **`PS.md`** problem statement:
- The **Vision/OCR and Drafting handoff** must be unblocked and completed for Flow A.
- The **Sovereignty Monitor** must be implemented to fulfill the central claim of proven zero-egress air-gap isolation.
- The **Local Grounding / SOP rule evaluator** and **`.docx` generator** must be connected to provide verified, cited deliverables.
- **Flows B and C** must be brought into strict alignment with their fixture oracles and demo scripts.
