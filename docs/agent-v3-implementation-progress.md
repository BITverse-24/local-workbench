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

## Source-bound interpretation reviews

The pre-action assessment now reviews one current or pending source span at a time. It receives the exact source text and short outlines of requirements linked to that span. It does not receive adjacent instruction text or repeated check and quote fields. Every gap carries a host-created message ID, span ID, and byte-for-byte source text. The one revision extracts only those gaps with a compact contract. The host supplies the selected source reference, check kind, check ID, and repeated criterion description. The model still interprets the request; validation cannot prove that interpretation correct. Earlier draft and bound requirements remain intact.

Tests cover a mixed execution/explanation source, retained repair requirements, source-specific delivery refinement, prior pending sources, fake source units, extra waiver fields, literal checks, cancellation, and the shared 40-call limit during scope review. The latest focused check passed 208 tests across four files with one live test skipped. Earlier checks for this change passed 222 tests including literal-source checks. Full type checking and the Electron source build passed.

The first live source-unit probe showed adjacent instructions leaking into the model assessment. The next probe removed that adjacent text. Its five source reviews used 188–242 input tokens. It entered the action loop, read the project files, and reran the failing tests. All 18 model calls had matching exact counts. It then stopped because the latest 4,000-byte source page plus task metadata could not fit. No edits occurred. Both traces are in `docs/evidence/agent-source-scope-reviews-live-2026-10-30.json`. This result requires true evidence pagination during request assembly; dropping only optional older pages is insufficient. It also leaves mixed requirement-kind interpretation unproved.

## Evidence paging and structured retrieval

Action requests now reduce optional source pages, then page the latest source at UTF-8 boundaries when exact admission rejects a larger request. Each page retains its digest, byte and line ranges, completeness, and continuation. Only admitted bytes become edit receipts. Requirements, constraints, and the complete request remain present. An essential state that still exceeds the verified window stops Partial with a request to narrow scope.

Result retrieval now preserves structured payloads and parent lineage. Filtered result indexes support source-only pagination within the run. Retrieved results remain model-derived and cannot create source or execution authority. Small result slices are honored. The read agenda includes every source page in the current packet and uses the saved test manifest when a directory listing is absent. Tool path choices are rebuilt after repacking, so omitted source can be read again.

Type checking and the Electron source build passed. The focused seven-file check passed 243 tests with one opt-in live test skipped. It includes an actual counted 4,096-token window, unseen edit anchors, UTF-8 continuation, filtered retrieval, and read paths restored after repacking. The three earlier diagnostics in `docs/evidence/agent-bounded-evidence-live-2026-10-30.json` remain failures. Two 7B runs repeated evidence acquisition without edits; 9B stopped at setup because it was not loaded. These traces predate the final read-agenda fix. No successful live repair has been established.

## Bounded completion review and current file proof

Completion now reviews one active requirement per request. It supplies the exact requirement, its user source, global preservation constraints, bounded relevant source or execution slices, and host check facts. An exact context rejection reduces source pages before another admission attempt. Result indexes state their total and completeness. Model proposals, approvals, and earlier reviews cannot become source or test proof. Each original source span receives a separate scope audit. Literal-copy delivery also audits original spans separately after host byte comparison. Earlier quoted waivers remain visible in those audits.

The host checks each successful file operation against its saved post-operation digest before review and checks again after the review awaits. This includes ordinary text edits, new files, and deletion. Approval records cannot stand in for mutation outcomes, even when they share a call ID. Complete writes and deletions now save before/after revision evidence. Edits save structured outcome payloads. A source change during a positive model assessment keeps the task Partial; applied files and backups remain available.

Full type checking and the Electron source build passed. The focused six-file check passed 240 tests, with one opt-in live test skipped. It includes per-requirement repair agendas, exact review repacking, current text revisions, creation, deletion, literal delivery, and Chat/Work boundaries.

