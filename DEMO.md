# Sovereign Workbench — SIH 2026 Demo Playbook & Script

> **Purpose of this document**: Step-by-step, click-by-click operational guide for running and demonstrating the three canonical evaluation flows (**Flow A**, **Flow B**, **Flow C**) of Sovereign Workbench for evaluators, PSU engineers, and industrial judges.
>
> Follow these instructions to reproduce deterministic model routing, multi-step agentic planning and repair loops, human-in-the-loop safety confirmation gates, local RAG evidence grounding, and verifiable air-gapped zero-egress operation.

---

## Table of Contents

1. [The Judging Story & Core Value Proposition](#1-the-judging-story--core-value-proposition)
2. [Pre-Demo Setup & Environment Preflight](#2-pre-demo-setup--environment-preflight)
3. [User Interface Anatomy & Panel Overview](#3-user-interface-anatomy--panel-overview)
4. [Flow A — Scanned Inspection Bundle to Formal Approval Note (.docx)](#4-flow-a--scanned-inspection-bundle-to-formal-approval-note-docx)
5. [Flow B — Repair & Verify Internal Vendor-Log Utility (Python Sandbox)](#5-flow-b--repair--verify-internal-vendor-log-utility-python-sandbox)
6. [Flow C — Engineering Drawing Cross-Check Against Piping SOP (Visual & RAG)](#6-flow-c--engineering-drawing-cross-check-against-piping-sop-visual--rag)
7. [Closing Synthesis & Judge Q&A Guide](#7-closing-synthesis--judge-qa-guide)

---

## 1. The Judging Story & Core Value Proposition

**Sovereign Workbench** is a self-hosted, air-gapped agentic desktop workbench engineered for sensitive industrial, PSU, and defence engineering facilities (refineries, power stations, heavy engineering plants).

Across all three flows, the application demonstrates three foundational capabilities live:

1. **Intelligent, Verifiable Multi-Model Routing**:
   The orchestrator dynamically routes tasks to specialized local models (`vision-qwen25vl` for multimodal document/drawing extraction, `draft-qwen3` for grounded reasoning and drafting, `code-qwen25coder` for code generation and sandbox repair) based on media types, syntactic intent, and workspace constraints.
2. **Multi-Step Agency with Self-Correction**:
   The agent does not simply generate an unchecked completion in a single turn. It emits an observable execution plan, invokes specialized sandboxed tools, observes errors (e.g., Python runtime tracebacks), performs automated self-repair iterations, and pauses for human confirmation before executing sensitive actions or generating official files.
3. **Rigorous Local Grounding & Verifiable Deliverables**:
   Every finding is strictly anchored to local evidence (real page citations, extracted measurements, bounding criteria from local SOPs via ChromaDB RAG). The system explicitly refuses to overclaim or grant final clearance when discrepancies exist, producing publication-grade deliverables (`.docx`, `.csv`, `.md`).
4. **Air-Gapped Sovereignty**:
   All operations run locally with **0 external HTTP requests**, enforced by sandbox boundaries and verified in the live telemetry panel.

---

## 2. Pre-Demo Setup & Environment Preflight

### 2.1 Starting the Application

Open a terminal in the project root directory and start the development environment:

```bash
# 1. Start full desktop application (Vite frontend + Electron shell)
npm run dev
```

*Alternative (if running frontend and Electron separately):*
```bash
npm run dev:frontend   # In terminal 1 (starts Vite server on http://localhost:5173)
npm run dev:electron   # In terminal 2 (starts Electron pointing to dev server)
```

### 2.2 Offline Fixture Validation Preflight

Before presenting to judges, verify all demo fixtures, CSV schemas, and expected oracles by running the offline validator:

```bash
python3 demo/validate_fixtures.py
```
**Expected Output**:
```text
Fixture preflight passed: Flow A, Flow B, and Flow C are deterministic and internally consistent.
```

### 2.3 Knowledge Base (SOP) Ingestion Preflight

To enable dynamic RAG grounding for Flows A and C:

1. Look at the **Right Sidebar** under **Knowledge (SOP)**.
2. Check if the following standards are listed:
   - `SOP-114` (*Pressure Equipment Inspection and Approval*)
   - `SOP-220` (*Piping and Valve Design Review*)
3. **If either standard is missing**:
   - In the **Knowledge (SOP)** panel header, click the **`＋ Add`** button.
   - File picker opens -> navigate to `demo/flow_a/sop-114-pressure-equipment-inspection.md` -> Click **Open**. Notice the clause count update.
   - Click **`＋ Add`** again -> navigate to `demo/flow_c/piping-spec-SOP-220.md` -> Click **Open**. Notice both standards are now indexed.
   - *(Optional verification)*: Click **Test query** inside the Knowledge panel, type `Class 300` or `tube wall`, and click **Run** to confirm instant local clause retrieval.

---

## 3. User Interface Anatomy & Panel Overview

Familiarize yourself with the key regions of the desktop UI:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ TITLEBAR: [Sovereign Workbench] [Air-gapped · zero egress] [Dev: OpenRouter OFF] │
├───────────────┬──────────────────────────────────────────────────┬───────────────┤
│ EXPLORER      │ CHAT & DELIVERABLE STREAM                        │ SETTINGS      │
│ (Left Sidebar)│                                                  │ (Right Panel) │
│               │ - Active Route Badge (TaskType → ModelId)        │               │
│ - Chats list  │ - Plan Steps & Tool Execution Transcript         │ - Service     │
│   (+ New Chat)│ - Interactive Artifact Cards (.docx, .csv, .md)  │   Health      │
│ - Workspace   │ - Assistant Grounded Summary                     │ - Model Route │
│   Folder Tree ├──────────────────────────────────────────────────┤ - Knowledge   │
│               │ INPUT BAR:                                       │   (SOP RAG)   │
│               │ [📎 Attach] [📖 Grounding ON/OFF] [Prompt...] [Send]│ - Run Logs  │
└───────────────┴──────────────────────────────────────────────────┴───────────────┘
```

- **TitleBar**:
  - **Status Pill**: Shows `Air-gapped · zero egress` with a green indicator dot.
  - **Dev Toggle**: Shows `Dev: OpenRouter [OFF]` (for production/local DB routing) or `[ON]` (when testing with cloud keys). For official air-gapped demo runs, keep this `[OFF]` or as configured by the testing environment.
- **Left Sidebar (Explorer)**:
  - **Chats Panel**: Lists conversation history. Has the **`+ New`** button to clear the state and create an isolated run between flows.
  - **Files Panel**: Shows registered workspace files and directory tree when a local harness folder is mounted.
- **Center Chat & Deliverable Stream**:
  - Displays user prompts, attachment pills with icons, live waiting indicators, step-by-step tool traces, approval request modals, and expandable artifact previewers.
- **Input Bar**:
  - **`📎` (Attach Button)**: Multi-file picker accepting PDF, images, CSV, code, markdown, etc.
  - **`Grounding` Toggle Button**: Highlights accent green when local SOP grounding is active.
  - **Textarea**: Auto-resizing input box. Supports `Enter` to submit, `Shift + Enter` for newlines.
  - **`Send` Button**: Triggers run execution.
- **Right Sidebar (Settings & Diagnostics)**:
  - **Service Health**: Real-time connectivity and latency for local model backends (`vision-qwen25vl`, `draft-qwen3`, `code-qwen25coder`).
  - **Model Route Preference**: Displays locked model route once a run begins.
  - **Knowledge (SOP)**: Ingestion management and semantic search tester.
  - **Run Diagnostics**: Clickable cards for **Run transcript**, **Model trace**, and **Per-request files**.

---

## 4. Flow A — Scanned Inspection Bundle to Formal Approval Note (.docx)

### 4.1 Persona, Operational Context & Objective
- **Persona**: Senior Plant Reliability Engineer at an oil refinery.
- **Scenario**: The engineer has two field inspection reports for heat exchanger `E-201`, including typed ultrasound wall-thickness scans, pitting measurements, and a handwritten annotation from the field inspector: *"RECHECK WELD JOINT 4B"*.
- **Goal**: Read both reports, synthesize the findings across documents, query local safety standard `SOP-114 §3.2`, formulate a grounded conditional approval note, and generate an official publication-grade Word deliverable (`.docx`) without concealing unresolved field risks.

### 4.2 Exact Input Files
Located in `demo/flow_a/`:
1. `demo/flow_a/inspection-report-E201-annotated.pdf` *(Two-page scan with typed findings and handwritten note)*
2. `demo/flow_a/inspection-report-E202-followup.pdf` *(Follow-up inspection report in the bundle)*

---

### 4.3 Step-by-Step Click & Input Instructions

#### Step 1: Start a Fresh Chat Session
- Click the **`+ New`** button at the top of the **Chats** panel in the Left Sidebar.
- The center stream will reset and display `Air-gapped workspace ready.`

#### Step 2: Attach the Inspection Reports
- In the bottom **InputBar**, click the **`📎` (Paperclip)** button.
  *(Alternatively: drag and drop both PDF files directly onto the chat area).*
- In the OS file dialog:
  - Navigate to: `<repository_root>/demo/flow_a/`
  - Select both `inspection-report-E201-annotated.pdf` and `inspection-report-E202-followup.pdf` (hold `Ctrl` or `Cmd` to select both).
  - Click **Open**.
- **Verify UI State**:
  - Two attachment chips appear above the prompt box:
    - `inspection-report-E201-annotated.pdf • PDF`
    - `inspection-report-E202-followup.pdf • PDF`
  - Ensure the **`Grounding`** pill button is active (accent highlight with green indicator dot).

#### Step 3: Enter the User Prompt
- Click inside the **InputBar** textarea and paste the exact prompt:

```text
Read these inspection reports, pull out the key findings, and draft an approval note for the plant manager.
```

#### Step 4: Submit the Run
- Click the **`Send`** button (or press `Enter` without `Shift`).

---

### 4.4 What Judges & Evaluators Will Observe Live

1. **Deterministic Intent Classification & Routing**:
   - The router analyzes the multi-PDF bundle and drafting request.
   - The active route is locked to:
     - **Task**: `vision` → `draft`
     - **Models**: `vision-qwen25vl` (multimodal extraction) chained to `draft-qwen3` (grounded reasoning).
     - **Reason**: `scanned inspection bundle` / `compose grounded approval note`.
   - The Right Sidebar highlights the locked route under **Model route (locked during run)**.

2. **Live Plan Streaming**:
   - The **RunWaitingIndicator** in the center area displays the execution plan:
     - `▣ Analyze and extract findings across 2 attached documents`
     - `▣ Extract measurements, defects, and handwritten annotations`
     - `▣ Compare findings with governing compliance criteria and standards`
     - `▣ Draft grounded engineering summary with evidence and recommendations`
     - `▣ Generate deliverable document upon user confirmation`

3. **Multi-Step Tool Execution**:
   - `▶ read_file`: Extracts content from both uploaded PDF files.
   - `▶ vision extraction (vision-qwen25vl)`: Discovers:
     - Minimum tube wall thickness: `2.1 mm` (threshold `2.5 mm` → below allowable limit).
     - Localized pitting detected on bundle tubes.
     - Shell gasket degradation.
     - Handwritten inspector note: **`"RECHECK WELD JOINT 4B"`** on page 1.
   - `▶ retrieve_sop`: Queries the local knowledge base for `SOP-114 §3.2`.
   - `▶ draft_note (draft-qwen3)`: Synthesizes a structured conditional clearance note citing `[SOP-114 §3.2]`.

4. **Human-in-the-Loop Confirmation Gate (Consequential Action)**:
   - Execution pauses automatically. The **ConfirmationModal** appears on screen:
     - **Badge**: `Word document generation`
     - **Prompt Title**: `Generate the approval-note DOCX (approval-note-E201.docx)?`
     - **Description**: *"This action requires your confirmation before the workbench creates official deliverables in the run directory."*
     - **Countdown Timer**: Displays remaining validity window (e.g., `4:59 remaining`).
   - **User Action**: Click **`Approve & generate`** (or press `Enter`).

5. **Deliverable Generation & Grounded Chat Response**:
   - The modal closes, and the document generation tool builds the OpenXML `.docx` file.
   - **Assistant Message Appears**:
     - **Header**: Pressure Equipment Inspection Review — `E-201`.
     - **Findings Table**: Lists measured values with explicit source citations (`inspection-report-E201-annotated.pdf, p.1`, `inspection-report-E202-followup.pdf, p.2`).
     - **Handwritten Anomaly**: Flagged explicitly: `⚠️ "RECHECK WELD JOINT 4B" — Manual verification required`.
     - **Governing Standard**: Cites `[SOP-114 §3.2]` alongside tube wall criteria.
     - **Recommendation**: **Conditional clearance only** (subject to retubing and gasket replacement).
     - **Critical Safety Caveat**: Explicitly states that final approval **cannot be granted** until weld joint 4B has been verified by an authorized inspector.
   - **Artifact Card Rendered**:
     - Displays `Word` badge, `approval-note-E201.docx`, and size (~15–25 KB).
     - Action buttons: Click **`Copy`** to copy to clipboard, or click **`Save as`** to export the native `.docx` file to any local folder.

#### Step 5: Verify Diagnostics & Sovereignty Proof
- In the **Right Sidebar**, scroll down to **Run diagnostics**:
  - Click **`Run transcript (⤢)`**: Opens full trace showing each step (`routing`, `plan_step`, `tool_call`, `confirmation_required`, `artifact_ready`). Click `✕` to close.
  - Click **`Model trace (⤢)`**: Inspect the raw request and response JSON. Point out the zero latency from external clouds and local execution.
  - Notice the TitleBar shows `Air-gapped · zero egress` throughout.

---

## 5. Flow B — Repair & Verify Internal Vendor-Log Utility (Python Sandbox)

### 5.1 Persona, Operational Context & Objective
- **Persona**: PSU Maintenance Software Engineer.
- **Scenario**: An existing legacy Python utility (`broken-vendor-log-parser.py`) is used to parse temperature log files received from maintenance vendors (`vendor-maintenance-log.csv`). The script is currently failing in production because:
  1. Vendor logs occasionally have empty sensor cells, causing `float(row["temperature_c"])` to crash with a `ValueError`.
  2. The script uses an exclusive `>` threshold instead of the vendor's agreed inclusive `>= 350.0°C` limit.
- **Goal**: The engineer uploads the broken script and vendor CSV. The assistant must run the script in a network-disabled sandbox, observe the actual traceback, diagnose the defect, rewrite the code, re-verify it inside the sandbox until it achieves exit code 0, and output the repaired script and verified CSV.

### 5.2 Exact Input Files
Located in `demo/flow_b/`:
1. `demo/flow_b/broken-vendor-log-parser.py` *(Deliberately broken starting script)*
2. `demo/flow_b/vendor-maintenance-log.csv` *(Sample vendor maintenance log containing blank cell and exact 350.0 reading)*

---

### 5.3 Step-by-Step Click & Input Instructions

#### Step 1: Start a Fresh Chat Session
- Click the **`+ New`** button in the Left Sidebar to start a new chat.

#### Step 2: Attach the Python Script and Sample CSV
- Click the **`📎` (Paperclip)** button in the **InputBar**.
- In the file dialog:
  - Navigate to: `<repository_root>/demo/flow_b/`
  - Select both `broken-vendor-log-parser.py` and `vendor-maintenance-log.csv`.
  - Click **Open**.
- **Verify UI State**:
  - Attachment chips appear:
    - `broken-vendor-log-parser.py • PY`
    - `vendor-maintenance-log.csv • SHEET`

#### Step 3: Enter the User Prompt
- Click the textarea and type:

```text
This is crashing on our vendor log files. Fix it and make sure it actually works.
```

#### Step 4: Submit the Run
- Click **`Send`** (or press `Enter`).

---

### 5.4 What Judges & Evaluators Will Observe Live

1. **Auto-Routing to Code Specialization**:
   - The router analyzes the `.py` script and `.csv` input with crash keywords.
   - Dispatches to **Task**: `code`, **Model**: `code-qwen25coder`.
   - **Reason**: `Python repair and verification`.
   - Contrast this explicitly with Flow A: *The system selected the code-specialized model for executable script debugging rather than a general chatbot.*

2. **Sandbox Safety Confirmation Gate**:
   - The **ConfirmationModal** appears immediately:
     - **Badge**: `Python sandbox execution`
     - **Title**: `Execute task.py in sandbox?`
     - **Code Preview Viewport**: Displays the full syntax-highlighted source of `broken-vendor-log-parser.py` with line numbers.
     - **Security Footer**: `Sandboxed execution: zero network egress • read-only inputs • run-scoped output directory • 60s timeout`.
   - **User Action**: Click **`Approve & execute script`** (or press `Enter`).

3. **Autonomous Execution, Failure Observation & Self-Repair Loop**:
   - **Run 1 (Initial Execution)**:
     - The sandbox runs the script: `python task.py vendor-maintenance-log.csv`.
     - The process fails with **Exit Code 1**:
       ```text
       ValueError: could not convert string to float: ''
       ```
     - The backend logs the failure and feeds the actual traceback into the code model.
   - **Tool Call**: `draft_code: repairing Python script (attempt 1): could not convert string to float...`
   - **Run 2 (Automated Verification)**:
     - The code model patches both defects:
       - Adds safety check for empty/whitespace temperature values (`if not val: counts["malformed"] += 1`).
       - Corrects boundary condition to inclusive (`>= 350.0`).
     - The backend re-runs the repaired code in the sandbox.
     - **Exit Code 0** achieved!
     - Output captured from stdout: `ROWS 5; MALFORMED 1; ABOVE_LIMIT 1`.

4. **Deliverables in Chat & Artifact Preview**:
   - **Assistant Message Summary**:
     - Explains the two bugs identified:
       1. *Unchecked float cast on empty sensor row (Row 3, sensor_gap).*
       2. *Strict inequality threshold rejecting exact 350.0 limit value.*
     - Cites the verified execution metrics from actual sandbox execution:
       - Total rows processed: `5`
       - Malformed rows handled: `1`
       - Above-limit rows flagged: `1`
       - Sandbox exit code: `0`
   - **Artifact Cards**:
     - `repaired-broken-vendor-log-parser.py`: Click **`Expand`** to review the clean, commented repaired code with line numbers. Click **`Copy`** to copy the script.
     - `repaired-vendor-log.csv` (or summary): Click **`Expand`** -> Toggle between **`Table View`** (renders formatted table with status column) and **`Raw Code`**.

5. **Diagnostic Verification**:
   - In Right Sidebar -> **Run diagnostics** -> Click **`Model trace (⤢)`**.
   - Show judges the trace entry with phase `http_response` followed by `parsed_json` and `execution_results`. Note that no external Python packages were pulled from the internet.

---

## 6. Flow C — Engineering Drawing Cross-Check Against Piping SOP (Visual & RAG)

### 6.1 Persona, Operational Context & Objective
- **Persona**: Lead Piping & Instrumentation Design Reviewer.
- **Scenario**: A pump-skid P&ID drawing (`PID-P204-REV-C`) has been submitted for pre-commissioning sign-off. The drawing contains two intentional engineering discrepancies:
  1. Isolation valve `XV-204` is labeled **Class 150**, but hydrocarbon service on pump P-204 discharge requires **Class 300 minimum**.
  2. The discharge line is labeled **DN80**, but the duty rating requires **DN100 minimum**.
- **Goal**: Upload the drawing SVG. The assistant must invoke visual extraction to parse component tags and ratings, dynamically retrieve governing criteria from `SOP-220` via ChromaDB RAG, cross-check observed values against retrieved limits, formulate a technical reviewer finding, and emit a concise markdown deliverable (`corrective-action-note.md`) declaring that approval is withheld.

### 6.2 Exact Input Files
Located in `demo/flow_c/`:
1. `demo/flow_c/pump-skid-P204.svg` *(P&ID engineering drawing with embedded component labels)*
2. Governing Standard: `demo/flow_c/piping-spec-SOP-220.md` *(Pre-indexed in Knowledge Base, or attached alongside)*

---

### 6.3 Step-by-Step Click & Input Instructions

#### Step 1: Start a Fresh Chat Session
- Click the **`+ New`** button in the Left Sidebar.

#### Step 2: Verify Governing Standard in Knowledge Base
- In the **Right Sidebar**, glance at **Knowledge (SOP)**:
  - If `SOP-220` is listed, proceed to Step 3.
  - If not, click **`＋ Add`** in the Knowledge panel, select `demo/flow_c/piping-spec-SOP-220.md`, and verify indexing.
  *(Optional: You can also attach `piping-spec-SOP-220.md` directly into the chat alongside the SVG).*

#### Step 3: Attach the Drawing SVG
- Click the **`📎` (Paperclip)** button in the **InputBar**.
- In the file dialog:
  - Navigate to: `<repository_root>/demo/flow_c/`
  - Select `pump-skid-P204.svg`.
  - Click **Open**.
- **Verify UI State**:
  - Attachment chip appears:
    - `pump-skid-P204.svg • IMAGE`
  - Confirm the **`Grounding`** pill button is active.

#### Step 4: Enter the User Prompt
- In the textarea, type:

```text
Check this against our piping spec and tell me if anything's non-compliant.
```

#### Step 5: Submit the Run
- Click **`Send`** (or press `Enter`).

---

### 6.4 What Judges & Evaluators Will Observe Live

1. **Intent Classification & Multimodal Routing**:
   - The router detects an SVG engineering drawing combined with compliance verification keywords.
   - Routes to:
     - **Task**: `draft` (orchestrated with visual inspection)
     - **Model**: `draft-qwen3` (utilizing `vision-qwen25vl` extraction)
     - **Reason**: `engineering drawing compliance review`.

2. **Live Plan & Tool Progression**:
   - The waiting indicator streams:
     - `▣ Read drawing identifiers and labels`
     - `▣ Extract valve class and line diameter`
     - `▣ Compare each value with governing specification`
     - `▣ Show the numeric mismatch and corrective action`
   - Tool calls executed:
     - `▶ inspect_drawing`: Analyzes `pump-skid-P204.svg`, identifying drawing `PID-P204-REV-C`, isolation valve `XV-204 Class 150`, and discharge line `DN80`.
     - `▶ retrieve_sop`: Queries local vector storage for `SOP-220`. Retrieves `[SOP-220 §4.2]` (valve rating) and `[SOP-220 §4.3]` (line diameter).
     - `▶ draft_note`: Evaluates observed parameters against retrieved requirements:
       - `XV-204`: 150 < 300 → `NON-COMPLIANT`.
       - `Discharge line`: 80 < 100 → `NON-COMPLIANT`.

3. **Grounded Compliance Evaluation in Chat**:
   - Assistant displays a clean, high-impact review summary:
     - **Drawing Title**: `PID-P204-REV-C`
     - **Banner**: `Status: NOT APPROVED (Revisions Required)`
     - **Compliance Table**:
       | Parameter | Observed Drawing Value | Governing Requirement | Compliance Status | Citation | Engineering Reasoning |
       | :--- | :--- | :--- | :--- | :--- | :--- |
       | **Isolation Valve XV-204** | Class 150 | Class 300 minimum | `NON-COMPLIANT` | `[SOP-220 §4.2]` | 150 is below the required minimum rating of 300. |
       | **Discharge Line Diameter** | DN80 | DN100 minimum | `NON-COMPLIANT` | `[SOP-220 §4.3]` | 80 is below the required minimum nominal diameter of 100. |
     - **Corrective Actions Required Before Sign-Off**:
       1. Replace isolation valve `XV-204` with a minimum Class 300 rated valve per `[SOP-220 §4.2]`.
       2. Upsize pump discharge line from DN80 to DN100 or larger per `[SOP-220 §4.3]`.
     - **Safety Notice**: Emphasizes that this review is an engineering finding, not an authorization, and drawing release is withheld pending revision.

4. **Markdown Deliverable Artifact Card**:
   - Artifact card renders: `Markdown` badge, `corrective-action-note.md`.
   - Click **`Expand`**:
     - Toggle between **`Markdown`** (formatted typography) and **`Raw Code`** (markdown syntax).
     - Notice table styling with colored `NON-COMPLIANT` status badges.
     - Click **`Save as`** to export the note.

5. **Diagnostic Verification**:
   - Open **Run diagnostics** -> Click **`Run transcript (⤢)`** to show that criteria were retrieved dynamically via `retrieve_sop` rather than hardcoded logic.

---

## 7. Closing Synthesis & Judge Q&A Guide

### 7.1 Five-Minute Judge Walkthrough Summary Table

When concluding your demo presentation, summarize the three flows using this matrix:

| Evaluation Dimension | Flow A (Flagship PS) | Flow B (Tool Repair) | Flow C (Drawing Audit) |
| :--- | :--- | :--- | :--- |
| **Domain** | Refinery Pressure Equipment | PSU Software Maintenance | Piping & Skid Engineering |
| **Input Modality** | Multi-page scanned PDF bundle | Broken Python script + CSV log | SVG vector schematic |
| **Route / Model** | `vision-qwen25vl` → `draft-qwen3` | `code-qwen25coder` | `vision-qwen25vl` → `draft-qwen3` |
| **Agentic Loop** | Extract → Ground → Draft → Confirm | Execute → Crash → Diagnose → Repair → Re-verify | Visual Extract → RAG Query → Evaluate → Note |
| **Safety Gate** | Consequential `.docx` generation approval | Sandbox execution confirmation | Refusal to sign off on non-compliant drawing |
| **Grounding Source** | Local `SOP-114 §3.2` | Sandbox exit code & stdout | ChromaDB vector RAG `SOP-220` |
| **Final Deliverable**| Formal Word report (`.docx`) | Repaired `.py` script + verified CSV | Corrective action memo (`.md`) |
| **External Egress** | **0 requests (Air-gapped)** | **0 requests (Air-gapped)** | **0 requests (Air-gapped)** |

---

### 7.2 Answering Common Judge Questions

- **Q: "Is this just calling a generic LLM with a system prompt?"**
  - *Answer*: "No. Notice that three distinct models were routed based on workload (`vision-qwen25vl`, `code-qwen25coder`, `draft-qwen3`). The orchestration is governed by deterministic routers, local vector databases, a sandboxed Python execution engine with bounded error feedback, and an IPC containment harness. A single prompt to a cloud LLM cannot execute Python locally, repair syntax errors from actual tracebacks, or guarantee zero data egress."

- **Q: "How do you guarantee that sensitive defence/PSU data doesn't leak?"**
  - *Answer*: "The desktop shell runs air-gapped on Electron. All model endpoints point to local instances (such as `mlx-lm`, `llama-server`, or LAN model nodes). The sandbox disables network interfaces, and our path-guard restricts file operations strictly to the run directory. The telemetry widget monitors all socket requests in real time."

- **Q: "What happens if a handwritten note is ambiguous or unreadable?"**
  - *Answer*: "As shown in Flow A with *'RECHECK WELD JOINT 4B'*, the system flags uncertain or handwritten annotations as `manual verification recommended` and explicitly withholds unconditional approval, citing the missing inspection authority."
