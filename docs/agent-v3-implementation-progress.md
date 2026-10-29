# Agent v3 implementation progress

Status: implementation is in progress. Production v3 promotion is closed.

This file tracks the approved scope in `agent-harness-system-design-lld.md`. It is not a smaller replacement for that scope. The current turn made code changes and produced live counting evidence. It is a progress turn.

## Implemented foundations

- Schema 4 adds task, append-only revision, and run-binding tables. Existing records keep their original mode and evidence. Upgrades use a consistent SQLite serialization backup under an immediate writer transaction. A test confirms that the backup includes committed WAL data. Repeat opens do not repeat the backup.
- The task store saves complete user messages, stable requirement IDs, source spans, acceptance descriptions, dispositions, and run/revision identity. It rejects stale revisions, another chat or mode, duplicate attempts, simultaneous runs, and workspace identity changes. A new task keeps earlier task history. Evidence and status dispositions cannot edit requirements. A scope revision needs an exact user quotation. These checks validate provenance, not correct understanding.
- Cross-run retrieval checks task membership, requirement identity, saved result digests, and file integrity. ResultStore itself remains run-scoped. Historical source revisions do not establish current applicability.
- The existing execution ledger supports a bound v3 task, 40 persisted generation calls, and one persisted protocol correction. Rebinding and restart do not reset these counters. Stopped runs cannot consume generation calls without explicit resume. Gateway dispatch now consumes the persisted budget after admission. Retries and transport fallbacks each consume a call.
- Local counting loads tokenizer data and Jinja from local files. It uses workers with memory and time limits. It records asset, template, and rendered-prompt digests. The gateway now checks the final payload after streaming and transport formatting. It compares local rendering and counting with the loaded LM Studio instance before dispatch. The 512-token reserve and output reservation must fit within the verified context bound. Missing setup and model, template, or count drift block dispatch. Oversized evidence does not erase valid setup evidence.
- Counting setup evidence is stored in host-only database metadata. Each endpoint, model, and transport has its own binding. Provider usage must match before the gateway returns an action. A mismatch expires the setup record. Admission receipts include task revision, request and template digests, counts, counter identity, and a build identity. Desktop builds receive a unique build identity; source tests are marked `source-unbundled`.
- The approved temporary vision exception uses fixed costs by source extension and a text estimate. It records `vision_estimate` and `estimate_used`, with no claimed template digest or exact count. Only a host-prepared vision request can use this path. Text requests still require exact admission.
- An LM Studio counter uses the server's rendered prompt and token-count facility. It uses an already loaded model and pins each operation to its instance reference. It does not load weights. Unsupported input conversions fail visibly.
- Dependencies are pinned: Hugging Face Tokenizers 0.2.0, Jinja 0.5.11, LM Studio SDK 1.5.0. Electron remains 44.7.0.

## Evidence collected

The loaded driver was `qwen2.5-coder-7b-instruct-mlx`, at an 8,192-token context. HTTP worked through both loopback and `192.168.0.140:1234`. The CLI daemon path failed independently. The SDK connection worked when the shell tool had local-network access.

Four JSON transport probes tested plain messages, tool definitions in the prompt, an earlier tool result, and Unicode. Local rendered digests matched server rendered digests. Local counts, server counts, and generation usage matched at 22, 40, 89, and 40 tokens. Evidence: `docs/evidence/agent-counting-live-probe-2026-10-27.json`.

This evidence covers those fixed probes and that loaded instance. It does not establish repair success or certify all future requests. No live repair trial has run. Isolated live inspection probes now exercise the new loop; they are not repair certification.

The real gateway then admitted a JSON transport request at 145 input tokens. Provider usage also reported 145. The saved receipt reached `usage_verified`. Evidence: `docs/evidence/agent-gateway-live-probe-2026-10-27.json`. This was a source-runtime check, not a packaged-app check or repair trial.

The latest focused offline run passed 229 tests across ten files; one opt-in live test was skipped in that offline run. The separate live run passed all three tests in `lmstudio-token-counter.test.ts`, including actual gateway dispatch. Full project type checking and the Electron build passed. `git diff --check` passed. `agent-gateway-boundary.test.ts` checks final streaming payloads, native/JSON fallback, JSON format retry, provider usage failures, drift, authority rechecks, call limits, and the vision exception. Existing database, storage isolation, ledger, gateway, and three-mode checks also passed.

