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

## Current proof and limits

The focused offline check passed 237 tests in 12 files; two opt-in live tests were skipped. This includes task storage, gateway admission, revision-bound edits, host-loop control, verification, storage isolation, and Chat/Work boundaries. Full type checking passed. The Electron source build passed. These results do not establish packaged behavior or live repair quality.

Live inspection evidence is saved in `docs/evidence/agent-host-inspection-probes-2026-10-29.json`, with full saved proposals, source observations, reviews, admission receipts, and stop reasons. Failed probes returned Partial and requested no mutation approvals. The selected 7B model is available. The 14B release trials have not run.

## Work still required

1. Extend current evidence and bounded assessment to general repair and document requirements. The typed literal inspection case is now checked live. Complete host-owned progress after edits and bounded per-requirement evidence checks. Do not weaken acceptance or replace existing tests.
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
- This milestone adds typed host source checks, separate scope review, and bounded literal-delivery correction. Earlier Flow D assets and AGENTS.md edits remain separate.
