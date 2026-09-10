# Demo Requirements (Locked)

Locked 2026-09-03 for the MVP build (TASKS.md 1a, owner: Supreet). Sources:
`PRODUCT.md`, `PS.md`, `TASKS.md`, `docs/architecture/`. This is the one
canonical description of the two fixed demos; every workstream builds toward
exactly these inputs, outputs, screens, and evidence.

## Fixed demo inputs

Fixtures live in `demo-fixtures/` in the application repo and are installed
into the offline demo bundle before the air-gapped rehearsal. The SOP below
is the governing local source for Flow A. The template is a fixed output
shape, not a retrieval oracle.

| File | Used by | Description |
| --- | --- | --- |
| `demo-fixtures/flow-a/inspection-report-E201.pdf` | Flow A | Two-page clean typed scan: "Heat Exchanger E-201 Tube Bundle Inspection Report", fixed report ID/date, unit R-100 |
| `demo-fixtures/flow-a/sop-114-pressure-equipment-inspection.md` | Flow A | SOP-114 "Pressure Equipment Inspection and Approval" with stable section IDs, including §3.2 approval criteria |
| `demo-fixtures/flow-a/approval-note-template-TPL-012.md` | Flow A | Fixed approval-note output structure with stable section IDs |
| `demo-fixtures/flow-a/expected-assessment.json` | Flow A | Evidence-to-criteria decision oracle with pass/fail/unknown statuses |
| `demo-fixtures/flow-b/reactor-temperature-log.csv` | Flow B | 240 data rows, columns `timestamp,reactor_id,temperature_c`, reactor R-101, limits 250.0–350.0 °C |

The CSV is generated to match the expected result table below exactly
(task 8a). No improvised or live inputs are in the acceptance scope.

## Flow A — exact story (drop report → approval-readiness decision packet)

1. Presenter drops `inspection-report-E201.pdf` into the file-drop area and
   sends the fixed request: "Draft the approval note for this inspection
   report."
2. Transcript shows the run entering `classifying`; the routing badge changes
   to `vision` — Qwen2.5-VL, reason "scanned report" (routing event 1).
3. `ocr_extract` appears as tool call + result: extracted text summary and the
   three findings with page references (table below).
4. `assess_against_sop` appears as tool call + result: local governing
   criteria are applied to each finding and produce `pass`, `fail`, or
   `unknown`, with a required action and `[SOP-114 §3.2]` citation.
5. Routing badge changes to `draft` — Qwen3, reason "compose approval note"
   (routing event 2).
6. `draft_note` produces a decision packet containing the evidence matrix,
   conditional recommendation, missing-information warning, and citation.
7. Confirmation dialog: "Generate the approval-readiness decision packet?" with Approve /
   Reject. Unanswered confirmations expire after five minutes.
8. On approve, `generate_docx` runs locally; the artifact pane shows the PDF
   preview and the DOCX as downloadable. Run state reaches `completed`.
9. Presenter opens the PDF preview and shows the evidence matrix, conditional
   recommendation, explicit unknown approval status, and grounding reference.
10. The sovereignty panel is visible throughout: five approved LAN hosts,
    external-request counter at 0, monitor-active indicator.

Visible failure behaviour: rejecting (or expiring) the confirmation cancels
the document action; an unsupported criterion citation or missing governing
criteria fails the run before any document is created. The full flow must
complete within three minutes on finals hardware.

## Flow B — exact story (drop CSV → verified result)

1. Presenter drops `reactor-temperature-log.csv` with the fixed request:
   "Flag out-of-range readings in this CSV and generate a summary
   spreadsheet."
2. Routing badge changes to `code` — Qwen2.5-Coder, reason "CSV/code intent"
   (routing event).
3. `read_file` inspects the attachment metadata; plan steps stream to the
   transcript.
4. `draft_code` returns `task.py`; the transcript shows the source or a
   concise script summary. The code model never supplies shell arguments.
5. Confirmation dialog: "Execute the generated Python?" with Approve /
   Reject.
6. On approve, the Bubblewrap runner executes `task.py` with read-only input,
   run-scoped writable output, and no network, under a 60-second timeout.
   The transcript shows exit code `0` and the stdout summary
   `OUT_OF_RANGE 7/240 (high=5, low=2)`.
7. `generate_xlsx` is proposed from the validated result rows; a second
   confirmation dialog appears; on approve `out-of-range-summary.xlsx`
   appears in the artifact pane.
8. A final code-model step summarises the verified result using the actual
   execution output and exit code. Run state reaches `completed`.

