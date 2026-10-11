# Ship readiness audit — 2026-10-11

**Decision: HOLD the complete Chat / Work / Agent release.**

The product can perform useful work on the reference Mac and model. It is not ready for a supported release with its present safety claims. This audit reproduced an Agent command escape and hidden workspace writes. These violate the hard gates in FRAMEWORK.md. Passing model-quality scores cannot override a harness safety failure.

Audited commit: `7ec4fd7811d49c053d7d8d25543672c990bc08ad`. The working tree was clean when the audit started. The audit added reports and evidence; it changed no production source. Tests used temporary files and separate test databases. No prompt was submitted to the user's normal app profile. No external network destination was contacted by the command probe.

## Current verification

| Check | Fresh result | Practical limit |
| --- | --- | --- |
| Full ordinary suite | 974 passed; 6 opt-in live tests skipped | The suite does not cover the reproduced command escape |
| App typecheck | Passed | Checks types, not runtime authority |
| Behavioral typecheck | Passed | Same limit |
| Frontend and Electron build | Passed | No previous `import.meta` build warning |
| macOS arm64 directory package | Passed | No Developer ID signing or notarization |
| Packaged PDF, DOCX, XLSX and canvas | Passed | Reader smoke checks |
| Packaged SQLite and schema | Passed; integrity check `ok` | Fresh database, not an interrupted upgrade |
| Package inventory | No project data, tests, docs, demo files or `.env` in app.asar | Checked the generated package |
| Backend bundle in package | SHA-256 matches the current built bundle | Ties the package to this source build |
| macOS DMG build and checksum | Passed | No clean-machine installation or Gatekeeper test |
| Fresh nine-case live campaign | 8 Pass, 1 Partial | Task evaluation; all six Work runs remained production Partial |
| Fresh vision campaign | 3/3 Pass | Small smoke suite on the configured fallback model |
| Additional mode smoke checks | Agent write, DOCX generation and active Chat cancellation worked | Backend/IPC checks, not a new manual desktop pass |
| Explicit opt-in test run | Failed | One test failure and one suite setup failure; see R5 |

Evidence is in [the audit folder](/Users/krishay/projects/agent/docs/evidence/ship-readiness-20261011/README.md).

## Confirmed release blockers

### R1 — Critical: Agent commands can escape the workspace

The probe approved one exact `run_command` through `MutationPolicyGuard` and executed the real tool inside an Agent runtime scope. The workspace and the target file were both created for the probe. The target was a sibling of the workspace.

The approved Node command changed that sibling file from `before` to `after`. It exited with code zero. A separate command reached a local TCP test server. The probe made no connection to an external host; it establishes that this execution path lacks a network isolation barrier.

Setting `WORKBENCH_USE_MAC_SANDBOX=1` made `detectPlatformContainment()` return true, but the same outside write still succeeded. The runner does not invoke sandbox-exec on macOS. It sends every non-Linux case to the direct shell executor.

Root causes:

- [run-command.ts:81](/Users/krishay/projects/agent/backend/src/main/harness/tools/run-command.ts:81) detects macOS containment from an executable's presence and a flag.
- [run-command.ts:150](/Users/krishay/projects/agent/backend/src/main/harness/tools/run-command.ts:150) only invokes an OS sandbox on Linux. macOS goes to `execDirect`.
- [run-command.ts:48](/Users/krishay/projects/agent/backend/src/main/harness/tools/run-command.ts:48) permits interpreters and package runners without isolation. A program name does not limit its filesystem or network actions. Only the shell's first binary is checked.
- The direct executor inherits the parent environment. A working directory does not confine file access.
- [agent-loop.ts:841](/Users/krishay/projects/agent/backend/src/main/agent/agent-loop.ts:841) grants wildcard command scope after approval for mutation or validation work. Combined with the command runner, this gives later commands broad process authority.

The separate digest-bound Python fallback approval does not cover `run_command`. In the probe, that approval callback was never invoked. This is distinct from the disclosed, user-approved Python isolation exception.

**Required release action:** enforce a real process boundary for Agent commands, or fail closed when it is unavailable. Test the effective boundary, not the existence of a sandbox binary. Keep command authority within the approved task. Adding more denylist expressions is insufficient.

### R2 — High: commands make hidden writes before validation