The next 7B trial still failed. It used 18 exact usage-verified calls, reached source reads and repeated test commands, then stopped Partial on a repeated read. No files changed. The independent scope assessment accepted mixed repair and explanation obligations under execute requirements. The driver then selected execution and broad source acquisition repeatedly. This trace is saved in `docs/evidence/agent-current-agenda-live-2026-10-30.json`. It predates this completion-review change and never reached completion review. The repair transition and category-dependent mutation guard still need a coherent change; do not treat these review improvements as a live repair fix.

## Concrete operation scope instead of a mutation category gate

The file mutation gate now assesses the exact operation against the bound requirement's quoted user instruction, complete source message, acceptance checks, and active preservation constraints. It does not require an exclusive change label. The source scope audit now compares descriptions and acceptance checks rather than requiring a separate label for each obligation. A model assessment remains an interpretation. It grants no permission and proves no repair.

The existing source-range and digest check runs before assessment and again after its inference await. The normal concrete approval, protected paths, run scopes, lock, backup, and under-lock digest check still own mutation authority. An unavailable or malformed scope assessment stops before approval. Status and evidence sources cannot supply an edit instruction. Cancellation is checked before approval or execution. These short calls share the persisted 40-call run limit.

The final seven-file check passed 244 tests with two opt-in live tests skipped. The file-scope live check was run separately and passed. Full type checking and the Electron source build passed. Offline cases keep an inspection-only request read-only, allow a mixed execute/repair requirement to reach concrete approval, honor a rejected approval, and cancel before mutation. A separate read-only 7B diagnostic accepted the requested repair proposal and rejected the explicitly forbidden edit. Both calls matched exact counts (391 and 379 input tokens); no files changed. See `docs/evidence/agent-file-scope-live-2026-10-30.json`. Its requirements were controlled test inputs. It does not prove extraction, source validation, approvals, or an end-to-end repair.

The host still needs a reliable transition from a failed baseline to a small repair step. The last full trial kept reading and rerunning tests; no successful full live repair is claimed.

## Host failure steps

The run ledger now saves the failed check revision, execution result references, and candidate source targets. Stack locations and bounded literal relative-import hints from failed tests select contained source reads. Hints are incomplete and can include non-causal paths. They never select executable code, grant permission, or establish acceptance. Shared imported files remain dependency context rather than an automatic repair target.

Fresh requests now carry one host-selected failure step. The current candidate source remains present when optional pages are removed. Read suggestions cover missing source for that step; the general reader remains registered. A changed digest advances the source focus but does not satisfy a requirement. When candidate sources change, the host asks for verification or delivery, then runs the existing checks. A failed check creates fresh hints for the new snapshot under the existing repair limit.

A real-command offline regression reproduces two existing module failures, obtains one module through a failed test's relative import, keeps each module in focus through approved edits, and runs the unchanged two-test suite afterward. It also checks the mixed execute requirement path. Model decisions are mocked in this offline case. Smaller-packet checks retain the essential candidate source and restore omitted related-test read choices. Type checking and the focused three-file check passed 64 tests with one opt-in live test skipped. The broader six-file check passed 245 tests with one opt-in live test skipped; the Electron source build also passed. A fresh full-input 7B Flow D trial stopped before baseline execution during checklist scope review. It used 12 exact usage-verified calls, changed no files, and did not exercise the new failure step. Its reviews listed already-present checklist entries as missing. Evidence is in `docs/evidence/agent-failure-step-scope-stop-live-2026-10-30.json`. A separate controlled-checklist trial reached the failure step, but the model repeated already-supplied source reads. It stopped Partial after four exact usage-verified calls, without edits. The controlled inputs bypass extraction, so this cannot establish full-input repair success. Evidence is in `docs/evidence/agent-controlled-failure-step-live-2026-10-30.json`. The action path still asks the small model to choose among full tool schemas and write executable arguments in one response. Isolate that choice from argument synthesis before changing the controller again.

## Isolated action contract checks