A timeout or non-zero exit is presented as a failed verification, never as a
successful calculation. The full flow must complete within two and a half
minutes on finals hardware.

## Locked expectations

### Flow A — expected findings (OCR must extract all three)

| # | Finding | Page |
| --- | --- | --- |
| 1 | Tube wall thickness at rows 12–15 measured 3.8–4.2 mm against the minimum allowable 4.6 mm | 1 |
| 2 | Localised pitting corrosion at the shell inlet nozzle, maximum depth 1.8 mm | 1 |
| 3 | Channel-head gasket degradation; replacement recommended | 2 |

### Flow A — assessment, citation, and decision-packet content

- The assessment must contain `fail`, `pass`, and `unknown` statuses.
- Every assessment row must cite `[SOP-114 §3.2]`; unsupported citations are
  rejected before document generation.
- The assessment must identify missing approval authority information and must
  not claim final approval.
- The generated DOCX (`approval-note-E201.docx`) contains an equipment header,
  extracted findings, the evidence/criteria matrix, conditional clearance
  pending retubing and gasket replacement, and grounding references.

### Flow A — required visible route changes

| Order | Task type | Model id | Reason string |
| --- | --- | --- | --- |
| 1 | `vision` | `vision-qwen25vl` | scanned report |
| 2 | `draft` | `draft-qwen3` | compose approval note |

### Flow B — expected code result

Expected out-of-range rows (the CSV fixture is generated to match exactly):

| Timestamp (2026-08-20) | Reading (°C) | Direction |
| --- | --- | --- |
| 03:10 | 352.4 | high |
| 03:20 | 354.1 | high |
| 05:30 | 248.6 | low |
| 09:40 | 351.8 | high |
| 14:50 | 353.2 | high |
| 17:20 | 249.3 | low |
| 21:00 | 352.9 | high |

- Script result: exit code `0`; stdout contains
  `OUT_OF_RANGE 7/240 (high=5, low=2)`; flagged rows are written to the run's
  output folder.
- XLSX artifact: `out-of-range-summary.xlsx` with the seven flagged rows and
  the summary count.

### Flow B — required visible route change

| Order | Task type | Model id | Reason string |
| --- | --- | --- | --- |
| 1 | `code` | `code-qwen25coder` | CSV/code intent |

## Expected screens and evidence

Screens (all visible during the demos, per TASKS 1c): chat/input with file
drop, live agent transcript, routing badge(s), confirmation dialog(s),
artifact preview pane, run status, and the always-visible sovereignty panel
(five-host LAN allowlist, external-request counter at 0, monitor-active
indicator).

| Evidence | Flow | Form |
| --- | --- | --- |
| Decision packet DOCX | A | `data/runs/<run-id>/output/approval-note-E201.docx` with evidence matrix and grounding references |
| PDF preview | A | derived locally from the DOCX; no fake preview on conversion failure |
| Execution record | B | exit code 0 and capped stdout/stderr in the transcript and SQLite |
| XLSX artifact | B | `data/runs/<run-id>/output/out-of-range-summary.xlsx` |
| Confirmation audit | both | approve/reject decision with timestamp in SQLite |
| Zero external egress | both | sovereignty panel plus independent monitor records |
| Blocked-egress proof | infra | preconfigured outbound test blocked and recorded (tasks 10d/11b); never an application feature |

Coverage of the finals Definition of Done (`PRODUCT.md` §10): Flow A covers
auto-selection, multimodal extraction, local criteria grounding, uncertainty,
and a human-reviewable decision packet; Flow B covers the code task type and
the sandboxed, verified coding run; both flows run against the
zero-external-request proof.

## Deliberately out of scope for this build

- Handwriting or general-purpose OCR — clean typed scans only.
- PowerPoint generation.
- Multi-user auth, roles, enterprise deployment/ops tooling.
- Any knowledge base beyond the curated 10–30 document corpus.
- Languages other than Python in the execution sandbox.
- Editing generated artifacts in-app.
- A general plugin framework — the model registry is config-only.
- Any cloud fallback or internet-capable application feature.
- The external network monitor/firewall as an application component — it is
  independent infrastructure; the app only displays its active state.
- Improvised, live, or user-chosen demo inputs — fixed fixtures only.

## Change control

These requirements are frozen. Any change to fixtures, expected findings,
citations, expected code results, route reasons, or confirmation wording
requires agreement from all three owners and a dated entry below.

| Date | Change | Approved by |
| --- | --- | --- |
| 2026-09-03 | Initial lock | Supreet, Ayush, Sid |