## Integrated host loop and source operations

The non-production preview now selects `agent-v3` when `WORKBENCH_AGENT_V3=true`. Production promotion stays closed. RunManager binds the saved user message and workspace registration, prepares counting profiles, then enters the new host loop. Chat and Work retain their execution paths.

The loop uses a restricted requirements phase, durable task binding, fresh context packets, one validated action per call, a persisted 40-call limit, one protocol correction, and saved proposals and observations. Status replies do not dispatch workspace tools. Advice cannot complete a change requirement. The host runs a separate coverage review before delivery and marks the task complete only after the final answer is saved and run verification accepts it.

Source tools now return bounded pages and revision-bound cursors. The host records source receipts only after a verified admitted request includes the source. `edit_file` checks unique observed anchors and the expected digest before approval and again under the file lock. Edits use backups and atomic writes. Existing-file replacement and deletion need a complete current read. Concrete file approvals bind the operation digest. Markdown examples cannot become actions in v3.

Baseline and final tests use the existing verification stage and repair limits. A missing check can leave approved edits in place, but completion stays Partial. The current environment probe and test agenda still need further work below.

Live inspection exposed two separate failures. The model initially returned action JSON inside Markdown fences. Those examples remained text and caused no tool action. The JSON action transport now requests a constrained single-action envelope where supported; the host still validates the operation and authority. Rejected examples use the one protocol correction and are saved as rejected responses. The selected LM Studio server accepted the structured format. Counting still checks the final request and provider usage.

The next live probes reached source reads but coverage review rejected the reported source text and the loop stopped on repeated actions. Source evidence is now unwrapped before review. Model proposals and old reviews are excluded from source/execution proof. This closes a review feedback path; live success remains unproven. An interpretation correction also exposed an adjacent-user-message rendering mismatch. Corrections now stay within one bounded user packet. The exact admission guard blocked the mismatched request before generation.

## Task controls and explicit resume

The renderer now has a New task action for chats with a v3 task. It is disabled during execution. The choice stays in its owning chat and survives a failed send. A successful Agent submission clears it. A Work submission does not consume the Agent choice or send task intent. The host exposes v3 availability separately from historical engine identity. A task remains visible in the snapshot after another mode runs in the same chat.

The desktop check found a stale loading flag when a new blank chat opened while an older history load was pending. The new view now clears that old flag. Existing draft, attachment, storage failure, recovery, and linked-attempt checks pass with the new task controls.

V3 now reuses the persisted run contract on explicit resume. A manager test confirms that it keeps the same task revision and adds to the existing call count without repeating requirement extraction. This proves same-session resume. Backend restart, workspace-registration renewal, and legacy-to-v3 continuation still need separate proof.

The final desktop interface check passed with a fixture bridge and real draft storage. It checked default continuation, per-chat New task choice, failure retention, one-shot reset, the disabled control during execution, and the Work boundary. Evidence: `docs/evidence/agent-task-controls-2026-10-29.json`. This is not a packaged-backend check.

## Baseline and full-suite discovery

An empty changed-file list previously produced zero test plans. The verification stage could report a pass without a test execution. Baseline and explicit full-suite requests now discover the roots of existing tests and select full suites. A project with no usable tests returns an unavailable check. The stage also rejects success without saved execution evidence.

A failed baseline is historical evidence, not a mandatory completion failure after a repair. It does not spend the two test repair cycles. The final repaired revision still needs mandatory passing tests or a direct user waiver.

Type checking passed. The focused run passed 43 tests across four files, with one opt-in live inspection skipped. This covers full-suite discovery, empty projects, actual baseline failures, repair allowance, existing real test execution, and the v3 host boundary. The reporter test now selects its reporter through Node's CLI because Electron can disable NODE_OPTIONS in a child; it still executes the existing test and reopens the generated report.

## Host source checks and scope review

