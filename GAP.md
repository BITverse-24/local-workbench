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
Substantial architectural capabilities are implemented and fully verified (197/197 tests passing across 25 test suites):
- **Desktop Shell & IPC**: Electron 30 with secure context preload bridge (`workbenchBridge`), window lifecycle controls, and sandboxed execution.
- **Frontend UI**: React 18 / Vite 5 / Tailwind CSS layout with dark theme, collapsible sidebars, model dropdown, streaming plan transcript, confirmation modal, and artifact pane.
- **Persistence**: SQLite (`better-sqlite3`) with WAL mode, normalized schema for chats, messages, runs, attachments (`run_attachments`), artifacts, and settings.
- **Multi-Attachment System** (COMPLETED): Multi-token IPC acceptance (`attachmentTokens?: string[]`), database relation tracking, concurrent staging into `data/runs/<runId>/input/`, and intelligent bundle classification.
- **Model Gateway & Routing**: OpenAI-compatible model gateway supporting LAN endpoints and OpenRouter, with strict JSON normalization and deterministic intent routing.
- **Direct Vision & Hybrid Extraction Pipeline** (COMPLETED):
  - Direct execution via `executeVisionTask` in `RunManager` (collapsed fragile separate vision agent).
  - Automatic Hybrid Extraction: Tier 1 Fast Digital Text stream (>=60 chars/page, >=150 chars total) vs. Tier 2 Visual VLM stream.
  - Deterministic Visual Page Ranker (`rankPagesByVisualDensity`): vector operator scoring (P&ID/CAD), raster XObject detection, landscape aspect ratio geometry, and drawing keyword matching.
  - Contextual text preservation: unselected pages' text injected into prompt context, bounding vision tokens to <4096.
  - Single-turn chaining from vision extraction directly into approval note drafting.
- **Cross-Document Findings Fusion & SOP-114 Rule Engine** (COMPLETED):
  - Dynamic cross-document finding aggregation attributing source files and page numbers without hardcoded mock entities.
  - Deterministic evaluation engine (`evaluateSOP114Findings`) checking wall thickness thresholds (< 3.2mm limit), pitting corrosion, and handwritten unverified weld joint notes against `SOP-114 §3.2`.
- **True Formatted Binary `.docx` Generator** (COMPLETED):
  - Self-contained Office Open XML binary generator (`generateDocx`) via `jszip` producing compliant `.docx` packages with PK zip header (`0x50, 0x4B, 0x03, 0x04`).
  - Formal engineering letterhead, air-gap governance attestation banner, styled headings (`H1`, `H2`, `H3`), dark header findings tables (`<w:tbl>`), inline formatting (`**bold**`, `*italic*`, monospace code chips), and warning callouts. Verified with macOS native `textutil` and automated unit tests.
- **Local Project Harness** (COMPLETED):
  - `HarnessManager` with workspace lifecycle and `PathGuard` safe path resolution (`resolveSafe`).
  - Scoped tools: `list_dir`, `read_file`, `search` (ripgrep), `write_file` (with `.harness_backups/`), and `run_command`.
- **Local RAG & Knowledge Base** (COMPLETED):
  - Local vector store powered by `vectra` (`RAGDatabase`, `EmbeddingService`, `IngestionPipeline`, `RetrievalPipeline`).
  - `RAGService` with full IPC handler suite (`workbench:kb*`) and `RAGGroundingProvider` wired into `RunManager`.
- **Code Execution & Repair**: Sandboxed Python runner (`backend/src/main/tools/python.ts`) with iterative traceback auto-repair loop and Excel (`.xlsx`) generation (`artifacts.ts`).

*(Note: Live Sovereignty Proof — 5-host LAN allowlist verification, zero egress proof, and blocked outbound attempts — is demonstrated via an independent external network monitor/sidecar alongside the desktop app during live evaluation, kept strictly decoupled from the application codebase).*

### Key Remaining Gaps (Inside Application)
1. **Flow B Script Ingestion & Traceback Alignment**: The data task generates fresh scripts rather than staging `broken-vendor-log-parser.py`, executing it in the sandbox to capture the runtime failure traceback, feeding it to the code model for auto-repair, and registering `repaired-parser.py` as an official output artifact alongside the verified CSV.
2. **Flow C Drawing Compliance**: Support `.svg` engineering drawing attachments in the router, visual/node extraction for valve rating (`XV-204 Class 150`) and pipe diameter (`DN80`), evaluate against `SOP-220` piping specifications (`[SOP-220 §4.2]`, `[SOP-220 §4.3]`), and output `corrective-action-note.md`.