With `local-module.py` in a temporary workspace, approving only `echo checked` created `local_module.py` as a symlink. The user did not request that file.

The probe then removed its own alias and attempted a command that the safety denylist rejects. The command was rejected, but the alias appeared again. A failed tool invocation therefore changed the workspace.

[workspace-tools.ts:646](/Users/krishay/projects/agent/backend/src/main/tools/workspace-tools.ts:646) creates aliases for every root-level Python filename containing a hyphen. It does this before command safety validation and before acquiring the command mutation lock. It does not use the guarded writer, check a write scope, create a backup, or report the alias as a separate mutation.

**Required release action:** remove these automatic workspace writes or give any necessary write explicit scope and normal containment, locking, backup and ledger handling. A rejected command must leave the workspace unchanged.

### R3 — High: image follow-ups reuse query-specific cached evidence

[source-preparation.ts:34](/Users/krishay/projects/agent/backend/src/main/run/source-preparation.ts:34) caches extraction by source digest and processor version. Its visual extraction call also receives the current user query.

A deterministic probe used identical image bytes in two separate authorized runs. The first query asked for colors; the second asked for a serial number. A mock visual extractor returned query-specific text. The extractor ran once. The second run received the first query's text.

This probe verifies the backend data flow. It does not claim a particular live model failed to read a serial number. It shows that the backend can prevent the model from obtaining new evidence for a new question. The cache is process-wide, so later chats and model changes can also reuse this result.

**Required release action:** keep deterministic document extraction caching separate from query-dependent vision results. Use an appropriate query/model/configuration key, or obtain a complete reusable extraction before caching. Verify follow-ups through the real response path.

### R4 — High: Python fallback approval has the wrong action labels

The real `ConfirmationModal` was rendered with an `uncontained_python` action. It displayed **Excel spreadsheet generation** and **Approve & generate**.

[ConfirmationModal.tsx:144](/Users/krishay/projects/agent/frontend/src/components/ConfirmationModal.tsx:144) recognizes `execute_python`, but not `uncontained_python`. The new kind falls into the document-generation branch.

The backend's filesystem/network warning remains visible in the prompt. The probe did **not** find a false sandbox label on this fallback action. However, the badge and button describe the wrong operation. This approval needs an explicit Python fallback presentation.

**Required release action:** render the correct operation, its actual isolation limits, and an execution approval button. Check approval, rejection, changed-source approval and expiry in the packaged UI.

## Test and configuration gaps

### R5 — High release-evidence gap: the skipped live fixtures are stale

The ordinary suite's six skips were enabled with the current registry supplied explicitly. The run produced one failing test and one failing suite setup; that setup prevented five tests from running.

- The intent suite's setup still requires the obsolete `draft-qwen3` ID at [live-intention-verification.test.ts:35](/Users/krishay/projects/agent/backend/tests/live-intention-verification.test.ts:35).
- The retrieval fixture names the same obsolete model ID and passes a root outside the run's storage. It reaches the gateway, but retrieval is rejected by the current Chat containment policy. Its test ends after repeated permission errors.
- Two intent fixtures also omit the execution mode while expecting the old computation/approval path. Current omitted-mode behavior is Chat. Their expectations must be updated even after the setup check is repaired.

These are invalid test assumptions, not proof that the equivalent supported product flows fail. They are also not passing release checks. The fresh canonical campaign provides useful live evidence independently of them.

**Required release action:** repair the fixtures without weakening assertions or the mode policy, then run them explicitly against the release configuration.

### R6 — Configuration risk: unknown models are assumed to support vision

[registry.ts:64](/Users/krishay/projects/agent/backend/src/main/gateway/registry.ts:64) gives an unprofiled model `image-input` capability by default. The probe confirms this for a Coding-role entry with no matching model profile. Visual extraction prefers an image-capable selected driver.

This can direct image requests to a text-only endpoint. This audit did not send a live image request to a known text-only alternate endpoint, so the resulting provider failure remains untested. The configured reference model has an explicit correct profile, and its fallback smoke tests passed.

Before claiming support for arbitrary onboarding configurations, verify capabilities and fallback selection rather than assume image support.

## Fresh model and user-flow evidence

