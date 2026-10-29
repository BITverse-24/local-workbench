# Agent harness system design and low level change report

**System:** Local Workbench

**Status:** Implementation approved and in progress; production v3 promotion is closed

**Date:** 27 October 2026

**Prepared by:** Codex

**Audience:** Project owner and implementing engineer

**Target:** Local models with 7–14B parameters and an 8,192-token context window

This report defines the approved project changes. It follows the 12 sections of the selected System Design template. All content is text. The project owner has authorized implementation. The change inventory below describes the target state; it does not claim that each change is complete. `docs/agent-v3-implementation-progress.md` records the current work and test evidence.

## 1. Abstract

Move control of Agent execution into the host. Keep the task, its requirements, permissions, applied changes, and verification evidence outside the model context. Give the model one bounded decision at a time. The model can propose an action or a final answer; the host determines whether execution is authorized and whether the task is complete.

This addresses the failure in production run `02383c66-7277-4634-a4be-de1384e9f9b4`. That run used Agent mode but reduced a continuing repair to an inspection. It read one test file and completed after saving advice. Its acceptance checks no longer required a repair or tests.

The first release changes Agent execution and the shared interfaces needed to support it. Chat and Work keep their current execution behavior. Agent must still support source inspection, documents, knowledge retrieval, and attached source repair. Code tasks receive code-specific instructions; document tasks receive document-specific instructions.

The agreed workflow uses direct project edits and backups. If tests cannot run, approved edits may proceed. The result remains Partial while mandatory checks have no accepted evidence. A test waiver requires a direct user instruction.

## 2. Goals and Non Goals

| Goal | Acceptance condition |
| --- | --- |
| Preserve the task across messages | Pasted errors and repeated partial results cannot remove unresolved requirements. |
| Fit an 8k text context | Every Agent text generation request passes exact counting after transport formatting. Vision uses the temporary file-extension estimate approved by the project owner. |
| Support small models | Each action call uses short instructions, selected evidence, and one structured action. |
| Preserve project behavior | Existing-file edits refer to observed source revisions; completion requires current checks. |
| Keep authority explicit | Task interpretation and tool visibility cannot grant mutation permission. |
| Report real progress | Applied changes, passed checks, unavailable checks, and remaining work are separate facts. |
| Preserve recovery | Restart expires approvals, retains evidence, and never replays an uncertain mutation. |

Excluded from the first release: a Chat or Work redesign; parallel agents; cloud inference; automatic dependency installation in user projects; automatic rollback of failed repairs; a guarantee that a small model understands arbitrary natural language or produces correct code.

Confirmed preferences: Agent first; continue the current task by default; direct edits; unverified edits allowed after approval; exact text counting required; reliability before minimum call count. Implementation is approved. Production promotion requires the release evidence in Section 9. The later user decision permits a fixed file-extension estimate for vision in this version. That estimate must be labelled; it is not an exact count.

## 3. Background and Problem Statement

### Observed production sequence

| Run prefix | Saved behavior | Consequence |
| --- | --- | --- |
| `d07ea0cf` | The user requested inspection, reproduction, two repairs, preserved behavior, and all tests. The objective included fixing defects, but the contract used `file_inspection` with no mutation or validation requirement. | A report with no recorded tool operations was marked complete. |
| `591ddfbf` | The repair follow-up became source-file exports. Approval was rejected. | The run was cancelled. |
| `7c497006` | An explicit request to modify files produced two writes. The app entry changed from 67 lines to 10. Storage exports were removed. Test attempts exited 127 because Node could not be found. | Broken edits remained in the workspace as a partial result. Originals remained in backups. |
| `02383c66` | Pasted test failures became “Identify problems and recommend corrections.” The run read only `tests/storage.test.js`. | Advice was marked complete. The only mandatory verification check proved that an answer was saved. |

The missing `STORAGE_KEY` export was introduced by the earlier repair. The preserved original exports it. The filter implementation in `src/work-orders.js` still had the original defect. The audit details are in `docs/agent-architecture-audit-02383c66.md`.

### Current ownership faults

The semantic router chooses one exclusive action category. Normalization can clear mutation and testing obligations when that category is inspection. The same interpretation controls tool pruning and completion, so both can agree with an incomplete task.

Conversation text carries task continuity. The classifier uses four recent messages, each limited to 300 characters. The loop uses six recent messages. Repeated partial answers displaced the original request in this sequence.

The context manager uses a GPT tokenizer estimate and can leave all user and system messages in an oversized request. The gateway can then change the transport representation. Admission does not count the final prompt used by the selected server.