---

## 2. Core Pillars & USPs Gap Analysis

### 2.1 Pillar 1: Verifiable Multi-Model Auto-Routing
- **Requirement (`PRODUCT.md §5.1`, `DEMO.md §10`)**: Automatic task classification into distinct task types (`vision`, `draft`, `code`), routing to separate endpoints, and visual badge indication in the UI. In multi-step runs (e.g. Flow A: Vision -> Draft), the system must hand off intermediate state from one specialized model to another.
- **Current State**:
  - `backend/src/main/router/deterministic-router.ts`: Classifies prompts and attachments into `vision`, `code`, `draft`. Includes `inspectAttachmentBundle` to inspect multi-attachment bundles (multi-PDF bundles route to `vision`, `.py` + `.csv` bundles route to `code`).
  - `backend/src/main/run/manager.ts`:
    - Attached images and PDFs route immediately to `executeVisionTask`.
    - Automatically chains vision findings directly into `executeChatTask` (Draft) when user requests an approval note or formal deliverable.
    - Emits real-time `routing` telemetry (`taskType`, `modelId`, `tier`, `tokensSaved`, `reason`).
- **Gaps**:
  - **SVG Drawing Routing (Flow C)**: Router does not yet identify `.svg` engineering drawings as visual inspection tasks.

### 2.2 Pillar 2: Live Sovereignty Proof (Air-Gap Verification)
- **Status**: **DECOUPLED FROM APP (External Demo Tooling)**.
- Per architecture decision, live network verification (5-host LAN allowlist, zero external request counter, and blocked outbound attempts) is handled by an independent sidecar / network monitoring tool displayed alongside the desktop app during evaluation.
- No in-app firewall, socket monitor, or custom UI widget is required inside the Electron application core.

### 2.3 Pillar 3: Grounded Agentic Deliverables (RAG & Tooling)
- **Requirement (`PRODUCT.md §6`, `PS.md §7`)**:
  - Grounding in local SOPs and specifications (`SOP-114`, `SOP-220`).
  - Production-grade deliverables (`.docx`, verified code, `.xlsx`, `.csv`, `.md`).
- **Current State**:
  - **Local RAG Implemented**: `vectra` vector store in `ai/rag/` and `RAGService` in `backend/src/main/rag/` support ingestion, reindexing, and semantic search.
  - **Grounding Provider Connected**: `RAGGroundingProvider` queries local SOP chunks and injects citation-backed context into `RunManager`.
  - **Deterministic SOP-114 Rule Engine**: `evaluateSOP114Findings` in `backend/src/main/grounding/sop114-engine.ts` dynamically evaluates wall thickness against 3.2mm limit, flags pitting corrosion, and marks unverified weld joint annotations as `UNKNOWN` requiring verification, appending exact `[SOP-114 §3.2]` citations.
  - **Binary Office Open XML (.docx) Generator**: `generateDocx()` in `backend/src/main/tools/artifacts.ts` builds genuine OpenXML binary Word documents with formal engineering letterhead, air-gap attestation banner, styled headings, data tables, and callouts.
  - **Excel Generation**: `generateXlsx()` in `backend/src/main/tools/artifacts.ts` converts Python tabular output to `.xlsx`.
- **Gaps**:
  - **Deterministic SOP-220 Spec Checker (Flow C)**: Need automated threshold checking for Flow C (`SOP-220 §4.2/4.3` valve rating Class 300 & pipe diameter DN100).
  - **Markdown Compliance Artifact Tool**: Need structured generation for `corrective-action-note.md` in Flow C.

---

