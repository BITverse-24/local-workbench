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

The next live probes reached source reads but coverage review rejected the correct reported content and the loop stopped on repeated actions. Source evidence is now unwrapped before review. Model proposals and old reviews are excluded from source/execution proof. This closes a review feedback path; live success remains unproven. An interpretation correction also exposed an adjacent-user-message rendering mismatch. Corrections now stay within one bounded user packet. The exact admission guard blocked the mismatched request before generation.

## Current proof and limits

The focused offline check passed 237 tests in 12 files; two opt-in live tests were skipped. This includes task storage, gateway admission, revision-bound edits, host-loop control, verification, storage isolation, and Chat/Work boundaries. Full type checking passed. The Electron source build passed. These results do not establish packaged behavior or live repair quality.

Live inspection evidence is being retained with full saved proposals, source observations, reviews, admission receipts, and stop reasons. Failed probes returned Partial and requested no mutation approvals. The selected 7B model is available. The 14B release trials have not run.

## Work still required

1. Resolve live requirement and coverage review failures from saved evidence. Complete host-owned progress after edits and bounded per-requirement evidence checks. Do not weaken acceptance or replace existing tests.
2. Add the New task control and task progress display. Complete task-authorized cross-run evidence retrieval in the active loop. Retain all original obligations on follow-ups and regressions.
3. Finish structured constraints and protected-path extraction. Keep policy checks at the tool boundary.
4. Complete test-environment probing in the actual launch environment. Cache unchanged missing-command failures. Finish baseline, full-suite, post-edit test scheduling, and repair-cycle integration.
5. Complete restart and uncertain-mutation reconciliation, approval expiry UI, and linked legacy-to-v3 attempts with fresh authority. The preview currently refuses to resume the old engine.
6. Verify document, knowledge, visual-source, and attached-repair workloads through v3. Complete bounded source/evidence packing for larger tasks.
7. Run isolated Flow D checks from preserved originals, packaged minimal-environment checks, and ten repair trials each on representative 7B and 14B models. Require at least nine complete repairs per model and zero false completion or unauthorized mutation before production enablement.

The damaged Flow D workspace was not restored or edited by this work. Production storage was not opened for writes. Schema 4 will apply when this build opens an older profile, using the tested consistent backup path.

## Commits

- `4ce72cb`: durable tasks, schema backup, local/server counter foundations, pinned dependencies, and initial counting evidence.
- `ef35bfc`: final gateway admission and saved usage receipts.
- The integrated host-loop and revision-bound edit milestone is ready for a regular commit after its final focused checks. Earlier Flow D assets and AGENTS.md edits remain separate.