File tools protect paths, locks, backups, and atomic writes. They do not bind ordinary replacements to source that the model received. Markdown can also be converted into workspace actions. These paths permit a fragment to replace an existing application file.

The command probe checks shell execution. It does not prove that the project's test runner and interpreter are available in the command environment. Document approval rules also appear in the common Agent prompt and prose correction path.

Evidence limits: production logs omit raw provider content and complete request bodies. The saved contracts, ledger, results, verification report, final messages, and backups establish the failures above. They do not prove every internal model decision or whether earlier writes came from native calls or Markdown conversion.

## 4. Proposed Architecture

### Responsibility and data flow

The renderer sends a saved message and task intent through the existing IPC bridge. RunManager validates the mode, workspace identity, and current task revision. The task store records the message and binds the run. The Agent controller builds a bounded context packet. The gateway prepares and exactly counts the selected transport. The model proposes one action. The policy guard checks that action, obtains any required approval, and the dispatcher executes it. The existing ledger and ResultStore save the outcome. Verification updates requirement evidence. The controller then selects more work or delivers a result.

The host owns task selection, requirement persistence, budget use, authority, file revision checks, and completion. The model owns proposed requirement interpretation, evidence selection, code edits, and explanation. Model output is always a proposal.

### Proposed project changes

Paths in this inventory are relative to `/Users/krishay/projects/agent`. “Add” means a proposed file. Existing modules retain ownership of their current safety boundaries.

| Owner or file | Proposed change |
| --- | --- |
| `backend/src/shared/contracts.ts` | Add Agent task, requirement, action, evidence-reference, read-receipt, and admission types. Extend snapshots with task identity and requirement status. Add `edit_file` to tool contracts. |
| `backend/src/main/persistence/db.ts` and `schema.sql` | Add schema 4 task tables and an atomic migration. Preserve current tables and existing rows. |
| Add `backend/src/main/run/agent-task-store.ts` | Own current task selection, append-only revisions, run bindings, requirement updates, and authorized access to earlier task evidence. |
| `backend/src/main/run/manager.ts` | Dispatch new Agent runs to v3. Bind task state before action execution. Stop using the exclusive semantic category to define Agent obligations or tool registration. Keep Chat and Work routing. |
| Add `backend/src/main/agent/agent-task-runner.ts` | Own the bounded host loop, action validation, budget use, requirement agenda, protocol recovery, and finish requests. Reuse the dispatcher, policy guard, and verification controller. |
| Add `backend/src/main/agent/context-packet.ts` | Assemble each request from durable state and selected evidence. Enforce packet allocations and save exactly which source ranges were included. |
| Add `backend/src/main/gateway/agent-admission.ts` | Count the prepared prompt through a verified server counter or matching local tokenizer and template. Validate the binding and total limit before generation. |
| `backend/src/main/gateway/model-gateway.ts` | Separate request preparation from dispatch. Apply admission after native or JSON formatting. Any transport fallback must be prepared and counted again. |
| `backend/src/main/gateway/registry.ts` and model setup handlers | Validate and persist tokenizer assets or server-counting settings. Expose verified, missing, and incompatible counting status. Keep local/private endpoint rules. |
| `backend/src/main/agent/tool-dispatcher.ts` and tool composition | Register tools from mode and environment. Use concise model-facing schemas without losing dispatcher capability. Validate one action before dispatch. |
| `backend/src/main/tools/workspace-tools.ts` | Add paginated observations and source receipts. Expose revision-bound edits. Existing-file complete replacement becomes an explicit operation. |
| Add `backend/src/main/harness/tools/edit-file.ts` | Apply unique exact replacements under the existing lock, path guard, backup, and atomic-write rules. Return before/after digests. |
| `backend/src/main/harness/policy-guard.ts` | Add edit authorization and revision-bound approval identity. Preserve protected paths, target restrictions, command matching, expiry, and fallback permission. |
| `backend/src/main/run/execution-ledger.ts` and verification modules | Persist call consumption, action receipts, requirement evidence, source revisions, and typed stop reasons. Separate applied work from accepted results. |
| `backend/src/main/agent/test-verification.ts`, `verification-stage.ts`, and command launch | Probe actual project execution support. Attempt a baseline when available. Classify environment failures separately from test failures. |
| IPC validators, Electron preload, frontend bridge declarations | Carry the task intent and snapshot additions through every boundary. Keep older caller defaults explicit. |
| `frontend/src/App.tsx`, `InputBar.tsx`, recovery and verification views | Add New task, current-task status, reply-only handling, and separate applied/verified/unavailable states. Preserve chat switching and saved drafts. |
| Agent, gateway, persistence, desktop, and scenario tests | Add the acceptance cases in Section 9. Restore original Flow D inputs only into isolated evaluation copies. |

