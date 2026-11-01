# Agent repair audit: run 02383c66

Date: 2026-10-27. Scope: the saved production run and the three earlier runs in the same chat. This is an architecture diagnosis. It does not change the runtime or repair the demo workspace.

## Finding

The run used Agent mode. The failure occurred inside the Agent path. The system let a model interpretation replace the user's repair goal, removed the tools needed for repair, and then checked completion against that reduced goal.

The same sequence also shows a separate code preservation failure. An earlier repair attempt replaced working application structure with short fragments. Its test runner could not start Node. The next message lost the repair context and ended as a successful inspection.

Changing prompt wording or adding another retry cannot establish the missing guarantees.

## Production evidence

Evidence was read from `~/Library/Application Support/local-workbench/production/data/`. The database was opened in read-only mode. The chat ID is `5a3432f1-74dd-4ffa-b562-c80c73e8c803`.

| Run | Saved interpretation and observed result |
| --- | --- |
| `d07ea0cf-5c87-4e69-8a2b-7d248da9fefe` | The user asked to inspect, reproduce failures, repair both defects, preserve behavior, and run all tests. The saved objective included “Identify and fix defects.” The category was `file_inspection`; workspace operations and validation requirements were empty. The ledger recorded no tool operations. The run returned a report and was marked `completed`. |
| `591ddfbf-a28d-48a7-aeeb-d36aba4bc493` | “Now do the repair steps and make it work” became `code_modification`, but the contract requested exported source files instead of workspace edits. Approval was rejected. The run was `cancelled`. |
| `7c497006-a9be-49d2-89a4-78a69061206b` | The user explicitly requested file changes and no artifacts. This produced workspace authority and mandatory tests. The ledger recorded two writes and three failed test commands across the attempt and resumes. The run remained `partial`. |
| `02383c66-7277-4634-a4be-de1384e9f9b4` | The user supplied the failing test output. The saved mode was `agent`, engine `agent-v2`, with the correct workspace root. The contract became “Identify problems and recommend corrections,” category `file_inspection`, no workspace operations, and no validation requirement. It read only `tests/storage.test.js`, returned advice, and was marked `completed`. |

The target run lasted about 100 seconds. It made six model calls: one classification, two execution-loop calls, and three calls consistent with the source review, correction, and second review path. Only one workspace read was recorded. There were no writes or test executions in this run.

Its verification report had two checks:

- A nonmandatory checksum check for the saved read result.
- A mandatory check that a nonempty assistant answer was saved.

Both passed. Neither established that the repair request was complete. The saved source review still listed a coverage gap about `STORAGE_KEY`; that gap did not become a mandatory completion failure.

### Damage from the earlier repair

The earlier repair ledger records `src/app.js` changing from 67 lines to 10. The current file contains one filter function. It has lost its imports, rendering code, event handlers, and initial render call. It refers to variables and fields that do not match the original app.

The replacement `src/storage.js` contains two local functions and no exports. It has lost `STORAGE_KEY`, `loadWorkOrders`, and the exported `saveWorkOrders` interface. The original backup **does export `STORAGE_KEY`**. Thus the missing export in the user's test output was introduced by the repair attempt.

`src/work-orders.js`, which owns the broken status filter, still has the original defect. The earlier report pointed to the wrong owner, and the repair did not correct that module.

The originals remain in these workspace backup directories:

- `demo/flow_d/workspace/.harness_backups/2026-10-27T16-51-25-091Z-840900b7-bdd4-482d-a7bd-1260533d2fb0/`
- `demo/flow_d/workspace/.harness_backups/2026-10-27T16-51-25-095Z-e9defd64-8547-48bb-9900-1a745f7bebba/`

## Architectural causes

### 1. One task category discards a sequence of obligations

The classifier must choose one action: inspect, modify software, draft, execute, or explain. A repair request normally requires several of these steps. In this case, selecting inspection erased the requested repair and tests.

The normalizer explicitly clears workspace mutation when the selected action is inspection. `normalizeRunContract` then derives operations and acceptance from those fields. A schema-valid interpretation is treated as resolved; the optional audit only runs for an unresolved or failed interpretation.