The reviewer diagnostic isolated a wrong rejection. The 7B model rejected both byte-identical source delivery and incorrect content. Input counts matched provider usage. Changing prompt wording or evidence framing did not resolve it. Literal byte comparison therefore belongs to the host.

Requirements now select an explicit check operation. `verbatim_source` is valid only for a direct request for exact file content and a quoted source path. The host compares real source observations with current file bytes, requires complete range coverage, and checks the raw answer or a complete fenced quote. Partial pages, forged content, stale digests, changed line endings, and arbitrary text for an empty file fail. These checks do not establish software behavior or authorize a mutation. A separate model scope audit still checks the full original request. Uncovered semantic criteria retain their review and execution requirements.

Requirement responses use a JSON schema generated from the same Zod validator used at ingress. This avoids a model omitting an optional check field. The existing installed `zod-to-json-schema` dependency is now direct and pinned at 3.25.2. The schema distinguishes source inspection from program/test execution. Invalid interpretations retain the complete request and use the existing single correction limit. Source quotations and schema validation still do not prove understanding.

Source reads now bound allocation before reading and reject a file that grows during observation. The read, edit, replacement, and literal-check paths share this bounded reader. Path containment, locks, backups, and digest checks remain in force.

A failed literal answer can be corrected from saved source evidence. It does not need another file read. An identical repeated answer for unchanged evidence stops with `repeated_delivery`. These calls retain the persisted 40-call budget across resume.

The live reviewer diagnostic now accepts byte-identical and quoted content and rejects wrong content. The full 7B inspection passed twice, including the final source runtime: four calls with exact admission and matching usage, one read, zero mutation approvals, and unchanged source. This is a narrow inspection result. It does not establish live repair reliability. Saved before/after diagnostic and final-loop evidence: `docs/evidence/agent-literal-delivery-2026-10-29.json`.

The final focused run passed 277 tests across 15 files; three opt-in live checks were skipped in that offline run. Type checking and the Electron source build passed. The live scope/reviewer and full-loop runs were separate opt-in checks. Packaged execution and the required repair trials remain open.

## Command source authority

V3 command approval now binds the exact executable command to the complete command snapshot. The snapshot identity includes the workspace root, file bytes, file modes, directory names, and input link targets. The approval preview shows its source revision and active preservation requirements. The approved operation and digest are saved before execution. Python check arguments are normalized before approval, so the preview contains the command that will run.

The command boundary checks that binding after the isolation probe and before executing user code. It checks the complete input snapshot again before publishing successful command changes. A change to another input, a new input, or a removed input invalidates publication. Existing backup, protected-path, cancellation, fallback disclosure, and exact command checks remain. The legacy command path remains compatible. Approval for execution without OS isolation still permits user-level access; snapshot checks do not add OS isolation.

The focused check passed 199 tests across five files, with one live inspection skipped. Full type checking passed. Tests include the full workspace-tool path, a workspace change during approval, changed inputs before execution, substituted command/source grants, changed unrelated inputs during execution, and v3 calls with no revision-bound approval. Chat and Work boundary tests passed. General task constraint enforcement and live repair checks remain open.

## Host repair focus

The host no longer moves past a change requirement because one tool call succeeded. An initial inspection can obtain source evidence, then a repair stays in focus across reads and several edits. Every action request lists all active obligations and their acceptance checks. The model can select another active requirement ID. A coverage review can name unresolved requirements; this feedback persists in the run ledger and directs later work. It does not establish acceptance, change requirement state, or grant authority.

The focused check passed 48 tests across four files, with one live inspection skipped. Full type checking and the Electron source build passed. One host test makes two observed edits while testing is unavailable, retains all three obligations, and returns Partial without consuming a test repair cycle. Another test uses a separate coverage review to move from the first repair to the remaining repair. General evidence selection still needs work: the semantic review currently receives only the latest three source/execution slices. These scripted tests do not establish live repair quality.

## Live Flow D interpretation diagnostic

The new opt-in repair diagnostic copies a prepared pristine Flow D workspace into a disposable directory. Approval permits only the discovered full-suite commands and the two repair modules. Other original files are protected. It records prepared requests, saved results, source digests, approvals, and an independent test execution. The incident workspace remains untouched. This diagnostic is not the packaged or independent UI release check.