A separate 7B call chose from a concise tool-name inventory using the saved controlled failure step. It still chose read_file for a module whose current source was supplied. A second replay reduced the input from 5,102 to 1,520 exact tokens and supplied only the current requirement, constraints, unresolved IDs, failure facts, and literal current module/test pages. It again chose read_file, with a reason that another read would confirm current source. Both calls matched usage, dispatched no tools, and changed no files. Evidence is in `docs/evidence/agent-action-choice-live-2026-10-30.json`.

These checks do not support adding a generic tool-choice call as the fix. The bounded repair-proposal check has now run. With explicit edit, missing-source, and blocked outcomes, the 7B model produced unique old/new replacement anchors in one exact usage-verified 1,542-token call. It proposed a JSON parse fallback. The data was not applied or executed, and it does not establish the saved-data shape checks. Evidence is in `docs/evidence/agent-repair-proposal-live-2026-10-30.json`. This supports a repair-specific proposal contract for a host-selected source step; it does not establish repair quality or justify a forced edit. Do not remove missing-context outcomes, force unchecked edits, or infer permission from a successful proposal.

## Bounded repair proposal phase

A host-selected implementation failure now uses a small repair proposal contract. It permits exact replacement lines, a bounded source request, one action with the full registered tool view, or a specific blocker. The host binds the edit path and digest. The normal registered-tool validation, source receipts, concrete approval, locks, backups, and tests remain in force. Literal source is supplied outside JSON metadata. Native transport and JSON fallback accept the same proposal data. The single required JSON tool receives arguments only; the host binds its name. Nested tool names and fenced examples cannot change that binding.

Full type checking and the Electron build passed. Four focused files passed 80 tests with one opt-in live test skipped. Tests include target override rejection, one-action tool expansion without mutation authority, raw-line equivalence, and JSON negative cases.

The earlier controlled-checklist 7B trial reached an actual edit proposal in two usage-verified calls (4,047 and 837 input tokens). A model scope assessment then falsely called try/catch a new dependency. It stopped Partial before approval and changed no files. The proposed edit was not a complete proven storage fix. This trace predates the arguments-only JSON change and bypassed requirement extraction. It does not prove repair success. The previous turn recorded this result, but its temporary raw trace is no longer present. Treat it as an unverified diagnostic summary until repeated.

The scope assessment currently mixes user intent with code constraint enforcement. That ownership fault remains open. A model cannot establish dependency, syntax, or runtime correctness. The host must retain source/approval checks and enforce supported structured constraints; deterministic checks and tests supply executable evidence.

## Host verification after repair steps

The arguments-only controlled 7B diagnostic made four exactly counted calls, applied one approved storage edit, then stopped at a rejected filter proposal. The filter proposal removed search trimming and did not repair the status condition. Independent tests still failed. Evidence: `docs/evidence/agent-repair-arguments-live-2026-10-30.json`. No full repair is established.

The host now runs existing checks when its candidate implementation revisions change. It no longer waits for a model finish action at that transition. A current test pass starts a bounded delivery proposal, followed by separate requirement reviews. Failed checks refresh the failure source under the existing two-cycle limit. Rejected checks stop before delivery. A historical pass for another workspace revision cannot remove failure focus. Tests and final source currency still control acceptance. Full type checking and the Electron build passed. Four focused files passed 236 tests, with one opt-in live test skipped. This includes automatic verification without a finish action, two failed repair cycles, rejected test approval, stale test revisions, and Chat/Work boundaries.

## Reference-bound requirement coverage

Source reviews now map each interpreted obligation to concrete acceptance-check or scope-update references. The host validates those references and derives uncovered work from unmapped obligations. The model cannot supply an independent pass Boolean. Unknown refs, the old Boolean format, and empty reviews of supplied checks are rejected. An unmapped obligation remains a source-bound gap for the existing bounded extraction revision. This validates reference consistency, not semantic completeness or correct understanding. Type checking and the Electron build passed; 62 focused tests passed with one opt-in live test skipped. A full-input 7B diagnostic passed the five source audits, reached a repair proposal, then stopped at an edit scope check that treated added code as a possible dependency. All eight calls had verified exact counts; no files changed. Evidence: `docs/evidence/agent-repair-scope-refs-live-2026-10-30.json`. The next change separates operation authorization from implementation checks.

