# Release blocker fixes — 2026-10-11

**The four reproduced blockers are fixed. Release approval remains open until the final packaged UI checks are complete.**

This follows [the ship audit](ship-readiness-2026-10-11.md). The reference source is commit `b48a99e6ea508e11bffad57602feb973ade352ec`. The fixes are local, uncommitted changes. The source manifest and package digest in [the evidence folder](../evidence/release-fixes-20261011/README.md) identify the tested candidate. The starting worktree was clean. The original commit, model configuration, demo fixtures, and earlier evidence remain available. A fresh restore extracted the original source, applied the saved local diff, and recovered the untracked test. All 375 restored files match the preserved baseline checkout. The saved runtime archive is readable.

## What changed

| Audit finding | Change | Fresh evidence |
| --- | --- | --- |
| R1: commands escaped the workspace and reached the network | Commands require a real OS sandbox. They run against an independent workspace copy with a minimal environment. There is no direct shell fallback. Successful file changes pass scope, containment, concurrent-change and backup checks before publication. Command approval is exact; write approval does not grant later commands. | Real launcher/refusal tests; separate publication tests; command and path scope tests |
| R2: hidden Python aliases appeared before validation | Removed automatic Python alias writes and obsolete automatic workspace export copies. No alias is created for accepted or rejected commands. | Accepted/rejected-command regression tests; actual workspace assertions |
| R3: visual follow-ups reused the previous question's evidence | Cache only deterministic source extraction. Query-dependent image and scanned-PDF model responses are not cached. | Follow-up tests with changed question, model and chat; real Chat path follow-up test; fresh visual campaign |
| R4: Python fallback approval looked like spreadsheet generation | Correct Python action, execution button and file/network warning. The ordinary Python modal makes no promise of isolation before the probe. Expired approvals cannot be accepted by button or keyboard. | Actual React component rendering; backend approval and changed-source tests |

The actual OS launcher cannot start on this Mac in this test environment. Command tests therefore prove refusal and unchanged originals here. They do **not** establish successful macOS sandbox execution. The publication tests simulate the subprocess transport and test real copied files, backups and policy checks separately. Unsupported commands fail with an isolation error. There is no hidden exception for Python, Node, shell chaining or an allowed program name.

The separate `execute_python` fallback remains an explicit, digest-bound user exception. Its approval states that the script can access files and the network with the user's permissions. It must not be described as isolated.

Further changes close related authority and evidence gaps:

- File scopes match the approved path. A matching basename or `fixed-` prefix cannot grant another target. Canonical symlink targets also need authorization.
- Symlink backup directories are rejected. Atomic writes do not fall back to overwriting an existing inode.
- A registered workspace redirected through a symlink is rejected. Agent authority is revoked when its binding changes.
- Schema creation and migrations run in one transaction. An injected interruption preserves the old records; retry succeeds.
- Unknown Coding and Draft models no longer receive image capability by default. Explicit Vision roles and known profiles retain their capabilities.
- Malformed CSV/JSON **inputs** can be inspected as raw text for repair. Generated artifact validation remains strict.
- Explicit user restrictions on protected files are retained if the semantic model omits them.
- Removed the unreachable legacy execution path and unused helpers/imports. Removed tests only for deleted helper predicates; retained the actual generation and repair assertions. Fixed mutation-lock queue cleanup.

## Final checks

| Check | Result |
| --- | --- |
| Backend, Electron and frontend typecheck | Pass |
| Behavioral typecheck | Pass |
| Full ordinary tests | **999 passed, 6 opt-in live tests skipped** |
| Explicit opt-in live tests | **5 passed, 1 failed**; see quality limit below |
| Frontend/Electron build | Pass; no old `import.meta` warning |
| Final macOS arm64 app and DMG build | Pass |
| Packaged PDF/DOCX/XLSX readers and canvas | Pass |
| Packaged native SQLite and schema | Integrity `ok`; no foreign-key violations |
| Package inventory | No project data, tests, docs, demo files or `.env` |
| Packaged backend | SHA-256 matches the final built backend |
| DMG checksum verification | Pass |
| Final packaged app startup with a separate test profile | Backend initialized and production UI loaded |
| Manual final-package UI checks | Core packaged actions checked; user confirmed active mode and underscore rendering |

### Fresh framework campaign

One complete nine-task cohort used the reference Qwen2.5 Coder 7B configuration. The result is **8 Pass, 1 Partial, zero reported harness failures**. Document work scored 2/3 Pass; code repair 3/3; inspection 3/3. This meets the framework's model-quality minimums.

Nearest-rank task latency was p50 **58.0 seconds**, p95 **82.7 seconds**. No case exceeded 120 seconds or two recovery attempts. These are backend task times, not cold-load or renderer-paint measurements.