### Existing paths to retire from v3 execution

The new Agent controller does not call intent-based tool pruning, use the old exclusive category as its completion contract, extract executable actions from Markdown, or append the document approval prompt to all tasks. The old Agent loop remains readable for historical interpretation and tests during transition, but it is not a silent fallback for v3.

ResultStore remains run-scoped. Earlier evidence is accessed through a task-authorized helper that verifies the originating run belongs to the same task. The implementation must not remove the existing run isolation checks to make continuity work.

## 5. Request Lifecycle

### Admission and task update

Implementation diagnostic: the 7B Flow D probe changed the case of a quoted source word and failed exact provenance before actions. The host now partitions the complete message into lossless source spans. The model selects `source_id`; the host constructs the stored quotation and offsets from the original message. `request` selects the complete message when an obligation spans several parts. Unknown or blank references and model-written quotations or offsets are rejected. Separate requirements may cite one span and receive distinct IDs. Historical task quotations remain readable. Span selection still requires separate scope review; it does not prove understanding. The complete request remains durable.

1. Save the user message first. Accept Agent mode, the selected model, current workspace identity, and `agentTaskIntent` of `continue` or `new`. Default to continue for Agent callers that omit this field.
   Ingest the complete request into an append-only task revision before counting setup. Mark its interpretation pending. Save a preparation reference for interpretation admission; it grants no workspace authority. A successful interpretation creates another revision and binds the execution run once. Failed setup or interpretation must leave the request pending, with its original text intact. A later continuation can select its source references. Pending requests block workspace execution and completion; status replies remain action-free. Earlier pending messages can supply new requirements, but a waiver or replacement still needs an instruction in the current message.
2. Resolve the current task in the chat. New task clears the current pointer and creates a new task. A different workspace identity requires a new binding; no prior side-effect authority transfers.
3. For a follow-up, interpret whether the message supplies evidence, continues execution, revises scope, or asks for an answer only. Persist that disposition. An answer-only run receives no workspace execution tools and cannot resume pending actions.
4. Preserve the complete message. Extract requirements with exact source spans. Before binding execution, obtain a separate bounded scope assessment against all original messages. Permit one persisted interpretation revision for missing scope, then stop with the request pending if scope remains unverified. A model status label is not a bypass. A direct host-recognized status question still takes no workspace actions. Retain this assessment as model evidence; it does not prove understanding. The assessment reviews each current or pending source span in a short request. The one missing-scope revision extracts only identified source gaps, then repeats the assessment. The host binds the exact source and constructs mechanical criterion fields. Adjacent instruction text and repeated contract fields are excluded from these review calls. Merge new proposals with the retained draft and existing requirements; an empty pass cannot erase an obligation. All calls use the same persisted budget. The model check schema must distinguish semantic checks from literal byte checks: a literal check needs an observed source path and cannot claim program execution. A removal or replacement must cite a later user instruction. Pasted logs are stored as evidence. Existing unresolved requirements survive extraction failure.
5. Save the task revision and run binding before any side effect. Show proposed requirements and relevant constraints in the existing approval preview for concrete mutations.

### One action cycle

1. Select one pending requirement and load relevant evidence references. Global constraints and all active obligations remain visible. Other requirements remain durable with stable IDs. A completed tool call does not establish requirement acceptance. Keep a repair in focus across its reads and edits. Persist unresolved requirement IDs from coverage review as work-selection feedback; they do not grant authority or replace completion checks.
2. Build the packet and prepare the actual native or JSON request. Count the complete prompt. If it cannot fit, reduce optional observations and page the evidence. Do not remove required constraints or cut an action payload.
3. Call the model with one action schema. Accept one structured tool call, a typed finish proposal, or an answer-only response. Multiple actions or malformed arguments receive one correction opportunity before Partial.
4. Validate the requirement ID, tool schema, workspace binding, source receipt, and budget. Apply the existing approval gate to side effects. Tool registration does not grant permission.
5. Persist an action attempt before execution. Recheck authority and source digest under the lock. Save the result, side effects, and evidence before starting dependent work.
6. After edits, invalidate acceptance tied to older revisions. Run required checks or record why execution is unavailable. A real test failure can enter one of the two existing repair cycles.
7. A finish proposal invokes host completion assessment. Check necessary delivery conditions before scheduling post-repair tests. A promise without a saved change cannot trigger another repair test attempt. While a required repair has no saved change, present action tools and require one action in native or JSON transport; retain the registered tool surface and host checks. Structured observations remain structured in the next request. Include a bounded source-observation index, recent action records, and references to complete execution evidence. Mark shortened feedback incomplete. If requirements remain and budget is available, return the specific gap to the next turn. Otherwise deliver Partial with retained work and a stop reason.