The first run proves the contradiction: its objective says “fix,” while its operations and acceptance do not require a fix. The system has no requirement coverage check that rejects this loss.

Owners: [classifier](../backend/src/main/router/contextual-router.ts), especially lines 146, 367, and 670; [contract normalization](../backend/src/main/run/contract.ts), lines 46 and 87.

### 2. A run has durable state; the continuing task does not

Each new user message is classified again. The manager supplies recent prose. The classifier keeps only the last four messages and the first 300 characters of each. The execution loop keeps the last six messages.

Before the target run, the last four messages were the user's instruction to modify files and three copies of the partial-result answer. The original two-defect request was outside this classifier window. It was also outside the loop's six-message window.

A resume uses the saved contract and ledger. An ordinary follow-up does not have that same task link. Thus “npm test returned…” became a new inspection instead of new evidence for the open repair goal.

Owners: [history loading](../backend/src/main/run/manager.ts), lines 822 and 977; [classifier history](../backend/src/main/router/contextual-router.ts), line 555; [loop history](../backend/src/main/agent/agent-loop.ts), line 718.

### 3. Interpretation, authority, and tool visibility share the same fragile decision

The saved mode correctly permits Agent capabilities. But the manager first removes tools using the interpreted intent. It then builds the dispatcher from that reduced list. The loop applies another capability filter.

For this contract, `write_file`, `delete_file`, and `run_command` are removed before execution. Capability activation cannot restore a tool that was never registered in the dispatcher. The model cannot recover from a mistaken inspection decision by inspecting the project and proposing a repair within the same run.

Agent mode must still allow read-only requests. The needed distinction is between available operations, task scope, and approved side effects. An interpretation error must not silently redefine all three.

Owners: [manager tool composition](../backend/src/main/run/manager.ts), line 1140; [intent pruning](../backend/src/main/router/tool-compositor.ts), line 188; [dispatcher setup and turn filtering](../backend/src/main/agent/agent-loop.ts), lines 669 and 953.

### 4. Verification checks a reduced contract instead of preserved user obligations

The completion checks are internally consistent with the saved contract. They cannot detect requirements that never entered it. The target contract has no mutation or test criteria, so a saved answer satisfies every mandatory check.

Automatic tests provide a useful second defense after code changes. They do not detect this failure because the target run makes no changes. Repeating the same contract through the ledger and verification report does not give an independent check of task coverage.

Owners: [completion evaluation](../backend/src/main/run/contract.ts), line 202; [verification criteria](../backend/src/main/run/verification.ts), line 193; [test scheduling](../backend/src/main/agent/agent-loop.ts), line 810.

### 5. Code repair lacks a source revision and behavior preservation boundary

The earlier repair ledger records no read operations before the writes. Its contract had a generic mutation operation with no target path, so the manager's explicit-target source preload did not supply these implementations either. The system accepted whole-file replacements that removed the public interface and application startup.

Backups, path checks, locks, and atomic writes work at the filesystem boundary. They do not establish that a replacement preserves the program. Writes reach the workspace before tests are accepted. When the environment fails, damaged files remain as a partial result.

The loop also converts Markdown code blocks into write calls when it expects a mutation. This allows explanatory fragments to become whole-file replacements. The saved provider content is omitted, so this audit cannot prove whether the two observed writes came from native calls or this conversion path. The unsafe ambiguity exists in the implementation either way.

Owners: [code block conversion](../backend/src/main/agent/agent-loop.ts), line 1241; [write tool](../backend/src/main/tools/workspace-tools.ts), line 356; [file replacement](../backend/src/main/harness/tools/write-file.ts), line 27.

### 6. Document review rules govern software work

The manager adds approval decisions, inspection table rules, and recommendation formats to the common Agent prompt. The prose review correction pass adds the same domain rules. The final code answer consequently includes “Approval Decision” and a document-style recommendation.

Software behavior review before repair is implemented for attached Python source. A mounted JavaScript project does not receive an equivalent source and interface check. The common path invests effort in polishing an answer while the code task lacks required execution evidence.