## 3. Flow-by-Flow Gap Analysis

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FLOW A: Scanned Inspection Bundle -> SOP Grounding -> DOCX Note         │
│ Status: 100% COMPLETE (Ingestion, Fusion, SOP-114 Engine & DOCX Ready)  │
└─────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│ FLOW B: Vendor Log Script Repair -> Sandbox Execution -> Verified Output│
│ Status: 75% COMPLETE (Multi-Attachment Done; Traceback & Artifact WIP)  │
└─────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│ FLOW C: Engineering Drawing -> SOP-220 Spec Check -> Compliance Note    │
│ Status: 35% COMPLETE (Vision Engine Ready; SVG & Rule Check Pending)    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Flow A: Scanned Inspection Bundle -> Approval Note (Flagship Flow)

| Step | Expected Behavior (`DEMO.md §32-96`) | Current Implementation Status | Gap / Required Action |
| :--- | :--- | :--- | :--- |
| **1. Ingestion** | User drops bundle of two PDFs (`inspection-report-E201-annotated.pdf` + `inspection-report-E202-followup.pdf`). | **IMPLEMENTED**: `StartRunInput` accepts `attachmentTokens?: string[]`. Manager stages all attachments into `data/runs/<runId>/input/` and persists relations in `run_attachments`. | Fully functional. |
| **2. Routing** | Router selects Vision/OCR model with reason `scanned inspection bundle`. | **IMPLEMENTED**: `inspectAttachmentBundle` detects multi-PDF inspection bundle and routes to `vision`. | Fully functional. |
| **3. Plan Streaming** | Transcript streams: OCR pages, extract measurements/defects/handwriting, flag uncertain notes, check SOP-114, draft note, generate Word doc. | **IMPLEMENTED**: `RunManager` streams tool execution and plan steps (`ocr_inspection_bundle`, `fuse_findings`, `evaluate_sop114`, `draft_approval_note`). | Fully functional. |
| **4. OCR / Vision Execution** | Model processes scanned PDF pages, extracts tube thickness, pitting, gasket degradation, and handwritten annotation `"RECHECK WELD JOINT 4B"`. | **IMPLEMENTED**: `executeVisionTask` executes Tier 2 visual VLM stream with selective page slicing (`rankPagesByVisualDensity`) across all attached documents. | Fully functional. |
| **5. SOP-114 Grounding** | Compare findings with `sop-114-pressure-equipment-inspection.md`. Produce structured statuses: `fail` (< 3.2mm), `pass`, `unknown` (weld joint 4B). | **IMPLEMENTED**: `evaluateSOP114Findings` deterministically validates measurements against minimum wall thickness (3.2mm), evaluates pitting corrosion, flags unverified handwritten weld notes as `UNKNOWN`, and appends `[SOP-114 §3.2]` citations. | Fully functional. |
| **6. Drafting Route Switch** | Router dynamically switches to drafting model with reason `compose grounded approval note`. | **IMPLEMENTED**: `executeVisionTask` automatically chains into `executeChatTask` when draft requested in single turn. | Fully functional. |
| **7. Grounded Draft** | Draft contains evidence table, citation `[SOP-114 §3.2]`, corrective actions, and warning that approval authority is missing. | **IMPLEMENTED**: Chained drafting prompt includes evaluated findings table with citations, missing approval authority warning, and conditional clearance recommendation. | Fully functional. |
| **8. Confirmation & DOCX Tool** | User confirms document generation; creates `approval-note-<ENTITY>.docx` with letterhead, findings, handwritten evidence, and references. | **IMPLEMENTED**: `generateDocx` builds genuine OpenXML binary Word document with formal letterhead, air-gap governance banner, styled headings, data tables, inline formatting, and warning callouts. | Fully functional. |

---

### 3.2 Flow B: Vendor-Log Utility Repair & Verification