Three fresh-workspace probes stopped before workspace actions. The first two exposed an invalid check combination allowed by the model schema: `verbatim_source` with an execution check and a null path. Exact counts matched provider usage. Captured requests show that the full instructions and correction reached the transport. The check schema now uses disjoint semantic and literal variants. The host and model schema both reject invalid combinations. This change does not establish correct interpretation.

The next live probe passed that check shape but failed exact source provenance. The model capitalized a word in a quoted instruction, so the quoted span did not exist in the original request. Both attempts were rejected. No approval or mutation occurred; the outcome stayed Partial. Saved evidence: `docs/evidence/agent-flow-d-interpretation-2026-10-29.json`.

The next implementation step is host-owned source spans. The model should select a supplied span reference; the host should construct and validate the exact source quotation. It must retain the full request and check scope separately. Do not weaken quotation checks, ignore missing repairs, or turn this failed diagnostic into a passing repair trial.

The offline schema and host-loop check passed 30 tests across two files, with one live inspection skipped. Full type checking passed. Live repair certification remains closed.

## Host-owned source spans

Requirement interpretation now selects a host-supplied source reference. The host partitions the complete original message without dropping or normalizing text. It constructs exact stored quotations and offsets from the selected original span. The model can select the complete request when an obligation spans several parts. Unknown or blank references, model-written quotations, and model-supplied offsets are rejected. Historical task records keep their existing quotation format; no migration is needed. Two repairs can cite one span with distinct IDs that remain stable once saved. Span selection establishes provenance only. Correct interpretation and full requirement coverage still require separate checks.

The focused check passed 46 tests across four files, with one live inspection skipped. Tests cover Unicode, BOM, CRLF, repeated source text, several repairs from one span, unknown references, forged offsets/quotations, and waiver provenance. Full type checking and the Electron source build passed.

Live validation of this change has not run. Two elevated SDK test requests expired in automatic approval review before process creation. Normal execution then reached the SDK setup boundary but received EPERM for both `127.0.0.1:1234` and `192.168.0.140:1234`. There were zero admitted model calls and zero workspace changes. This is a tool-permission limit, not evidence that LM Studio is down or that the source-span protocol works with the real model. Evidence: `docs/evidence/agent-source-spans-setup-2026-10-29.json`. Production promotion remains closed.

## Pending request ingestion and approved live checks

The complete request is now ingested into an append-only task revision before tokenizer setup or interpretation. A preparation reference labels interpretation admissions with task ID and revision, but grants no workspace authority. Successful interpretation creates a new immutable revision and binds the run once. Setup or interpretation failure leaves the request pending. A later continuation can select its original source spans. Repeated ingestion is idempotent. New task starts a separate objective. Earlier v3 records incorrectly labeled as evidence after a recorded interpretation failure are preserved as pending in a new revision; old snapshots remain intact.

Pending originals block workspace execution and completion. A status reply can describe them without workspace actions or marking the task complete. Earlier pending messages can supply new requirements. They cannot supply a waiver or replacement for existing work; that still needs an instruction in the current user message. Model-call counts and the one correction limit remain persisted across resume. Preparation admission checks the saved task, source message, workspace, and revision again before generation. Coverage review now receives every original message with its disposition label. A model classification as status or evidence cannot remove the raw message from that separate audit.

The user approved the isolated local test after the tool review timeouts. The real 7B model then extracted seven obligations with exact host-created quotations. It stopped on a host approval-receipt defect: the task-level baseline had an undefined requirement ID. The receipt now stores an explicit null. The next run executed the baseline under OS isolation and reproduced all five failing module tests. Seven model calls passed exact admission and provider-usage checks. The model then repeated directory listings and future-tense replies without reading source or applying edits. The host stopped with Partial and `repeated_action`; it claimed no repair. Evidence: `docs/evidence/agent-pending-ingestion-live-2026-10-29.json`. These are source diagnostics, not release trials. Selected runtime source digests are now captured at the start of future live diagnostics.

