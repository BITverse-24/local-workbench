# Delivery and Verification

## Twelve-day build plan

| Days | Ayush — frontend | Supreet — backend | Sid — AI/ML | Exit criteria |
| --- | --- | --- | --- | --- |
| 1–2 | Electron shell, preload bridge, transcript and artifact-pane scaffolding | Electron-main root, IPC types, SQLite run repository, run workspace | connect OpenRouter stand-ins for the three routes; prepare local criteria and begin background downloads of the local model weights | all hosts reachable only on LAN; registry health checks pass |
| 3–5 | file drop, routing badge, confirmation modal, PDF pane | Flow A orchestrator and tool contracts; DOCX/PDF artifact worker | tune vision extraction and drafting prompts against fixed scans; verify citations | scanned report produces a cited DOCX and PDF after confirmation |
| 6–7 | Flow B result/log views and error states | code route, source validation, Bubblewrap runner, output artifacts | validate coder prompts against fixed CSV fixture and expected output | approved Python job runs with network unavailable and results displayed |
| 8–9 | polish transcript and failure UI | retries, cancellation, model health errors, audit/event completeness | model/service stability test; registry switch to the local models and re-validation of frozen prompts; external-monitor preflight with operator | both flows visibly show routes and graceful known failures |
| 10–12 | final UX pass and rehearsal script | fixture E2E tests, packaging, final defect fixes | full offline rehearsal, model fallback validation, operator evidence pack | two flawless offline runs plus a blocked-egress infrastructure demonstration |

## Test fixtures

Keep fixtures under the application-controlled demo data bundle, not in the
knowledge corpus upload path:

- one clean, typed scanned inspection-report PDF with known findings;
- one governing SOP, fixed approval-note template, and approval-readiness
  decision oracle carrying stable section IDs;
- one CSV with known out-of-range readings and expected flags/summary;
- expected assessment statuses/actions, approval-note citation list, DOCX text
  assertions, and PDF preview existence check;
- expected Python stdout, exit code, and generated data output assertions.

Use the real file-drop control for every test and rehearsal. Fixtures are fixed
to minimise model variance; no improvised finals input is in the acceptance
scope.

## Acceptance checklist

### Architecture and security boundaries

- [ ] Electron main is the only process exposing model, tool, filesystem, and
  persistence capabilities; renderer access is limited to the documented IPC.
- [ ] The registry contains exactly the approved LAN model endpoints, and all
  health checks run before a user can start a run.
- [ ] Each tool input/output passes schema validation and every run stops at
  eight iterations or fewer.
- [ ] The two confirmation gates prevent DOCX/XLSX write and Python execution
  until an explicit approve event is recorded.
- [ ] Bubblewrap fixture proves no network is available and output remains
  confined to the run's output directory.

### Product proof points

- [ ] Flow A displays `vision` then `draft` routing events, extracts fixture
  findings, assesses them against the governing SOP, and creates a cited
  decision-packet DOCX plus local PDF preview.
- [ ] Flow B displays `code` routing, executes the fixture script after
  confirmation, and shows exit code, bounded logs, and the expected result.
- [ ] Invalid model output, unavailable model host, rejected confirmation, and
  failed Python execution each produce a visible, auditable failure.
- [ ] The independent monitor shows no external requests during both flows and
  records the preconfigured blocked-egress test.

## Rehearsal protocol

1. Boot all five hosts on the private LAN and start each service from local
   paths.
2. Confirm registry/model health checks and open the independent
   monitor view.
3. Run Flow A, narrate vision then drafting routing, approve document creation,
   and display the cited PDF preview.
4. Run Flow B, narrate code routing, approve repair execution, and show the
   failed-then-verified output trace.
5. Run Flow C, narrate drawing interpretation and criteria comparison, and
   display the cited corrective-action note.
6. Run the infrastructure team's preconfigured outbound-block test and retain
   monitor evidence.
6. If any expected step fails, stop the demo, state the observed component,
   and use the tested fallback fixture only after returning to a clean
   application session.

## Deferred after MVP

Production authentication/roles, hardened sandboxing, large-scale knowledge
handwriting OCR, PowerPoint generation, user-editable artifacts, arbitrary
model plugins, and enterprise observability are deliberately deferred. They
must not consume the 12-day MVP schedule.