## Host dependency checks and remaining authority fault

Edit scope input now contains the operation class and target, without executable replacement content. Source and concrete approval checks remain. Exact unconditional dependency-preservation sources enable a host rule: dependency manifests and lock files stay unchanged; standard JavaScript/TypeScript imports and require calls cannot add external or computed dependency references. File checks run before approval and again under the mutation lock. Command publication checks the whole change set before saving any file. Waived rules are not recovered from unrelated broad quotations. Babel Parser 7.29.8 was already installed; it is now a pinned production dependency so packaged checks can use the same parser. Other languages and manifest edits can be blocked by this conservative rule. It is not a proof of arbitrary runtime dependency behavior. Conditional or unrecognized constraint text retains semantic review and still needs structured support.

Five focused files passed 246 tests with one opt-in live test skipped. After tightening source binding, 30 constraint/publication tests passed and type checking and the Electron build passed again. A later focused loop test checks rejection before semantic assessment or approval. The full-input 7B trial passed source coverage but still stopped before edits: the scope model required an explicitly named implementation filename for a workspace repair. Evidence: `docs/evidence/agent-host-dependencies-scope-stop-live-2026-10-30.json`. The next authority change must distinguish a user-requested workspace repair from explicit target restrictions, bind the interpretation to saved source, and enforce concrete target limits in the host. Do not remove the gate or treat a model code assessment as permission. Live repair remains unproved.

## Saved file scope and host target checks

The model now interprets requested file operations and workspace or literal-path scope from saved user instructions, without a candidate filename or replacement code. The host validates literal selectors against user source, saves the interpretation by task revision and requirement, checks its result integrity before reuse, and checks target membership before approval and again under the file lock. Protected paths and operation restrictions also apply to complete command publication. A read-only command can run with approval but cannot publish edits under a no-change scope. Existing policy restrictions are retained. Scope interpretation is not proof of user intent and never grants mutation authority.

Five focused files passed 247 tests with one opt-in live test skipped. After the workspace-root selector guard, 26 scope/gateway tests passed. Full type checking and the Electron build passed. These checks cover unnamed workspace targets, source-bound allow/protect paths, cached scope, fabricated selectors, command publication, and Chat/Work boundaries. The full-input 7B diagnostic passed source coverage and interpreted workspace edit/write scope without named targets. It applied six approved edits and executed baseline plus three post-change test attempts. All 13 model calls had verified exact counts. It stopped Partial after two repair cycles with four tests still failing; protected files stayed unchanged. Evidence: `docs/evidence/agent-task-scope-repair-live-2026-10-30.json`. This proves the live transition through approvals and test repair cycles, not successful repair. The patch proposals changed unrelated expressions and did not repair filtering or saved-data shape checks. A read-only diagnostic now separates concise failure diagnosis from patch-data generation before changing runtime phases.

## Diagnosis and patch-format diagnostic

A read-only replay isolated a diagnosis call from patch-data generation. The first unconstrained diagnosis found the filter issue but drifted into another module and stopped at its 512-token limit; no patch call ran. A bounded four-field diagnosis completed, followed by a proposal with unique source anchors. The proposed patch duplicated an existing declaration. Independent Babel parsing rejected the candidate. Counts matched usage in all three calls. No proposal was written or executed. Evidence: `docs/evidence/agent-unbounded-diagnosis-live-2026-10-30.json` and `docs/evidence/agent-bounded-diagnosis-live-2026-10-30.json`.

This does not justify adding that diagnosis phase to runtime. The current repair packet still repeats the broad task goal, and JSON patch synthesis still fails despite supplied source/tests. Next isolate a target-local repair specification and replacement-code generation from transport formatting. Preserve the complete task, global constraints, source-bound operation, exact admission, concrete approval, and existing tests. Do not infer correctness from unique anchors or a successful model response.

## Complete-module draft comparison