### Budgets and terminal behavior

Consume the model-call budget atomically before each task generation. Count requirement interpretation, action calls, semantic review, protocol correction, and final generation within the same 40-call run budget. Resume retains the counter. Count any retry that reaches generation. Fixed setup probes contain no task data and have a separate bounded setup record.

Retain existing configured call timeouts and cancellation. Permit one malformed-action correction per run and two test-driven repair cycles. Detect repeats using action arguments plus the relevant source and evidence revisions. A repeated unchanged failure cannot consume unlimited calls.

Implementation check: JSON actions now bind tool names to their argument schemas. Fresh packets retain active capability state, directory evidence, and a bounded agenda of source not fully observed at its current digest. Native and JSON transports preserve the same code bytes. Check cancellation after every generation await before using its output; an admitted dispatch without provider usage records a provider error and keeps the call consumed. Failed live probes on 30 October still show no repair. Fresh action requests now retain bounded current earlier source pages. A distinct context-limit response permits removal of whole optional pages before exact recount, with no model call consumed. The source-acquisition step now uses contained baseline failure locations and reported test paths to obtain up to four bounded source pages through the dispatcher. These paths select evidence; they grant no mutation authority. A later live probe still repeated directory listing: its interpretation classified the mixed repair sentence only as execution, so no repair requirements existed. The pre-action scope assessment addresses that control gap. The live repair remains unproved. The latest eight-call probe passed exact counting but stopped on a missing separate delivery obligation before any workspace action. This exposes a remaining dependency on model scope extraction. Investigate bounded source-clause contracts with precise missing-source references; do not weaken completion or authority checks to pass the evaluation.

Cancellation stops the current run and revokes its authority. The task and pending work remain saved for explicit continuation. A write with uncertain outcome blocks automatic replay. No budget, authority, or success claim is reconstructed from assistant prose.

## 6. API and Data Contracts

### Durable task and database shape

Propose schema version 4 with three new tables. Keep the existing message, run, ledger, result, artifact, and verification tables.

| Table | Required data and invariant |
| --- | --- |
| `agent_tasks` | Task UUID, chat UUID, workspace root or null, bound workspace metadata, current revision, current-task flag, status, timestamps. A partial unique index permits one current task per chat. The current pointer can remain on a completed task so later regression evidence can reopen it. |
| `agent_task_revisions` | Task UUID plus revision as composite key; source message UUID; validated snapshot JSON; timestamp. Revisions are append-only. Compare the expected revision during updates. |
| `agent_task_runs` | Run UUID as primary key; task UUID; bound task revision; message disposition; optional predecessor run UUID. A run binds once. Later requirement changes create another revision and run. |

Task status represents open work, completion, or a blocked/partial outcome. Run states retain their current public values. A status question can complete its reply run while the task still has pending repairs. The interface must show both facts.

| Contract | Minimum fields and rule |
| --- | --- |
| `AgentRequirement` | ID; kind of inspect/change/execute/preserve/deliver; description; exact message span; mandatory flag; dependencies; acceptance criteria. These kinds coexist. A requirement is not an authorization grant. |
| Requirement update | Append, supersede, or waive; expected task revision; source message and quotation. Supersede and waive require a direct user basis. Never delete historical requirements. |
| `TaskEvidenceRef` | Task ID, origin run ID, result ID, digest, relevant requirement IDs, and source revision. Verify run membership, result integrity, and current applicability on retrieval. |
| `AgentAction` | Call ID, requirement ID, operation name, validated arguments, short reason, task revision. Native and JSON transports normalize to this same contract. |
| `SourceReadReceipt` | Task/run/request ID, canonical relative path, complete-file digest, included line or byte ranges, and completeness. The host records receipts for the source actually included in an admitted request. |
| `AgentTaskView` | Task ID/revision, status, requirement states, applied changes, passed checks, unavailable checks, remaining work, and latest run. Expose through the existing run snapshot. |

Requirement presentation offers literal-copy checks only when the supplied current or pending user text has a direct literal-copy basis. Source extraction offers semantic checks unless the selected source contains a direct literal-copy basis. Literal checks remain limited to inspection and delivery. Ingress still checks the exact quoted path and instruction; presentation does not authorize an operation.

