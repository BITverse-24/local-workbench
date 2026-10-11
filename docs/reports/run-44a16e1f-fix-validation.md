# Fix and validation: run 44a16e1f

Date: 2026-10-11

This change addresses the faults recorded in [the investigation](/Users/krishay/projects/agent/docs/reports/run-44a16e1f-investigation.md). The historical failed run and its evidence remain unchanged.

## Corrected behavior

A request to copy the prior saved file into the workspace resolves its source from this chat by a stable ID. An explicit current attachment takes precedence over an older output. A clear copy operation retains the source filename unless a different destination is specified. It requires workspace approval, preserves existing files in backups, and verifies the target bytes against the approved source digest. This path makes no classification or generation call. It preserves the saved source artifact.

The backend stops a copy when the source is missing, ambiguous, outside the authorized run storage, or changed. It also stops a copy after denied approval, cancellation, or a changed workspace binding. Same-name selected inputs cannot be chosen by guesswork. Content changes, conversion, and compound tasks remain on the model execution path.

Both current and legacy intent responses now apply output checks against the latest user request. Workspace edits cannot add a document export by default. Explicit file names, formats, and export exclusions take precedence over model-inferred outputs. Tool composition uses the persisted deliverables. The generator also rejects an export when the contract has no deliverables. Existing format and filename checks remain in force.

The fallback gateway can decode one complete JSON tool envelope after narration. It still rejects incomplete envelopes, multiple JSON values, encoded strings, and ordinary unfenced examples. The recovered calls pass through the normal capability and approval checks.

An empty optional `report_rows` list is treated as omitted for a plain document. Sourced report tables still require valid rows and source-page coverage. Valid short content is accepted; empty content and known placeholders remain rejected. Exhausted recovery reports the actual tool error and retains its error code.

## Verification

- `npm run typecheck`: passed.
- `npm test`: **966 passed, 6 skipped**, across 77 passing test files. The skipped tests require a live model.
- `npm run build`: frontend and Electron builds passed.
- `git diff --check`: passed.

The new regression suite contains 41 tests. It replays the exact workspace-copy request from the investigation, uses real temporary files and SQLite records, checks approval before writing, verifies exact bytes after writing, checks backups, and detects later target corruption. It covers missing and ambiguous sources, duplicate names, cross-chat access, changed inputs, symlinks, cancellation, workspace changes, and forged exports. A gateway-to-AgentLoop-to-generator test uses the recorded narrated JSON shape with empty report rows, creates a DOCX, and reopens it to confirm the requested text.

The unchanged baseline reproduced one existing worker-pool failure. Its fixture used obsolete Primary onboarding rows mixed with Vision. The fixture now uses the current Draft, Coding, and Vision roles, while retaining the assertions that each configured endpoint is separately selectable. Contract and ledger fixtures now give explicit export requests where their assertions require exported documents. Their substantive assertions were retained.

No live inference or manual UI replay was used for this validation. The reported copy flow is deterministic and its tests assert that neither classification nor generation is called. Restart the development app before submitting the copy request again so that Electron loads the updated backend.

## Follow-up: general drafting and optional report rows

The model-facing `generate_deliverable` schema no longer exposes `report_rows`. General drafts use `content`; requested tables can be written in Markdown there. Word generation does not require an inspection table.

For compatibility, older calls can still supply structured report rows. An empty array or `null` is treated as omitted, even with attached source documents. Source references remain in the generated document. Non-empty rows still undergo row validation and source-page coverage checks. Required content checks remain unchanged.

Validation: typechecking and both builds passed. Five related suites passed with 233 tests before the final sourced retry case was added. The final artifact-transfer suite then passed all 49 tests, including the gateway-to-AgentLoop-to-DOCX retry with attached sources and empty rows. Saved DOCX files were reopened to check the requested prose, source references, and absence of an unwanted inspection table. Existing structured-table coverage tests also passed. No live inference or manual UI replay was performed.