The canonical campaign is `tests/.runtime/v0/2026-10-11T05-41-14-118Z`. Its provenance records the current commit and the rebuilt worker digest. It is one complete cohort, not selected successes from different runs.

| Family | Evaluation | Production outcomes |
| --- | --- | --- |
| Document work | 2 Pass, 1 Partial | 3 Partial |
| Code repair | 3 Pass | 3 Partial |
| Inspection | 3 Pass | 3 Completed |

Total latency: p50 **57.7 seconds**, p95 **80.4 seconds**, using nearest-rank percentiles over nine samples. Recovery count never exceeded two. The supplied-input and independent Python probes passed for all three repaired programs. The live runner approved recorded Python fallback requests in its test profiles; this does not establish OS isolation.

The saved document outputs were reviewed. The two inspection notes retain both subjects, important values, source instructions and conditional approval. The unrelated training note remains Partial: `Next Actions: None` conflicts with an instruction to retain an attendance sheet. Case changes in staff headings also trigger an automatic diagnostic. The observed Work states did not falsely claim Completed.

The canonical grader reports zero harness failures **within those nine scenarios**. It does not exercise the command escape or hidden-write probes. Those confirmed failures invalidate the wider “100% harness invariants” claim.

Additional live checks used separate test profiles:

- **Agent:** one approved write changed `smoke.txt` to exactly `AFTER`. Only `write_file` ran; no document export or command was added. The final state was Completed.
- **General DOCX:** `welcome.docx` opened, contained the exact requested sentence and had zero Word table elements. It required no report rows. Its content was minimal—only the requested sentence under a default title—and the state stayed Partial. This proves generation works, not strong general drafting quality.
- **Active Chat cancellation:** cancellation after the first streamed chunk reached Cancelled and saved the interrupted text. This was a backend cancellation call, not a click on the desktop Stop button.
- **Vision:** image-only PDF, raster image and SVG fallback descriptions matched the fixture's shape counts, colors and arrangement. All three used the configured visual path. The SVG `sourceText` echoed the query, although its structured findings were correct; do not treat that field as literal OCR proof.

The historical source/output audit also remains intact: 26 recorded source and artifact digests matched. Baseline archives and restore instructions exist. A full independent baseline restore was not repeated in this audit.

## Remaining delivery gates

The current unsigned Mac directory package and DMG build successfully. The DMG checksum is valid. This does not prove installation, Gatekeeper behavior or a signed public distribution. Signing and notarization remain required for a normal public Mac release; a controlled unsigned test distribution is a different claim.

No new manual desktop pass was completed here. The prior pass covered chat switching, queued cancellation and restart restoration, but left the active Stop button and Python fallback modal unchecked. The source/rendering probes now show why that fallback check matters. After the blockers are corrected, repeat those checks and the reported artifact-copy flow in the final packaged app.

Windows and Linux remain uncertified. The nine live tasks and the mode policy tests do not establish broad reliability across 30 live tasks per mode. True cold model loading, renderer paint latency and robust busy-load percentiles also remain unmeasured. Under the agreed v1 scope, speed percentages are measured objectives rather than established numerical release gates.

An interrupted schema upgrade was not tested. Confirmation-table migration uses multiple statements without an enclosing transaction. Preserve a profile backup and test interrupted upgrade/recovery before wider deployment. This is a reviewed risk, not a reproduced data-loss incident.

## Ordered path to release

1. Close R1 and R2. Add adversarial checks for outside reads/writes, network access, interpreter/package execution, shell chaining, rejected-command side effects and command scope after a write-only plan.
2. Close R3 and R4. Check image follow-ups and the real Python fallback approval in the packaged app.
3. Repair R5 and verify model capability handling for the supported onboarding configurations.
4. Freeze a candidate commit. Rebuild, run unit and valid live checks, then audit actual outputs. Retain correct Partial and Failed outcomes.
5. Test final-package onboarding, settings persistence, the artifact-copy flow, approval rejection/expiry, active cancellation, background chats, restart/resume and profile upgrade. Capture the candidate's provenance.
6. Build and test the installer for each claimed platform. Complete signing/notarization for a public Mac distribution. Keep untested platforms outside the release claim.

A fresh candidate can ship when its hard authority gates pass and its scoped quality and delivery checks are complete. The current candidate does not meet that condition.