Acceptance checks can select `verbatim_source` with a quoted source path when the user explicitly requests exact file content. The host checks complete observed byte coverage, the current file digest, and a raw or fenced literal copy. This check cannot establish program behavior. A separate scope audit still checks the original request. Other criteria retain semantic review and required execution proof. The model must select a check operation in its structured requirement response; the host does not infer a test pass from words in an answer.

### File observation and edit contracts

`read_file` gains start position and bounded length. Return path, file digest, included ranges, complete flag, result ID, and continuation cursor. Use line ranges for normal code and byte ranges for an oversized single line. Preserve UTF-8 boundaries. Search and directory cursors bind to their query and source revision. Changed input invalidates the cursor.

`edit_file` requires path, expected digest, requirement ID, reason, and a nonempty array of exact old/new replacements. Each old value must match once in the expected source and lie within observed ranges. Reject overlaps. Validate all replacements against the same pre-edit bytes before writing anything. Apply one atomic file replacement and return backup path plus before/after digests.

`write_file` remains available for new files. Replacing an existing file requires an explicit replacement flag, expected digest, and a complete source receipt. If the full source or proposed replacement cannot fit, use bounded edits instead. Approval binds the operation, source digest, and proposed content digest. A changed proposal requires fresh approval under the applicable scope.

Implementation check: request repacking now pages immutable source at UTF-8 boundaries and records only actually admitted ranges. Every source page supplied in a packet informs the read agenda. Removed pages become readable again after tool definitions are rebuilt. Result retrieval preserves structured payloads, parent lineage, and explicit completeness; it cannot promote retrieved model-derived data into original source evidence. The focused check passed 243 tests, with one live test skipped. Live repair and bounded per-requirement completion review remain open.

Completion implementation: semantic reviews now use one active requirement per request and reduce optional source slices after an exact admission rejection. Separate source-span audits retain the original request coverage check, including earlier explicit waivers. Literal-copy tasks use host byte comparison plus bounded source-span scope audits. Saved successful file outcomes carry before/after digests; approval evidence cannot replace an operation result. Current bytes are checked before and after review, including text edits, new files, and deletion. These checks do not resolve the separate repair-transition defect seen in the latest 18-call 7B trace.

Operation scope implementation: file mutation proposals are now assessed against their quoted user instruction, complete source message, acceptance checks, and active constraints. An exclusive change label no longer controls whether they can reach approval. The scope audit checks obligation content and acceptance checks rather than label separation. This model interpretation cannot grant authority. Source validation runs before and after the assessment await, followed by concrete approval and the existing lock, backup, protected-path, and revision checks. An isolated 7B proposal-scope diagnostic correctly accepted a requested repair and rejected an explicit no-edit case, with matching counts and no file writes. Full live repair remains unproved.

### Gateway and tokenizer contract

The gateway prepares a request before sending it. Preparation produces the final payload, selected transport, model identity, template identity, and output reservation. Admission returns exact input tokens, reserved output tokens, context limit, safety reserve, counter identity, and a digest of the prepared request. Dispatch requires a matching admission receipt.

For v3, the rule is: **input tokens + reserved output tokens + safety reserve must not exceed the effective context limit**. Use the lower of 8,192 and the verified server limit. Missing or unverifiable limits block generation. A transport fallback produces a new payload and requires new admission.

| Packet part | Initial token target |
| --- | ---: |
| Common instructions and current step | 640 |
| Tool definitions | 1,024 |
| Task requirements and progress | 1,024 |
| Selected source and execution evidence | 2,944 |
| Reserved output | 2,048 |
| Safety reserve | 512 |
| Total | 8,192 |

These allocations guide packing. The exact final rendered count controls admission. Smaller interpretation and final-answer calls reserve less output. If essential content exceeds the input budget, split the work. Return Partial with a scope request if it cannot be split safely. No broad conversation transcript is appended.

A counting profile selects either a server facility for the prepared request or local tokenizer assets plus the exact active server template. Local assets include tokenizer configuration and special-token definitions. Store their digests and the selected transport. Use the standalone Hugging Face tokenizer and Jinja packages, with versions pinned during implementation after package and runtime checks. Do not load weights, download assets automatically, or execute remote model code.

Fixed setup probes must compare local and provider input counts for plain messages, tools, tool results, Unicode, and the selected JSON/native transport. Cache verification by endpoint, model identity, assets, template, and transport. Invalidate it on a binding change or any observed usage mismatch. A probe match is sampled compatibility evidence; the server's exact template must still be established. A family-name match or a generic `/v1` endpoint is insufficient.