| Step | Expected Behavior (`DEMO.md §97-150`) | Current Implementation Status | Gap / Required Action |
| :--- | :--- | :--- | :--- |
| **1. Ingestion** | User uploads broken script (`broken-vendor-log-parser.py`) AND test data (`vendor-maintenance-log.csv`). | Only single attachment supported. `executeDataTask` expects CSV only. | Add multi-attachment support to accept both `.py` script and `.csv` data. |
| **2. Routing** | Router selects Code model with reason `Python repair and verification`. | Router classifies CSV or code prompts as `code`. | Update reason to explicitly reflect script diagnosis and repair. |
| **3. Plan & 1st Sandbox Run** | Run existing script in sandbox; visibly fail with traceback on blank temperature cell. | Currently calls model immediately to write fresh `task.py`. | Add initial execution step: stage uploaded `.py` script and run it to capture actual runtime traceback. |
| **4. Auto-Repair Loop** | Code model receives traceback, fixes blank cell and inclusive threshold (`val >= limit`), writes patch. | **IMPLEMENTED**: Iterative repair loop in `manager.ts` handles runtime errors and retries up to 3 times. | Feed the initial failure traceback into repair prompt. |
| **5. 2nd Sandbox Run** | Script executes successfully, outputs `ROWS 5; MALFORMED 1; ABOVE_LIMIT 1` and creates repaired CSV. | **IMPLEMENTED**: Sandboxed execution runs with timeout and exit code verification. | Ensure output regex parses row statistics. |
| **6. Deliverables** | Present repaired Python script (`repaired-parser.py`) AND verified output CSV as downloadable artifacts. | Only outputs `.xlsx`/`.csv`. Generated `.py` stays in `intermediate/`. | Register repaired Python script as official run artifact in `output/`. |

*(Blocked attempt demonstration is demonstrated via external monitor alongside app).*

---

### 3.3 Flow C: Engineering Drawing Cross-Check Against Piping SOP

| Step | Expected Behavior (`DEMO.md §151-204`) | Current Implementation Status | Gap / Required Action |
| :--- | :--- | :--- | :--- |
| **1. Ingestion** | User drops `pump-skid-P204.svg` and requests compliance check against piping spec. | Attachment handler does not rasterize or inspect SVG drawings. | Support `.svg` attachments, convert to raster or inspect vector nodes. |
| **2. Routing** | Router selects Vision-Reasoning model with reason `engineering drawing interpretation`. | No SVG drawing classification rule. | Add SVG drawing classification in `deterministic-router.ts`. |
| **3. Vision Interpretation** | Model extracts labels: `XV-204 Class 150` valve and `DN80` discharge line diameter. | Tier 2 visual pipeline ready, needs SVG prompt template. | Wire drawing inspection prompt template. |
| **4. SOP-220 Spec Check** | Compare against `piping-spec-SOP-220.md`: Class 150 < 300 (non-compliant) and DN80 < 100 (non-compliant). Cites `[SOP-220 §4.2]` and `[SOP-220 §4.3]`. | SOP-220 file available in demo fixtures; not yet queried. | Implement SOP-220 compliance checking rule evaluator. |
| **5. Deliverable** | Generate concise reviewer corrective-action note (`corrective-action-note.md`) stating drawing is NOT approved. | Markdown artifact helper not registered. | Generate Markdown compliance artifact and register in run artifact pane. |

*(Blocked attempt demonstration is demonstrated via external monitor alongside app).*

---

## 4. Architectural & Subsystem Gaps

### 4.1 Multi-Attachment Architecture (RESOLVED)
- **Status**: **IMPLEMENTED**.
- Added `run_attachments` join table in SQLite schema (`schema.sql`) and `store.ts`.
- Updated `IPC_RUN.START_RUN` validator to accept `attachmentTokens?: string[]`.
- `RunManager.start()` stages all attachments concurrently into `data/runs/<runId>/input/` and records references in SQLite.
- `inspectAttachmentBundle` routes multi-PDF bundles to `vision` and `.py` + `.csv` bundles to `code`.

### 4.2 Grounding Engine: SOP Evaluation Rules
- **SOP-114 Rule Engine (RESOLVED)**: `evaluateSOP114Findings` in `backend/src/main/grounding/sop114-engine.ts` dynamically evaluates wall thickness against 3.2mm limit, flags pitting corrosion, and marks unverified weld joint annotations as `UNKNOWN` with `[SOP-114 §3.2]` citations.
- **SOP-220 Spec Checker (REMAINING - Flow C)**: Needs automated rule evaluation for valve pressure ratings (Class 150 vs Class 300) and line sizes (DN80 vs DN100) with `[SOP-220 §4.2]` and `[SOP-220 §4.3]` citations.

### 4.3 Deliverable Generators (`.docx` & `.md`)
- **Binary `.docx` Word Document Generator (RESOLVED)**: `generateDocx()` in `backend/src/main/tools/artifacts.ts` builds genuine Office Open XML binary Word documents (PK zip header `0x50, 0x4B, 0x03, 0x04`) via `jszip` with styled letterhead, metadata grid, dark header findings tables, inline formatting, and warning callouts.
- **Markdown Compliance Artifact Tool (REMAINING - Flow C)**: Need structured generation for `corrective-action-note.md` in Flow C.

