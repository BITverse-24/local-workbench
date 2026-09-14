# Sovereign Workbench - SIH 2026 Demo Playbook

## The judging story

Sovereign Workbench is an air-gapped workbench for sensitive industrial
knowledge work. Across all three flows, the independent sovereignty monitor
stays visible, the external-request count stays at zero, and a controlled
outbound attempt is shown as blocked. The product proves three things live:

1. The router chooses different models for genuinely different work.
2. The agent plans, acts, observes, and iterates instead of answering once.
3. Every result stays grounded in local evidence and produces a real,
   reviewable deliverable.

Reset the app between flows, but keep the sovereignty panel and monitor view
visible throughout the session.

## Shared demo rules

- Use only the fixed assets under `demo/flow_a`, `demo/flow_b`, and
  `demo/flow_c`.
- Start each run with the matching user request below.
- Let the transcript show the plan before tool execution.
- Narrate every route change and show the selected model capability.
- Require confirmation before document generation, code execution, or any
  other consequential action.
- Do not claim final approval when a flow produces a review finding or an
  unresolved condition.
- The network panel must show the five-host LAN allowlist, monitor-active
  state, external requests `0`, and the blocked-attempt record.

## Flow A - Scanned inspection bundle to approval note

### Persona and purpose

A refinery engineer has two slightly messy pressure-equipment reports,
including a handwritten field annotation. They need a plant-manager approval
note, but the note must preserve evidence and must not hide unresolved risks.

This is the direct PS example and the flagship flow.

### Assets

- `demo/flow_a/inspection-report-E201-annotated.pdf` - two-page scan with a
  handwritten-style note: “RECHECK WELD JOINT 4B”.
- `demo/flow_a/inspection-report-E202-followup.pdf` - second report in the
  uploaded bundle.
- `demo/flow_a/report-bundle.json` - fixed request and expected route.
- `demo/flow_a/expected-bundle-extraction.json` - handwriting and anomaly
  oracle.
- `demo/flow_a/expected-ocr.json` - structured finding/page-reference oracle.
- `demo/flow_a/sop-114-pressure-equipment-inspection.md` - local governing
  criteria.
- `demo/flow_a/expected-assessment.json` - evidence-to-criteria oracle.
- `demo/flow_a/expected-approval-note.json` - final document oracle.
- `demo/flow_a/sovereignty-proof.json` - expected monitor evidence.

### User request

> Read these inspection reports, pull out the key findings, and draft an
> approval note for the plant manager.

### Visible sequence

1. The user drops both PDFs into the workbench.
2. The router dispatches the task to the reasoning/drafting agent (`draft-qwen3`) with reason `inspection report review and drafting`.
3. The transcript streams the plan:
   - Invoke vision/OCR tool (`vision-qwen25vl`) to extract measurements, defects, and handwritten annotations across pages.
   - Flag uncertain handwriting for human verification.
   - Query governing SOP criteria dynamically via knowledge base (`retrieve_sop`).
   - Compare findings against local standards and evaluate compliance.
   - Draft a conditional approval note.
   - Generate a Word document after confirmation.
4. The agent executes the vision extraction tool (`ocr_extract`), displaying the tube-thickness finding, pitting finding, gasket degradation, and the handwritten “RECHECK WELD JOINT 4B” annotation with source page references.
5. The agent executes the grounding tool (`retrieve_sop`), retrieving the governing SOP clause and evaluating `fail`, `pass`, and `unknown` statuses dynamically rather than from hardcoded rules.
6. The drafting model synthesizes the grounded approval note containing the evidence table, exact citations, corrective actions, and a warning that approval authority is missing.
7. The user approves document generation via the confirmation modal.
8. The document tool creates the publication-grade Word deliverable (`.docx`) with formal letterhead, findings table, handwritten evidence, recommendation, and attestation block.

### Expected proof

- Multi-model orchestration: Reasoning agent (`draft-qwen3`) coordinates specialized tools (vision extraction via `vision-qwen25vl`, RAG grounding, and OpenXML `.docx` generation).
- Multimodal evidence: typed scan plus handwritten annotation preserved with real page references.
- Agent behavior: plan, vision tool call, dynamic criteria retrieval, evaluation, drafting, document generation.
- Grounding: `[SOP-114 §3.2]` cited beside the applicable evaluation findings.
- Safety: conditional clearance only; no unsupported final approval.
- Sovereignty: zero external requests and a recorded blocked attempt.

## Flow B - Repair and verify an internal vendor-log utility

### Persona and purpose

A PSU IT engineer owns a legacy parser used for vendor maintenance logs. It
crashes on malformed rows and mishandles an inclusive limit. The assistant
must fix the real utility and prove the repair in a sandbox.