If the server hides its active template or cannot provide compatible count evidence, v3 remains unavailable for that profile. There is no approximate admission fallback. This restriction and its setup cost are part of the requested exact-count design.

### Public boundary changes

Add optional `agentTaskIntent: continue | new` to start-run input, validated only for Agent. New task is disabled while that chat has an active run. Clear the frontend intent after successful submission so a retry cannot accidentally start another task. Bind a duplicate saved message to the existing run rather than duplicate execution.

Add optional task view and admission status to run snapshots and typed progress events. Carry them through validators, preload, renderer declarations, and frontend wrappers. Chat and Work callers need no new field. Existing `RunContract` records remain valid. V3 stores behavioral requirements in task revisions and uses existing run contracts only for compatible run-level operation/export records; it must not derive its task obligations from the old exclusive route.

## 7. Consistency Idempotency and Replay

Task revision updates and run binding occur in one database transaction. A revision conflict rejects stale work. The existing one-active-run-per-chat and workspace execution slots remain in force.

Cross-run evidence is read through the task store. It opens the origin run's ResultStore only after checking task membership and workspace binding. Source evidence may explain history but cannot authorize an edit to a newer file. Acceptance evidence becomes stale when any relevant implementation, test, configuration, source input, or task requirement changes.

| Event | Required response |
| --- | --- |
| Duplicate message or action ID | Return the saved binding or outcome. Do not repeat a completed side effect. |
| Repeated read | Reuse valid saved bytes or perform a fresh read if the source revision changed. |
| Stale edit or approval | Reject before mutation. Read current bytes, propose a new edit, and obtain any required approval. |
| Result persistence fails after a write | Retain backup and mark the attempt uncertain/Partial. Reconcile bytes before any explicit retry. Do not claim success. |
| Application restarts | Mark active execution interrupted, expire approvals, restore task state, and await explicit resume. |
| Model, template, or transport changes | Invalidate admission verification. Count and verify again before generation. |
| Workspace registration changes | Revoke action authority. Confirm a fresh binding even if the canonical root is the same after restart. |
| Tests fail or cannot start | Keep applied edits and backups. Record failed or unavailable evidence and remaining requirements. |

### Forward migration and rollback

Before schema upgrade, stop other writers for that profile and create a consistent SQLite backup using a SQLite backup facility that includes committed WAL data. Do not copy only the main database file. Apply the new tables, indexes, and version marker in one transaction. Reopening schema 4 must be idempotent. No existing task history is fabricated from old assistant text.

Historical v2 runs remain readable. Explicit continuation creates a linked v3 attempt from the saved original user request, available evidence, and current source revisions, with fresh approvals. Missing original inputs produce Partial and a visible gap.

The current older application rejects a future schema version. Therefore an old binary and a schema-4 writer must not share a profile. The operational rollback is a schema-4-compatible build with v3 admission disabled while keeping history and Chat/Work available. Restoring a schema-3 backup is a separate recovery action; it can omit later records and must never happen automatically.

## 8. Security and Privacy Considerations

Keep `resolveSafe`, canonical path checks, symlink rejection, protected paths, locks, and scoped approvals at the tool boundary. Add revision checks inside that boundary. A requirement, model reason, read receipt, or visible tool does not grant side-effect authority.

Commands continue to use the existing command snapshot and publication checks. V3 approval binds the complete executable command and snapshot identity, including the root, file content and modes, directory names, and input link targets. Recheck that identity before command execution and before publication. Changed unrelated inputs also invalidate publication. Persist the concrete approval receipt before execution. Preserve the OS isolation probe and explicit disclosure and approval for execution without isolation. Resolve interpreter paths within the same environment and isolation rules used for the actual test command. Do not solve a missing runtime by silently broadening filesystem access or installing tools.

Use the current local/private endpoint validation for generation and server counting. Reject redirects outside the approved endpoint boundary. Treat tokenizer files and templates as data, impose resource limits, and never execute downloaded code. The project owner has deferred exact vision counting. For this version, use a fixed file-extension estimate and label it as an estimate. Exact text counting remains mandatory. A text counter must never report an image estimate as exact evidence.

Keep full source, logs, and messages in local scoped storage. Default telemetry records IDs, digests, counts, durations, and typed reasons. Do not put source bodies, credentials, or complete command output into default telemetry. Preserve existing credential handling. New task and revision records follow chat retention and deletion, with no public sharing or independent retention service.

## 9. Operational Readiness

### Verification behavior