All six Work runs remained production **Partial** because the required acceptance or behavior evidence was incomplete. The three Chat inspection runs completed. Evaluation Pass means an independent test judged the saved result useful; it does not override the production verification state.

Saved outputs were read separately. Both inspection DOCX notes preserve E-201 and E-202, source annotations, key measured values, governing references and conditional approval. The three repaired source files passed supplied-input and independent-input probes. The drawing and parcel responses contain the required discrepancies and corrections. Artifact digests match their recorded metadata.

The unrelated training note remains Partial. It changes the staff identifier's case, which triggers the grader, and says `Next Actions: None` beside a requirement to retain the signed attendance sheet. This inconsistency is kept in the audit. The framework permits remaining Partial results after the family minimums pass.

This cohort includes genuine saved Flow A/B/C execution records: source processing and retrieval, a real DOCX, repaired source execution with real inputs, and grounded drawing inspection. No final artifacts were manually edited. These are execution records, not a new desktop video recording.

The final complete cohort is `tests/.runtime/v0/2026-10-11T06-37-11-335Z`. Its worker digest is `5e3ba12e458230146e8a5323f86cea7a16d0816f961d9dddc0351e918acf1677`, which matches the final worker in the source manifest. The final package includes two later frontend display fixes. Its backend digest remains unchanged, so this campaign still matches the packaged backend. The earlier pre-final cohort is retained under `earlier-canonical-*`; its results were not mixed into this score.

### Other live checks and quality limits

Visual fallback passed **3/3**: image-only PDF, raster image and SVG geometry.

Fresh final-worker smoke checks show:

- Agent changed only `smoke.txt` to exactly `AFTER`, through one approved `write_file`. No export or command was added. The run completed.
- General DOCX generation produced `welcome.docx`, retained `Welcome to the team.`, and had zero tables. No report rows were required. The document is only a title and that sentence; it is a weak welcome letter. The run remained Partial.
- Active Chat cancellation saved the interrupted text and reached Cancelled. Backend cancellation and the packaged desktop Stop button both saved interrupted text and reached Cancelled.

The remaining opt-in failure is real model quality. The attached CSV repair uses `split(",", 1)` and leaves quoted values incorrect. The independent Python assertion remains in the test and fails. The app reports Partial rather than false success. This does not invalidate the passing nine-case framework score, but arbitrary CSV repair and general drafting must not be claimed to work without review.

## Packaged desktop checks

The Mac became available. Manual actions used a separate profile and a temporary workspace. They confirm:

- Model Settings opens the Vision, Coding and Draft fields. Settings and the selected Vision model survive restart.
- A Chat request queues behind active inference. Stop cancels the queued request without an answer. Stop also cancels active Chat and retains the interrupted text.
- Background Work and Agent events remain in their own chats. A pending Python approval opens for its owning chat.
- An Agent plan for `smoke.txt` contains only the requested write. Approval saves exactly `AFTER_UI`, with a backup of the original. No export or command is added.
- A Work artifact remains available after Partial and restart. Copy gives the exact content. Save As writes a new file with the same 17 bytes.
- Without a workspace, Agent is disabled and its help text asks for a workspace. The prompt bar has no workspace picker.
- The Python fallback modal states the actual action and lack of file/network isolation. Rejection cancels it. Natural expiry cancels it at its deadline. No Python execution occurs on rejection, expiry or restart.
- Resume from saved Work evidence starts the same persisted run and returns Partial with its artifact still present.

These checks found two display faults. Identifiers with underscores were parsed as emphasis; the renderer now preserves identifiers and escaped punctuation. Four component tests cover this. The composer also showed the global preferred mode when returning to an active background run; it now uses the persisted active mode.

The UI tool's screenshot remained stale, so it could not verify the last visual state. The user then checked the packaged UI directly and confirmed the active Work mode display and underscore rendering. The filename-like string in the check was display text only; no file was requested or created. Resume is also confirmed by the persisted run transitions and artifact. The Python approval test expired safely: run `5d412def` was Cancelled 22 ms after its deadline, with no execution result. The approved execution path itself is covered by a real Python subprocess test in `backend/tests/three-modes.test.ts`; the packaged modal, warning, rejection and expiry were checked separately.

## Remaining release work

The four reproduced blockers now meet the framework gates on the tested Mac configuration. The positive approved Python path passed an integration test; this review did not execute it through the packaged UI. Any fallback run still needs the user to inspect and approve its exact code and inputs because OS isolation is unavailable. The previous UI test request expired safely.

The package has no Developer ID signing or notarization. Public Mac distribution and clean-machine installation remain unverified. Windows and Linux remain outside this certification. Positive sandbox execution also needs a supported host check before it is advertised as available.

**The known safety failures are closed, and the reference model passes the scoped framework gates. A claim that the whole product is ready to ship without these limits is not supported yet.**