---

## 5. Updated Implementation Roadmap & Priority Matrix

| Phase | Component | Status | Tasks | Target Files |
| :---: | :--- | :---: | :--- | :--- |
| **Phase 1** | **Multi-Attachment Support** | **DONE** | 1. Update schema & IPC validators for `attachmentTokens?: string[]`.<br>2. Stage multiple input files in `data/runs/<runId>/input/`.<br>3. Implement bundle routing in `inspectAttachmentBundle`. | `backend/src/main/ipc/validators.ts`<br>`backend/src/main/run/manager.ts`<br>`backend/src/main/persistence/schema.sql` |
| **Phase 2** | **Flow A: SOP Grounding & Binary DOCX** | **DONE** | 1. Cross-document findings fusion without hardcoding.<br>2. SOP-114 rule evaluation logic (`sop114-engine.ts`).<br>3. Self-contained OpenXML binary `generateDocx()` tool with styled letterhead & tables. | `backend/src/main/grounding/sop114-engine.ts`<br>`backend/src/main/tools/artifacts.ts`<br>`backend/src/main/run/manager.ts` |
| **Phase 3** | **Flow B: Script Repair Alignment** | **IN PROGRESS** | 1. Sandboxed runner & auto-repair loop (DONE).<br>2. Ingest uploaded `.py` + `.csv` bundle.<br>3. Run uploaded script to capture runtime failure traceback.<br>4. Register repaired `.py` as official artifact in `output/`. | `backend/src/main/run/manager.ts`<br>`backend/src/main/tools/python.ts` |
| **Phase 4** | **Flow C: Drawing Compliance** | **TODO** | 1. Support `.svg` attachments in router & vision.<br>2. Implement SOP-220 compliance checking.<br>3. Generate `corrective-action-note.md` artifact. | `backend/src/main/router/`<br>`backend/src/main/grounding/`<br>`backend/src/main/run/manager.ts` |
| **Phase 5** | **Vision Architecture & Slicing** | **DONE** | 1. Direct `executeVisionTask` in `RunManager`.<br>2. Automatic Hybrid (Tier 1 text vs Tier 2 VLM).<br>3. Deterministic Visual Page Ranker (`rankPagesByVisualDensity`).<br>4. Single-turn vision -> draft chaining. | `backend/src/main/run/manager.ts`<br>`backend/src/main/run/images.ts`<br>`backend/tests/vision-run.test.ts` |
| **Phase 6** | **Local Project Harness** | **DONE** | 1. `HarnessManager` with workspace lifecycle.<br>2. `PathGuard` safe resolution (`resolveSafe`).<br>3. Scoped tools (`list_dir`, `read_file`, `search`, `write_file`, `run_command`). | `backend/src/main/harness/`<br>`backend/tests/harness-*.test.ts` |

---

## 6. Conclusion & Next Actionable Steps

With **Multi-Attachment Support** (Phase 1) and **Flow A: Cross-Document SOP-114 Grounding & Binary DOCX Deliverable** (Phase 2) 100% completed, tested, and verified:

Flow A is completely functional end-to-end:
- Multi-attachment ingestion stages inspection bundles concurrently.
- Intent classifier routes bundles to vision OCR.
- Tier 2 VLM stream extracts findings across multiple PDFs.
- Grounding engine fuses findings and evaluates them against `SOP-114 §3.2` without any hardcoded demo strings.
- Drafting model composes the structured approval note.
- Binary DOCX generator constructs a publication-grade Word document deliverable (`.docx`) upon confirmation.

The remaining priorities to achieve 100% demo readiness inside the application are:
1. **Flow B Script Ingestion & Traceback Alignment** (Phase 3): Ingest uploaded `.py` script, execute in sandbox to capture initial failure traceback, auto-repair, and register `repaired-parser.py` in `output/`.
2. **Flow C Drawing Compliance** (Phase 4): Ingest `.svg` drawing, evaluate against `SOP-220` piping rules, and output `corrective-action-note.md`.