Discover existing project tests and probe the actual interpreter and package manager. Run a requested baseline before edits when available. Record baseline failures as evidence. An unavailable runner is an environment blocker; approved edits may still proceed. Cache that blocker for the unchanged environment so the same command does not fail repeatedly without new information.

After code changes, select related existing tests when mapping is reliable. Otherwise run the affected suite. Honor a full-suite request. Preserve the current revision-bound machine-report checks and two repair cycles. A program launch or a printed marker cannot substitute for project tests.

Completion requires every mandatory task criterion to have current accepted evidence or a direct user waiver. A separate bounded semantic review compares the original request and requirement coverage with the evidence. It cannot turn failed tests into a pass. Unsupported semantic conclusions remain unverified. A saved final answer proves only delivery of text.

### Required acceptance cases

| Area | Required proof |
| --- | --- |
| Task continuity | The original mixed request keeps inspection, both fixes, preservation, and full-suite testing. Repeated partial messages and pasted failures retain them. A regression reopens affected criteria. |
| Read-only behavior | A deliberate inspection remains read-only. A status question produces an answer without file writes, commands, or resuming pending work. |
| Source integrity | Stale digests, unseen anchors, overlapping edits, changed approvals, and incomplete whole-file replacements are rejected. Markdown examples never become actions. |
| Exact text admission | Count all v3 text task calls after formatting, including interpretation, review, JSON fallback, and retries. Unknown tokenizer/template, mismatched usage, and oversized essential context block generation. Vision uses the explicitly labelled temporary estimate from Section 11. |
| Environment failure | Missing Node permits approved edits but keeps mandatory tests unverified. Distinguish discovery failure, missing executable, failed tests, timeout, and invalid report. |
| Authority and recovery | Rejected approval, cancellation, restart, workspace changes, duplicate requests, uncertain writes, and stale revisions do not replay or expand authority. |
| Compatibility | Schema 3 upgrades without losing records; schema 4 reopens idempotently. Chat and Work contracts, mode boundaries, drafts, and recovery checks continue to pass. |
| Flow D | Begin from preserved originals in a new evaluation copy. Check filter and storage repairs, original exports, app startup, UI rendering, search/status interaction, and status persistence. Do not weaken tests to obtain a pass. |
| Other Agent workloads | Existing document, knowledge, visual-source, and attached-repair scenarios keep their required evidence and side-effect rules. Unsupported counting capability is a visible setup failure. |

Use the existing Electron test runtime for an isolated Flow D browser check. Serve only the evaluation workspace from loopback, disable Node integration in the page, and capture startup errors. Check normal storage and invalid saved data. The independent evaluator checks the app as delivered; changes made by the agent to its own tests cannot define evaluator success.

### Release gates and signals

Current scope decision: release certification is deferred. Implement and improve the harness for 7B–14B models; use the available 7B and 9B models for development checks. The user will perform 14B trials manually. This deferral does not waive implementation safety, exact admission, truthful completion, or useful packaged-environment checks.

| Signal | Proposed release requirement | Current evidence |
| --- | --- | --- |
| Live repair rate | Separate release target: at least 9 of 10 fresh-workspace trials per selected model at 8k | Deferred by the user; implementation diagnostics on 7B remain failures. The user will test 14B manually. |
| False completion and unauthorized mutation | Zero in fault-injection cases and live trials | Source boundary tests pass; failed live diagnostics claim Partial and have applied no changes. Full release certification is deferred. |
| Context admission | Every task generation has a matching verified count receipt; zero oversized dispatches | Implemented and tested at the gateway. Latest diagnostic blocked an oversized next request before dispatch. |
| Model/template drift | A changed binding blocks generation until reverified | Source checks pass; packaged behavior remains to be checked. |
| Packaged execution | Minimal launch environment; startup, missing tools, interruption, and resume pass | Not run for v3 |
| Migration and rollback | Preserve old records, pass repeat-open checks, and exercise the compatible rollback build | Additive migration and backup checks pass in source tests; compatible rollback build exercise is deferred with release certification. |

Record per-call latency, queue time, input/output tokens, selected requirement, task revision, counter identity, build identity, tool outcome, repair count, and stop reason. The first release prioritizes correctness; this report does not invent a latency SLO without measurements.

All figures above are proposed acceptance targets. They are not achieved results. Run type checking and focused tests after each approved structural milestone. Source-worker checks alone cannot certify the packaged application. Production v3 promotion remains closed until the required evidence is saved for the exact release build.

## 10. Alternatives Considered