The same read-only target replay produced a filter source draft with the missing status condition, but plain output arrived in Markdown and was rejected. A single-field complete-module proposal through the existing required JSON tool transport returned parseable source with that condition and preserved exports. The storage proposal was also parseable, but still left JSON parsing unguarded. These are proposal diagnostics, not executed or verified repairs. Their input counts matched usage at 1,650 and 1,549 tokens. Evidence: `docs/evidence/agent-raw-module-draft-live-2026-10-30.json`, `docs/evidence/agent-json-module-filter-live-2026-10-30.json`, and `docs/evidence/agent-json-module-storage-live-2026-10-30.json`.

This supports evaluating a complete-source proposal for small, fully observed modules instead of requiring the model to copy old anchors and generate replacement code in one diff response. It does not establish full repair quality. Keep an explicit typed operation, complete-source receipts, syntax checks, concrete approval, backups, and required tests. Partial source still needs bounded edits or further reads. Never convert Markdown examples into actions.

The diagnostic also exposed a transport bug: an argument named content was echoed as assistant text. Sole-operation arguments now stay opaque, including content. The 18 gateway checks, full type checking, and Electron build passed; the two module diagnostics separately used the live model. Chat and Work do not use this v3-only argument path.

## Complete-source repair proposals

Small JavaScript/TypeScript failure modules can now use an explicit complete-source proposal when the current request contains every original byte. The host binds the entire observed source as one old anchor and validates replacement syntax before ordinary file scope, approval, lock, backup, digest, and test checks. Markdown fences are rejected rather than extracted. A partial request cannot activate this path; exact-context repacking can restore bounded-edit presentation instead. Missing-source, full-tool, and blocker outcomes remain available. No requirement or capability is removed.

The five-file check passed 244 tests with one opt-in live test skipped. Full type checking and the Electron build passed. Tests include complete-byte binding, target/digest override rejection, syntax errors, Markdown source rejection, escape/line-ending preservation, partial-context repacking, full-tool access, and Chat/Work boundaries. Live repair with this contract remains unproved.

## Module drafting and context acquisition

The first live complete-module contract failed: the model repeatedly selected the full-tool branch and made no edits. All 28 calls had verified exact counts; the run stopped Partial on a malformed command. Evidence: `docs/evidence/agent-module-union-live-2026-10-30.json`. The protected project stayed unchanged.

The module draft now has one required content field. It can abstain with null content and a specific context request or blocker. The host opens the registered tool view for one context action. This data request grants no capability or mutation authority. Repeated context requests stop when only model/capability metadata changed. Module requests omit the broad tool inventory and directory agenda while retaining the current requirement, all global constraints, unresolved IDs, obligation summaries, selected source, and useful saved evidence. Bounded-edit requests retain their read agenda. The current source guard remains unchanged. Focused tests verify abstention, source/tool access after repacking, and the repeated-context stop; the broader host check passed 245 tests with one opt-in live test skipped. Full type checking and the Electron build passed.

## Draft/context stop and next lifecycle change

The compact nullable-content module trial still did not produce a repair. It made nine exactly usage-verified calls, asked for tool registration, activated computation metadata, then repeated its context request without new source or execution evidence. The new repeated-context guard stopped it Partial with no edits. Evidence: `docs/evidence/agent-module-draft-context-stop-live-2026-10-30.json`.

Do not continue adding choices to the same generation schema. Separate non-executable code drafting from executable action selection. The existing read-only single-content tool can produce source, while the shared draft/context response takes a cheap abstract tool branch. A host-owned drafting phase should save immutable candidate bytes without mutation authority; a later bounded structured action can select that saved draft, request real context, or stop. It must retain exact admission, the 40-call limit, source revision and complete-read checks, syntax checks, concrete approval, backups, and test repair limits. No Markdown extraction or forced unchecked edit is acceptable. This next phase is not implemented yet. Before another live prompt experiment, finish task-level evidence carry-over, recovery, and the other open M1–M3 requirements. Release certification remains deferred.