### Assets

- `demo/flow_b/broken-vendor-log-parser.py` - deliberately broken starting
  script with two realistic defects.
- `demo/flow_b/vendor-maintenance-log.csv` - vendor input containing a blank
  sensor value and an exact-limit reading.
- `demo/flow_b/expected-repaired-output.csv` - verified repaired output.
- `demo/flow_b/expected-repair-trace.json` - expected failed run, repair, and
  successful verification trace.
- Existing `reactor-temperature-log.csv` and its oracles - regression fixture
  retained for the original data-analysis scenario.
- `demo/flow_b/sovereignty-proof.json` - expected monitor evidence.

### User request

> This is crashing on our vendor log files. Fix it and make sure it actually
> works.

### Visible sequence

1. The user uploads the broken script and vendor CSV.
2. The router selects the code-specialized model with reason `Python repair
   and verification`.
3. The agent displays a plan:
   - Inspect the parser and input schema.
   - Run the current script in the network-disabled sandbox.
   - Diagnose the failure from the actual traceback.
   - Patch malformed-row handling and the inclusive threshold.
   - Re-run the fixture and compare output rows.
4. The first sandbox run visibly fails on the blank temperature cell.
5. The code model receives the bounded error and performs repair iteration 1.
6. The second run succeeds with:
   `ROWS 5; MALFORMED 1; ABOVE_LIMIT 1`.
7. The artifact pane shows the repaired script and verified CSV output.
8. The final message explains both defects and cites the actual exit code and
   stdout rather than trusting the model's expected result.

### Expected proof

- Auto-routing: `code`, contrasted explicitly with Flow A.
- Agent behavior: execute, observe failure, repair, execute again.
- Sandbox proof: no network, bounded output, non-zero failure surfaced before
  the successful verification.
- Deliverable: repaired Python file plus output CSV.
- Sovereignty: zero external requests and a blocked package-download attempt.

## Flow C - Engineering drawing cross-check against piping SOP

### Persona and purpose

A design reviewer must check a pump-skid drawing before sign-off. The drawing
contains two non-obvious but intentional discrepancies: a Class 150 isolation
valve where Class 300 is required, and a DN80 discharge line where DN100 is
required.

This flow demonstrates multimodal reasoning without making every task produce
a large document.

### Assets

- `demo/flow_c/pump-skid-P204.svg` - labeled engineering drawing with the two
  discrepancies highlighted as drawing content, not as UI annotations.
- `demo/flow_c/piping-spec-SOP-220.md` - local piping specification.
- `demo/flow_c/expected-compliance-assessment.json` - expected observations,
  calculations, statuses, and citations.
- `demo/flow_c/corrective-action-note.md` - concise reviewer output.
- `demo/flow_c/sovereignty-proof.json` - expected monitor evidence.

### User request

> Check this against our piping spec and tell me if anything's non-compliant.

### Visible sequence

1. The user uploads the drawing (`pump-skid-P204.svg`).
2. The router dispatches the task to the reasoning/drafting agent (`draft-qwen3`) with reason `engineering drawing compliance review`.
3. The agent displays a plan:
   - Invoke visual extraction tool to read drawing identifiers, component tags, and dimensions.
   - Query governing specification dynamically from the local knowledge base (`retrieve_sop`).
   - Compare extracted parameters against retrieved criteria.
   - Draft reviewer corrective-action deliverable note (`corrective-action-note.md`).
4. The agent executes the visual extraction tool (`inspect_drawing`), identifying `XV-204 Class 150` and `DN80 discharge line` from the drawing.
5. The agent executes the grounding tool (`retrieve_sop`), querying the knowledge base and retrieving `[SOP-220 §4.2]` and `[SOP-220 §4.3]`.
6. The reasoning model compares observed values against the retrieved criteria (150 < 300 non-compliant, 80 < 100 non-compliant) dynamically without hardcoded logic.
7. The artifact pane renders the generated reviewer deliverable (`corrective-action-note.md`), explicitly stating the drawing is not approved and must be revised.

### Expected proof

- Multimodal tool execution: drawing components and labels extracted via visual tool and supplied directly to the reasoning agent.
- Dynamic RAG grounding: criteria retrieved from the local knowledge base and evaluated without hardcoded demo if-statements.
- Output range: concise markdown compliance note (`.md`) artifact rendered in the artifact previewer.
- Sovereignty: zero external requests and a blocked vendor-cloud attempt.

## Closing panel narration

After Flow C, show the combined run history: three different inputs, three
different model/tool paths, and the same sovereignty result. The product is
not one chatbot with a local prompt. It is a local workbench that routes,
acts, verifies, cites, and refuses to overclaim while sensitive industrial
data never leaves the approved LAN.