Owners: [Agent prompt construction](../backend/src/main/run/manager.ts), lines 1329 and 1373; [prose review and correction](../backend/src/main/agent/source-review.ts), line 58; [review dispatch](../backend/src/main/agent/agent-loop.ts), line 1428.

### 7. Shell support is mistaken for project execution support

The previous test attempts all exited 127 with `env: node: No such file or directory`. They were recorded as an invalid test report. This is an environment failure before tests can report code defects.

The command capability probe runs a shell marker. It does not resolve the project's interpreter and package manager in the actual command environment. Here, the terminal resolves Node under `/opt/homebrew/opt/node@24/bin`; the command environment always adds `/opt/homebrew/bin` and depends on the app's inherited PATH for other locations. The production failure proves that the launched command could not resolve Node. The saved evidence does not identify the exact PATH used.

Owners: [launch environment and capability probe](../backend/src/main/harness/tools/run-command.ts), lines 101 and 172; [verification failure assessment](../backend/src/main/agent/verification-stage.ts), line 115.

## Required architecture

Extend the existing contract, ledger, workspace, and verification owners. A second agent framework would duplicate them.

1. **Preserve the task across runs.** Keep the objective, requested outcomes, constraints, and unresolved checks as durable task state. Link follow-up runs to that state and workspace identity. A new message can add evidence, revise scope, or start a new task. Old side-effect approvals must remain subject to their current run and expiry rules.
2. **Treat inspection and execution as steps.** A route may select a model or first step. It must not remove separately recorded user obligations. Permit discovery before target files are known. Record contract revisions with their basis when the task changes.
3. **Keep capability and authorization ownership clear.** Register tools from mode and environment support. Use policy checks and concrete approvals to authorize side effects. Planning can choose a read-only path without permanently deleting repair capability. New scope requires a visible contract revision and the applicable authorization.
4. **Bind edits to inspected source.** Require a current source revision for edits to existing files. Use explicit edits or explicit complete replacements. Keep Markdown examples as prose. Preserve backups, path containment, locks, and cancellation checks. Track proposed, applied, and verified changes as separate states.
5. **Verify the requested behavior.** Record each requested repair, preservation requirement, and test obligation before work starts. Require evidence tied to the current code revision. For this web project, focused module tests alone cannot prove that startup and UI wiring survived. Add an app startup check to the acceptance proof when implementation begins. A saved answer only proves delivery of text.
6. **Resolve execution support before repair depends on it.** Check the project's test command, interpreter, and package manager under the same launch rules used for tests. Distinguish missing runtime, test discovery failure, failed tests, and invalid reports. Preserve isolation and explicit fallback approval.
7. **Select review rules by work type.** Keep shared safety and evidence rules small. Apply document approval rules to document tasks. Apply interface preservation, source revision, test feedback, and app behavior checks to code tasks.

## Proof required for the redesign

- The original mixed request retains inspection, both repairs, behavior preservation, and full-suite obligations.
- A report with no repair cannot complete that task.
- After repeated partial results, pasted test output continues the repair and retains both defects.
- Replacing a module without the current source revision is rejected; examples do not become writes.
- Removing storage exports or app startup produces failed or unverified acceptance, even if selected unit tests pass.
- Missing Node is detected as an execution environment problem. It cannot become a test pass or erase the repair goal on the next message.
- A deliberate read-only request in Agent mode remains read-only. Rejected approvals, cancellation, and workspace changes still revoke the relevant authority.
- A packaged run launched without a developer shell passes the same lifecycle checks. A source-worker demo alone does not establish this.

## Evidence limits

The production logs omit raw model content and request bodies. The database, durable results, telemetry, backups, and final responses establish the observed failures. They do not expose every model decision or the exact origin of the earlier write calls.

The local packaged archive under `release/0.1.0/mac-arm64/Local Workbench.app/Contents/Resources/app.asar` contains the relevant classifier history truncation, router prompt, Agent instructions, and verification code. The run has no saved build digest, so this audit does not claim that archive is the exact executable used.

No model replay was needed to establish these failures. Replaying against the damaged workspace would not reproduce the original starting state. The current Flow D files must be restored from preserved originals into a separate evaluation copy before a future repair trial.