The focused check passed 220 tests across six files, with one live inspection skipped. Full type checking and the Electron source build passed. The next host-loop work is to assess delivery prerequisites before running post-repair tests, present a smaller task-relevant action surface, and supply bounded useful baseline evidence. The saved trace still shows the agentic execution fault; do not treat extraction or baseline success as a completed repair.

## Action phase, observation state, and canonical listings

The host now checks necessary delivery conditions before post-repair testing. A future-tense reply without a saved change cannot spend another test attempt or stop approved edits merely because tests are unavailable. The model action request uses required tool choice. JSON transport requires one call when requested. Finish is presented after the necessary change condition is met; a provider that ignores that presentation still cannot bypass host completion checks. Registered capabilities and approval rules remain authoritative.

Tool presentation removes schema guidance while preserving named fields, validation constraints, and literal data. Complete structured directory and search results are passed as structured values. Feedback is bounded and explicitly marked incomplete when shortened; complete test evidence remains in ResultStore with references in the packet. A bounded source-observation index and recent action records now carry operational state between fresh requests. Historical source digests do not establish current applicability or requirement acceptance.

A regression check found that directory listing mixed a canonical target path with a noncanonical workspace root. The earlier live trace contains long parent-relative names under `/private/var/...`. The helper now uses one canonical root, and checks each child before inspection. Alias tests confirm returned names can be used for reads; an outside-workspace link is not traversed. Chat and Work boundary checks still pass.

The focused check passed 242 tests across seven files, with one live inspection skipped. Full type checking and the Electron source build passed. Live checks remain failures, saved in `docs/evidence/agent-action-phase-live-2026-10-29.json`. With the first action-phase changes, the model read the README but repeated it. With observation state, it requested `npm test`; the evaluation originally allowed only the exact discovered `npm test --` command. The evaluation now also accepts the exact `npm test` and `node --test` aliases only for this fixture's one unchanged test script. This does not widen app command scopes. The next probe instead repeated a document-capability request and stopped Partial. No source edit or repair pass occurred.

The remaining contract fault is visible in the prepared requests: JSON transport constrains the tool name but leaves its arguments as a generic object. Capability state is also absent from the fresh request. Bind argument schemas to their selected tool, expose active presentation state, and prevent repeat activation of an already visible group. Keep task-relevant registered tools reachable. The live repair target is still unproved.

## Typed actions, source agenda, and cancellation

JSON transport now binds each tool name to its argument schema. Multiline line arrays decode to the same action as native strings; literal backslashes, Unicode, and final newlines remain intact. Fresh packets include active capabilities and complete structured directory evidence. Repeated capability activation is rejected before execution and uses the existing one protocol correction. The read presentation lists up to eight known files not fully observed at their current digest. Partial reads stay eligible; an edit reopens a changed file. The registered general reader remains available.

The next live probes still failed. Typed actions produced seven usage-verified calls, then a repeated read. The read agenda moved through the project sources, but its external 240-second deadline ended the run before an edit. Twelve calls had verified usage; the last remained admitted when the request failed. Evidence is saved in `docs/evidence/agent-typed-actions-live-2026-10-30.json`. Neither probe proves repair quality or packaged behavior.

Cancellation is now checked immediately after each model return, before binding interpretation, proposals, or completion. An admitted dispatch that fails before provider usage records `provider_error`; its call stays consumed. The focused check passed 198 tests across five files with one live test skipped. Full type checking passed. The next source-packing work must retain relevant earlier source bodies, with complete ranges and revision labels. Current packets retain only the last source body; an index alone is not enough for a small model to repair a multi-file project.

## Bounded current source pages

Fresh action requests now retain up to three useful earlier source pages, as well as the latest result. Selection uses requirement paths, references in the latest source, failure text, and recency. These are relevance hints only. Each page keeps its full content, digest, byte and line ranges, and continuation. Stale earlier pages are omitted from active source selection; their saved evidence remains available. The latest page records its currency at packet assembly. Receipts cover exactly the pages sent in a usage-verified request.

The gateway now returns a distinct context-limit error before generation. The host can remove whole optional earlier pages and recount the complete prepared request. It keeps requirements, constraints, and the latest result. This consumes no model call and does not invalidate valid tokenizer setup. A request that still cannot fit stops before dispatch. Checks cover both native and JSON transport.

