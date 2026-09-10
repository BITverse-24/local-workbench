# Flows and Data

## Shared data handling

1. Electron main copies an accepted dropped file into
   `data/runs/<run-id>/input/` and assigns a random attachment token.
2. Tools receive tokens or run-relative paths, never user-provided absolute
   paths.
3. Intermediate OCR text, criteria assessments, draft data, generated code, and
   tool results stay in the same run directory.
4. SQLite records references and audit summaries. Local SOP criteria are
   versioned with the fixture bundle and passed into the assessment step.
5. An artifact is immutable once emitted. PDF previews are derived from the
   generated DOCX, not treated as independently editable documents.

## Flow A — inspection report to approval-readiness decision packet

```mermaid
sequenceDiagram
    actor User
    participant UI as Electron renderer
    participant Main as Electron main
    participant O as Orchestrator
    participant V as Vision model
    participant K as Local SOP criteria
    participant D as Draft model
    participant W as Document worker

    User->>UI: Drop pre-tested scanned report
    UI->>Main: startRun(text, attachment token)
    Main->>O: create run + classify
    O-->>UI: routing(vision, reason: scanned report)
    O->>V: OCR/extraction request
    V-->>O: validated findings + page references
    O->>K: apply governing SOP criteria
    K-->>O: evidence/criteria statuses and required actions
    O-->>UI: routing(draft, reason: compose approval note)
    O->>D: draft decision packet using findings, assessments, and citations
    D-->>O: validated note draft
    O-->>UI: confirmation_required(generate_docx)
    User->>UI: Approve
    UI->>Main: confirmAction
    Main->>W: write DOCX and convert locally to PDF
    W-->>Main: DOCX + PDF references
    Main-->>UI: artifact_ready + completed
```

The assessment and approval-note prompt require citations in the form
`[SOP-114 §3.2]`. The document worker refuses to create a deliverable if a
criterion citation is unsupported. The rendered document includes the
evidence/criteria matrix, explicit `unknown` information, and a short
“Grounding references” section.

OCR output is intentionally limited to clean, typed scans. The UI labels OCR
findings as extracted content, not a claim of handwritten-note accuracy.

## Data-analysis scenario (regression/demo fixture)

```mermaid
sequenceDiagram
    actor User
    participant UI as Electron renderer
    participant Main as Electron main
    participant O as Orchestrator
    participant C as Code model
    participant B as Bubblewrap runner

    User->>UI: Drop CSV and request analysis
    UI->>Main: startRun(text, attachment token)
    Main->>O: create run + classify
    O-->>UI: routing(code, reason: CSV/code intent)
    O->>O: inspect file metadata and plan
    O->>C: draft Python source
    C-->>O: validated source + expected result
    O-->>UI: confirmation_required(execute_python)
    User->>UI: Approve
    UI->>Main: confirmAction
    Main->>B: execute source with scoped input/output mounts
    B-->>Main: exit code, stdout/stderr, output artifact refs
    Main->>C: summarise verified result
    C-->>Main: final explanation
    Main-->>UI: assistant message + completed
    opt User requested an export
        Main-->>UI: confirmation_required(generate_xlsx)
        User->>UI: Approve and select Save As destination
        Main-->>UI: artifact_ready
    end
```

The code model never supplies shell arguments. The tool runner writes the
validated Python source to the run workspace and invokes a fixed runner command
with explicit source, input, and output paths. A non-zero exit code is surfaced
as a failed verification, with capped stderr in the transcript; it is never
presented as a successful calculation.

## Required failure behaviour

| Condition | User-visible outcome | Recovery boundary |
| --- | --- | --- |
| Registry endpoint unavailable | run error naming the selected model | retry only after a fresh health check |
| Invalid structured model/tool output | run error with failed validation step | do not guess or call another model |
| Tool not permitted in current flow | run error and audit event | no override from renderer/model |
| Confirmation rejected/expired | cancelled state; no write/execute action | user starts a new run |
| Bubblewrap timeout/non-zero exit | execution failure with bounded logs | user revises request/retries a new run |
| DOCX/PDF conversion failure | DOCX retained; preview failure shown | no fake preview, retry conversion locally |
| Missing governing criteria | assessment fails before document creation | operator repairs the local SOP fixture; no uncited decision packet |