The host now rejects byte-identical edits and existing-file replacements before approval or backups. A no-op must not stand in for saved repair work. The three-file check passed 73 tests with one live check skipped; the new complete-replacement case passed separately. Type checking and the Electron build passed.

## Current implementation scope

The user has deferred release certification and will test 14B manually. Current work is implementation and harness quality for the 7B–14B range, with local 7B and 9B models available for development checks. The machine has Qwen2.5 Coder 7B and Qwen3.5 9B assets; no 14B model is installed. Do not download weights or treat release trial counts as a current completion requirement. Keep the release controls documented and keep production promotion separate. Packaged-environment implementation checks remain useful because the original failure occurred in a production build.

## Current proof and limits

The latest focused check passed 208 tests in four files, with one opt-in live test skipped; an earlier 222-case check also covered literal-source behavior. It covers action schemas, literal-source checks, the host loop, gateway admission, test-report interpretation, and Chat/Work boundaries. Earlier checks cover task storage, revision-bound edits, verification, and storage isolation. Full type checking and the Electron source build passed. These results do not establish packaged behavior or live repair quality.

Live inspection evidence is saved in `docs/evidence/agent-host-inspection-probes-2026-10-29.json`, with full saved proposals, source observations, reviews, admission receipts, and stop reasons. Failed probes returned Partial and requested no mutation approvals. The selected 7B model is available. The 14B release trials have not run.

## Work still required

1. Prove the implemented bounded repair-proposal transition with the real model and correct scope/constraint ownership. Preserve a missing-context path, access to the registered tool surface, exact admission, source binding, and concrete approval. The reference-based checklist review now reaches the live action loop. Keep its original-request coverage gate and validate repair code generation independently of diff formatting. Complete bounded relevant source packing. Typed actions, retained current source pages, bounded host failure reads, and a pre-action scope assessment are present, but the live model still has no successful repair. Bounded per-requirement reviews and source-change checks are now present. Complete task-authorized cross-run applicability and current-evidence retrieval for larger requirements. Audit explicit full-suite scope independently of an omitted model Boolean. Do not weaken acceptance or replace existing tests.
2. Add the separate task progress facts to the UI. Complete task-authorized cross-run evidence retrieval in the active loop. Retain all original obligations on follow-ups and regressions.
3. Extend structured constraints beyond the supported exact dependency restriction and literal task allow/protect paths. Keep policy checks at direct-edit and command-publication boundaries and keep unsupported cases visible.
4. Complete test-environment probing in the actual launch environment. Cache unchanged missing-command failures. Finish baseline, full-suite, post-edit test scheduling, and repair-cycle integration.
5. Complete restart and uncertain-mutation reconciliation, approval expiry UI, and linked legacy-to-v3 attempts with fresh authority. The preview currently refuses to resume the old engine.
6. Verify document, knowledge, visual-source, and attached-repair workloads through v3. Complete bounded source/evidence packing for larger tasks.
7. Prove repair behavior in isolated Flow D copies and check the packaged launch environment. Use the local 7B and 9B models for implementation checks. Release certification and manual 14B trials are deferred to the user; keep the documented promotion control closed until that separate release decision.

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
- `e7bd104`: durable source-bound failure steps, contained import hints, focused evidence, and separate full-input/controlled diagnostics.
- Earlier Flow D assets and AGENTS.md edits remain separate.

## Task evidence across attempts

Task-owned evidence listing and retrieval now cover earlier bound attempts. The task store checks the current revision, Agent v3 mode, chat, workspace, and origin revision. ResultStore remains run-scoped. Tool callers opt into `scope=task`; the default remains run-only. Returned records expose their origin run and historical status. No requirement association is invented for task-wide observations.

Fresh context packets and completion reviews can read earlier task source and execution records. Applied changes come from their original completed operations, without copying operations or approvals into a new ledger. Completion checks immutable mutation outcomes against current target digests and rechecks them after review. Final tests still need current-run evidence bound to the current implementation, test, and configuration manifest. Earlier test passes do not transfer acceptance.