Full type checking and the Electron source build passed. The focused check passed 205 tests across five files with one live inspection skipped. The live repair still failed: four calls passed exact counting, but the model repeated a directory listing before reading source. No edits occurred. Evidence is in `docs/evidence/agent-source-packing-live-2026-10-30.json`. This probe used a 900-second diagnostic deadline; it stopped after about 59 seconds. A larger deadline is no repair fix. Source selection did not get exercised by this failure.

The next structural gap is source acquisition. The host records a baseline failure but leaves the transition to inspected code to a general model action. Add bounded host reads from contained failure locations and reported test paths. Those locations are evidence-selection hints, not instructions, acceptance, or mutation authority. Record these reads through the existing dispatcher and ResultStore; include only actually supplied pages in observation receipts.

## Source acquisition and requirement scope before actions

The host now maps stack locations only to paths in the exact test snapshot manifest. Reported test files provide fallback hints. After a failed baseline or repair check, it obtains up to four bounded source pages through the existing dispatcher and saves them in ResultStore. The pages are included in current source selection; they become source receipts only when actually sent in a usage-verified request. Small files retain their complete source. Larger pages use the reported line region. Hint coverage is explicitly incomplete. Hints grant neither mutation authority nor acceptance.

A live probe with source acquisition still failed before this stage. The model put the mixed reproduction-and-repair sentence into an execute requirement and omitted change requirements. Four calls had matching exact counts, but no host source reads or edits occurred. It repeated directory listing and stopped Partial. Evidence is in `docs/evidence/agent-host-evidence-live-2026-10-30.json`.

The engine now performs a separate requirement scope assessment before binding execution. It compares every original message with the proposed active requirements and checks repair, execution, preservation, and delivery separately. It also assesses full-suite scope independently. Missing scope permits one persisted interpretation revision. A second failure leaves the full request pending and permits no workspace actions. A model status label cannot bypass this assessment unless the host recognizes a direct status question. Quotation/schema validity is still only provenance; this second model assessment is not proof of correct understanding. Completion retains its separate evidence checks.

The real command-backed regression uses an existing failing test in a separate workspace. It confirms that host source reads precede an approved edit, the unchanged existing test passes afterward, and model actions need no redundant directory/read calls. Model turns are mocked in this offline case. A second case confirms omitted repair obligations are revised before actions; another leaves the request pending after two rejected interpretations.

This check also exposed a v3 fallback approval defect: the fallback check omitted the operation digest. The policy guard now requires the fallback flag, exact command, run identity, and source-bound operation in the same live grant. It cannot combine grants from different revisions. Full type checking and the Electron source build passed. The focused suite passed 236 tests across six files, with one live test skipped. Sixty command, publication, capability, and containment cases passed across four files. The network containment case first failed to start its loopback server under restricted permissions; the complete six-case containment suite passed when rerun with local server access.

Later probes below exercise this scope assessment. They remain source diagnostics, not packaged or release trials. Do not enable production v3 from offline test success.

## Bounded scope revision and request-specific checks

A real scope assessment rejected the omitted repair obligations, then the single revision call dropped more obligations. The host stopped before workspace actions. The one scope revision now uses five short sequential calls, one each for inspection, changes, execution, preservation, and delivery. Each pass has a fixed requirement kind and cannot waive existing requirements. The host retains the earlier draft obligations and merges new ones; an empty pass cannot erase them. It resolves draft ID collisions without replacing existing records. All five calls, both assessments, and any retries count toward the same persisted 40-call limit. Cancellation during revision leaves the original request pending.

The next live probes exposed two contract faults before workspace actions. LM Studio rejected a negation keyword used to describe an empty updates array; the schema now uses its supported array length constraint. A later pass invented a literal-copy check without a matching user instruction, and ingress correctly rejected it. Presentation now offers literal checks only when the supplied request or an earlier pending request has a direct literal-copy basis. Only inspection and delivery passes can present those checks. Other passes use semantic checks for their fixed kind. The ingress quote/path validation remains unchanged.