| Alternative | Benefit | Decision and tradeoff |
| --- | --- | --- |
| Tune the current router and add retries | Small initial change | Does not separate the user goal, available tools, and completion proof. Excluded from this redesign. |
| Append more chat history | Easy continuity change | Exceeds the 8k budget and keeps operational truth dependent on prose. Use durable task state and retrieval. |
| Use token estimates with extra reserve | Broad server compatibility | Conflicts with the chosen exact-count requirement. Unverified profiles will be blocked instead. |
| Stage all edits in a task copy | Can keep failed repairs out of the active project | User selected direct edits. Add source checks, backups, and truthful Partial status. Failed edits can remain in the project. |
| Add planner and worker agents | More specialized model prompts | Adds coordination and context overhead. Use one model with short host-managed steps. |
| Replace the whole application framework | A uniform new lifecycle | Expands migration scope. Extend the current manager, ledger, storage, scheduler, and guards. |

## 11. Open Questions

Implementation is approved. The project owner supplied these setup decisions:

1. Use LM Studio for development. Its selected driver assets are in `~/.lmstudio/models/lmstudio-community/Qwen2.5-Coder-7B-Instruct-MLX-4bit/`. Load only tokenizer and template data. Never load model weights in the app's counting code.
2. Pin current counting dependencies. The implementation pins `@huggingface/tokenizers` 0.2.0, `@huggingface/jinja` 0.5.11, and `@lmstudio/sdk` 1.5.0. The requirement schema is generated from the host Zod validator with pinned `zod-to-json-schema` 3.25.2, which was already installed as a transitive dependency. Electron remains pinned at 44.7.0. LM Studio's SDK can render and count a prompt without generation. Compare its result with local rendering and provider usage; do not assume that all API conversions are equivalent.
3. Defer exact vision counting. Use a fixed file-extension estimate for this version and label it explicitly. Establish exact processor counting in a later version.
4. Use port 1234. Both `127.0.0.1` and the user-supplied private address `192.168.0.140` responded during setup. The driver is `qwen2.5-coder-7b-instruct-mlx`; vision is `qwen/qwen3-vl-4b`; embeddings is `text-embedding-nomic-embed-text-v1.5`. The loaded driver reports an 8,192-token context and no native tool training. Certify its JSON transport first.

Four live JSON transport setup probes matched local counts, server counts, rendered prompt digests, and generation usage on 27 October 2026. Counts were 22, 40, 89, and 40. Evidence is saved in `docs/evidence/agent-counting-live-probe-2026-10-27.json`. This is setup evidence for that loaded instance. It does not certify every gateway path, native tools, model drift, packaged execution, or repair quality. A representative 14B model and its required trials remain a release gate.

## 12. Decision and Next Steps

Recommend this design for implementation review. The key change is to preserve task obligations independently of the model's next action, and to require current evidence before task completion. The model works within an exact context budget while the existing host retains mutation authority.

| Milestone | Proposed deliverable | Exit condition |
| --- | --- | --- |
| M0 — design approval | This text LLD report and a reviewed change inventory | Approved by the project owner with the setup decisions in Section 11. |
| M1 — task continuity | Additive task storage, run bindings, requirements, snapshot fields, and New task intent | Migration, follow-up, reply-only, and old-record tests pass. |
| M2 — bounded model execution | Verified exact counting, packet builder, and the v3 action loop | Native/JSON admission, drift, context limits, call budgets, and protocol checks pass. |
| M3 — edits and proof | Revision-bound edits, approvals, test capability handling, task completion, and recovery UI | Source integrity, verification, interruption, and mode-boundary checks pass. |
| M4 — certification | Isolated Flow D evaluation, existing Agent workload checks, packaged checks, and live model trials | All required release gates pass for the saved build identity before production promotion. |

Review anchors: Section 4 lists the proposed code ownership changes; Section 6 defines the interfaces; Section 7 defines the migration and rollback; Section 9 defines the proof required. Direct edits can leave unverified changes in the project. Exact counting can make an otherwise reachable model unavailable for Agent v3. These are explicit consequences of the selected design.

### Source basis

- User decisions in this chat: Agent first, direct edits, continued task by default, unverified edits allowed, exact counting, reliability first, and design approval before code changes.
- Production evidence and code references in `docs/agent-architecture-audit-02383c66.md`.
- Existing manager, semantic router, contract, execution ledger, ResultStore, context manager, gateway, policy guard, workspace tools, verification stage, IPC validators, frontend bridges, and recovery code inspected in this workspace.
- Selected System Design template: its 12-section structure is retained. The requested text-only format replaces its visual formatting and diagram slot.