The four-file focused check passed 88 tests, with one live check skipped. Two added follow-up regressions passed separately: an earlier edit does not force a second edit, and a source change during a follow-up review blocks completion. Full type checking, Electron build, and diff checks passed. Cross-run command publication and generated-artifact proof still need separate treatment; this milestone covers direct file operations and source evidence.

## Restart, linked legacy continuation, and task result facts

A saved workspace identity now survives restart. Explicit project registration creates a fresh identity, including rapid re-registration. Resume checks the current task revision and project identity before it spends a resume attempt. Restart expires approvals; an isolated test restores the database and project, then confirms that an edit needs a new concrete approval and that rejection keeps the file unchanged. Existing uncertain-mutation guards remain in force.

Explicit continuation of a legacy Agent run now creates a linked v3 run and a new task from the saved request and inputs. It preserves the old ledger, obtains fresh authority, and never dispatches the old engine. A changed project registration instead requires New task. Recovery eligibility uses the same task and call-budget checks as Resume.

Snapshots and the Agent UI now show changes applied, checks passed, unavailable checks, and remaining requirements as separate saved facts. Failed and skipped checks also remain visible. Earlier attempts are labelled. Status answers receive those saved facts without workspace inspection. The UI states that saved checks apply to the file versions tested. These facts do not transfer test acceptance or mutation authority.

The focused four-file run passed 110 tests, with one opt-in live check skipped. Full type checking, frontend build, Electron build, and diff checks passed. The isolated Electron interface check passed with a temporary profile and fixture bridge, including the four separate task-result facts and existing Chat/Work task controls. Its evidence is under `/var/folders/03/5w29bdms4js64v94yn0p_myh0000gn/T/workbench-continuity-ypC4xK`. This does not establish packaged-backend or live repair success.

## Test runtime detection and changed environments

Agent v3 checks the discovered interpreter and package manager with fixed version commands in the selected command launch environment. A failed probe records a missing runtime and prevents the test command from starting. The user can still approve source edits; mandatory tests remain unverified. Approval and cancellation are checked again after the probes and before the test command.

The blocker key includes the actual command environments and executable identities, including missing candidates. Installing an executable into an unchanged PATH or changing its permissions invalidates the saved blocker. Discovery blockers also bind the workspace manifest. A missing interpreter package can change outside the workspace and PATH, so an explicit Resume permits a fresh check while the same attempt does not repeat an unchanged failed command automatically. Arbitrary user test commands receive no invented runtime probes.

The three-file verification run passed 91 tests, with one opt-in live test skipped. Four focused checks then covered missing executables, both command launch paths, and approval revocation during probes. A separate host-loop check confirmed that missing Node leaves an approved edit in place, returns Partial, and does not start the unchanged test command. Full type checking, Electron build, and diff checks passed. The checks use controlled test processes; packaged minimal-environment and live repair checks remain open.

## Independent Flow D browser evaluator

`scripts/evaluate-flow-d.cjs` now runs the existing project suite and checks the delivered app in an isolated Electron browser. It serves the supplied evaluation copy on loopback with Node integration disabled, blocks other browser network requests, and uses a temporary profile. It checks startup errors, required exports and controls, combined search/status filters, empty state, status persistence across reload, valid saved data, and three invalid-data cases. It compares all non-target project files, including tests and design files, against the supplied pristine baseline.

The live source-runtime diagnostic now saves this evaluator's result and digest before it cleans its temporary workspace. Completion in that diagnostic requires both the existing tests and independent browser checks to pass.

Evaluator controls are recorded in `docs/evidence/flow-d-browser-evaluator-2026-10-31.json`. The pristine broken copy failed the expected tests and browser cases. A manually repaired temporary copy passed all nine checks. A second repaired copy with a modified test failed the protected-file check even though its own suite passed. These controls validate the evaluator; they are not an Agent repair success or packaged-app test. Type checking and diff checks passed; the opt-in live repair test was not run in this offline check.