Evidence for all three failed probes is in `docs/evidence/agent-scope-revision-live-2026-10-30.json`. No workspace actions, edits, or repair passes occurred. Provider errors stay recorded and consume their calls. These failures do not establish live repair quality. Full type checking and the Electron source build passed. The latest focused run passed 240 tests across six files, with one live test skipped. The further isolated probe also stopped before workspace actions. All eight calls passed exact admission and provider-usage checks. The retained draft and focused passes contained repair and full-suite requirements, but the delivery pass returned no requirement. The final assessment rejected the missing separate explanation obligation. No baseline, source read, approval, or edit occurred in that probe. Evidence is in `docs/evidence/agent-preserved-scope-live-2026-10-30.json`.

The remaining control gap is now explicit: the engine depends on complete model-written obligation kinds before it can enter repair. A separate model assessment prevents a false success, but it can also stop useful work on a scope interpretation fault. A five-kind pass still lets a short delivery obligation disappear when it shares a sentence with test execution. The next investigation must compare bounded source-clause extraction and review contracts, with precise source references for missing obligations. Keep direct source quotations and deterministic execution proof. Do not remove the failure gate or treat these assessments as proof of understanding to obtain a passing trial.

## Current proof and limits

The latest focused check passed 240 tests in six files, with one opt-in live test skipped. It covers action schemas, literal-source checks, the host loop, gateway admission, test-report interpretation, and Chat/Work boundaries. Earlier checks cover task storage, revision-bound edits, verification, and storage isolation. Full type checking and the Electron source build passed. These results do not establish packaged behavior or live repair quality.

Live inspection evidence is saved in `docs/evidence/agent-host-inspection-probes-2026-10-29.json`, with full saved proposals, source observations, reviews, admission receipts, and stop reasons. Failed probes returned Partial and requested no mutation approvals. The selected 7B model is available. The 14B release trials have not run.

## Work still required

1. Complete bounded relevant source packing and prove the repair transition with the real model. Typed actions, retained current source pages, bounded host failure reads, and a pre-action scope assessment are present, but the live model still has no successful repair. Then complete bounded per-requirement evidence checks and task-authorized cross-run applicability. Audit explicit full-suite scope independently of an omitted model Boolean. Do not weaken acceptance or replace existing tests.
2. Add the separate task progress facts to the UI. Complete task-authorized cross-run evidence retrieval in the active loop. Retain all original obligations on follow-ups and regressions.
3. Finish structured constraints and protected-path extraction. Keep policy checks at the tool boundary.
4. Complete test-environment probing in the actual launch environment. Cache unchanged missing-command failures. Finish baseline, full-suite, post-edit test scheduling, and repair-cycle integration.
5. Complete restart and uncertain-mutation reconciliation, approval expiry UI, and linked legacy-to-v3 attempts with fresh authority. The preview currently refuses to resume the old engine.
6. Verify document, knowledge, visual-source, and attached-repair workloads through v3. Complete bounded source/evidence packing for larger tasks.
7. Run isolated Flow D checks from preserved originals, packaged minimal-environment checks, and ten repair trials each on representative 7B and 14B models. Require at least nine complete repairs per model and zero false completion or unauthorized mutation before production enablement.

The damaged Flow D workspace was not restored or edited by this work. Production storage was not opened for writes. Schema 4 will apply when this build opens an older profile, using the tested consistent backup path.

## Commits

- `4ce72cb`: durable tasks, schema backup, local/server counter foundations, pinned dependencies, and initial counting evidence.
- `ef35bfc`: final gateway admission and saved usage receipts.
- `b008c3b`: integrated v3 host loop, revision-bound edits, strict action transport, and failed live-inspection evidence.
- `a258005`: tested task controls and same-session resume.
- `5c01c36`: closes empty-suite false passes and separates baseline history from final acceptance.
- `6c4eba0`: typed action schemas, active capability state, bounded read agenda, cancellation checks, and failed live evidence.
- `c61ae75`: retained current source pages and exact admission after whole-page context reduction.
- `ca9e17b`: bounded host source acquisition, pre-action scope assessment, and source-bound command fallback approval.
- `487d6df`: bounded obligation passes, retained draft scope, request-specific check presentation, and failed scope diagnostics.
- Earlier Flow D assets and AGENTS.md edits remain separate.
