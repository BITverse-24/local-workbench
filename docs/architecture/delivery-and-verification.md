# Delivery and Verification

## Build phases & architectural evolution

| Phase | Frontend | Backend | AI/ML | Verification Milestone |
| --- | --- | --- | --- | --- |
| 1–2: Foundation | Electron shell, preload bridge, transcript, chat list | Electron-main root, typed IPC handlers, SQLite WAL persistence, run directory layout | LAN model configuration, prompt definitions, fixture bundles | Models reachable on LAN /dev endpoints; SQLite migration & seed pass |
| 3–4: Core Specialist Flows | File drop, routing badge, confirmation modal, PDF viewer, artifact cards | Flow A (vision extract + DOCX/PDF generator) and Flow B (Python runner + log repair) | Vision extraction fine-tuning, citation grounding, script repair prompts | Flow A produces cited Word report; Flow B self-repairs failed script in sandbox |
| 5: Unified Agent Loop (v2) | Agent thinking display, live tool execution transcript, plan review gate | `AgentLoop`, `ToolDispatcher`, environment-aware `composeTools`, context compaction | Tool schemas, multi-turn reasoning prompts, cross-model delegation | Autonomous multi-turn tool calling without prompt-based routing hacks |
| 6: Workspace Harness & RAG | Workspace picker, file tree, Knowledge Base panel, Onboarding wizard | `HarnessManager`, `PathGuard`, local RAG service (`ChromaDB` / `Vectra`), custom model config | Local embeddings, clause chunker, vector retrieval against SOPs | Flow C drawing cross-check against retrieved `SOP-220`; path-contained workspace operations |

---

## Test fixtures and verification suites

Fixtures are stored under `demo/flow_a/`, `demo/flow_b/`, and `demo/flow_c/`:

- **Flow A Bundle**: Scanned pressure vessel inspection report PDF, handwritten NDT annotation, and governing `SOP-114`.
- **Flow B Bundle**: Failing vendor log parser `process_vendor_logs.py` and reactor CSV dataset.
- **Flow C Bundle**: Piping skid SVG schematic `pump-skid-P204.svg` and governing specification `SOP-220`.

### Preflight commands

1. **Verify Demo Fixture Integrity**:
   ```bash
   python3 demo/validate_fixtures.py
   ```
   *Asserts manifest hashes, SVG attributes, CSV schemas, and deterministic test oracles.*

2. **Run TypeScript Type Check**:
   ```bash
   npm run typecheck
   ```
   *Verifies backend, electron, and frontend subproject typings against shared contracts.*

3. **Run Unit and Integration Test Suites**:
   ```bash
   npm test
   ```
   *Executes backend, agent loop, RAG service, path guard, and tool dispatcher tests.*

---

## Acceptance checklist

### Architecture and security boundaries

- [ ] Electron main is the sole process exposing model, tool, filesystem, and persistence capabilities; renderer access is strictly limited to typed `workbenchBridge` IPC.
- [ ] PathGuard enforces `resolveSafe`: workspace harness tools (`list_dir`, `read_file`, `write_file`, `delete_file`, `search`, `run_command`) cannot escape the designated workspace directory.
- [ ] Model registry contains approved local/LAN endpoints; real-time health checks verify `/v1/models` availability.
- [ ] Air-gapped Python runner executes with network namespaces disabled (`--unshare-net`) and restricted input/output mount points.
- [ ] Consequential actions (destructive commands, script execution, official deliverable creation) trigger human-in-the-loop plan confirmation gates.
- [ ] No hardcoded demo data: all findings, citations, code repairs, and deliverables are dynamically produced from input files.

### Product proof points

- [ ] **Flow A (Inspection Report)**: Emits `vision` routing, extracts findings (including field notes), queries `SOP-114`, and generates a formal `.docx` decision packet with explicit withholding when secondary verification is flagged.
- [ ] **Flow B (Script Self-Repair)**: Emits `code` routing, observes initial runtime crash in sandbox, diagnoses traceback, self-corrects the code, re-runs verification, and outputs repaired script + verified CSV.
- [ ] **Flow C (Drawing Compliance Audit)**: Emits `vision` routing, extracts valve and pipe parameters, queries local ChromaDB RAG for `SOP-220`, identifies discrepancies, and generates a structured `corrective-action-note.md` deliverable with `NOT APPROVED` status.
- [ ] **Sovereignty**: Telemetry panel and external firewall monitor confirm **0 external HTTP requests** across all operations.

---

## Rehearsal protocol

1. Boot all hosts on the private LAN; start model servers (`mlx_lm.server`, `llama-server`, or `ollama`).
2. Launch Sovereign Workbench (`npm run dev` or packaged app).
3. Confirm green health status in the Service Health settings panel.
4. Verify SOP documents (`SOP-114`, `SOP-220`) are present in the Knowledge Base panel (or ingest them via `＋ Add`).
5. Execute Flow A: attach inspection bundle, prompt approval review, approve `.docx` generation, and inspect the preview.
6. Execute Flow B: attach broken script + CSV, prompt repair, approve execution, and inspect verified output.
7. Execute Flow C: attach SVG schematic, prompt compliance review, and inspect the corrective action note.
8. Verify independent monitor log records zero external packets.