## Command publication evidence and uncertain outcomes

Approved commands now save per-file before and after digests, file modes, and backup references for published changes. Follow-up attempts read those facts from the original immutable command result. The host includes published paths in test selection and checks their current bytes and modes before and after completion review. Historical command results that lack post-change digests cannot establish a current applied change. Result payloads remain run-scoped and are integrity-checked before host use.

A failure during publication can occur after an earlier file was saved. That outcome now stops as an uncertain mutation, preserves prior changes and backups, and blocks Resume rather than treating the command as a clean failure. A simulated second-file failure confirmed the first change and backup remain available. A host-loop check confirmed an uncertain command cannot resume. Another check carried a command-published edit into a later attempt and rejected a permission change during review.

The five-file check passed 107 tests with two opt-in live tests skipped. Full type checking, Electron build, and diff checks passed. These checks do not establish a successful live model repair.

## Separate source drafting from edit selection

For a fully observed small JavaScript or TypeScript failure module, the model now first returns one complete source draft as untrusted data. The host saves the exact draft in ResultStore with its digest, task revision, requirement, and source focus. A separate model call can select that specific draft, request source or tools, or report a blocker. Selecting a draft creates a source-bound edit proposal; it does not grant permission. The proposal links back to the immutable draft. Existing syntax, source receipt, task-scope, concrete approval, locking, backup, and test checks remain in force. A missing-context request opens the registered tool view for one action. No Markdown is converted into an edit.

Focused checks prove that a draft exists before the separate choice, that a forged draft ID cannot approve or edit a file, and that requesting context leaves the workspace unchanged. The source-packing regression also passes after the extra model call. A broader five-file run passed 257 tests and exposed one outdated packing-test expectation; that expectation was corrected and the four affected checks passed separately. Full type checking, Electron build, and diff checks passed. The new design has not yet proved repair with the local model.

## Live repair and knowledge evidence

The isolated 7B Flow D trial saved `data/agent-draft-decision-live-2026-10-31.json`. It returned Partial after a fenced module draft was rejected. One approved edit was applied to `src/storage.js`; the existing suite still had four failures, and the independent browser checks also failed. Protected files remained unchanged. This is not a successful repair, and the damaged demo workspace was not used as the candidate.

Knowledge retrieval now saves the returned indexed excerpts, query, citation IDs, document IDs, and page references as source evidence. Empty retrievals do not create source evidence. The record labels the excerpts as indexed material whose source currency is not verified; the review prompt preserves that limit. The focused tool suite passed seven tests, and full type checking passed. Document artifact generation and visual-source evidence still need task-bound completion and currency checks. Packaged-app and successful live repair checks also remain open.

## Visual observations in requirement review

The requirement review can now consider a completed visual inspection as a labelled model interpretation. It verifies the immutable result, its matching saved inspection, the current source digest, saved view digests, and underlying result integrity before review and again afterward. Partial or changed inspections do not qualify. These checks establish processing coverage and currency, not the correctness of every visual reading. The existing inspection check is conservative: a gap elsewhere in the same run also excludes the observation.

An integration test exercised the real extraction and result storage path, then changed the saved view and the source separately; each change invalidated the observation. The three focused suites passed 41 tests. Full type checking passed after fixing types in the previous knowledge-tool test. End-to-end v3 visual workload behavior and requested artifact generation remain unverified.

## Artifact outcome evidence

Before a successful v3 tool outcome is published, the dispatcher now records each produced artifact's run-bound path, requirement ID, size, format, and digest from the saved bytes. It rejects an artifact outside the run output or one whose saved size or supplied digest has changed. A failure to save this outcome is a persistence failure, so the host does not report a clean success after a possible side effect. This is a foundation for completion checks; it does not yet authorize a document request or prove its content meets that request.

The focused result-memory and tool suites passed 21 tests. One test checked the recorded digest and confirmed that changed bytes prevent success. Full type checking and diff checks passed. Task-bound artifact scope, independent content review, completion checks, and end-to-end document scenarios remain open.
