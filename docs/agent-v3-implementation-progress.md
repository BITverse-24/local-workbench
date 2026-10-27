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

This evidence covers those fixed probes and that loaded instance. It does not establish repair success or certify all future requests. No live repair trial has run.

The real gateway then admitted a JSON transport request at 145 input tokens. Provider usage also reported 145. The saved receipt reached `usage_verified`. Evidence: `docs/evidence/agent-gateway-live-probe-2026-10-27.json`. This was a source-runtime check, not a packaged-app check or repair trial.

The latest focused offline run passed 229 tests across ten files; one opt-in live test was skipped in that offline run. The separate live run passed all three tests in `lmstudio-token-counter.test.ts`, including actual gateway dispatch. Full project type checking and the Electron build passed. `git diff --check` passed. `agent-gateway-boundary.test.ts` checks final streaming payloads, native/JSON fallback, JSON format retry, provider usage failures, drift, authority rechecks, call limits, and the vision exception. Existing database, storage isolation, ledger, gateway, and three-mode checks also passed.

## Work still required

1. Connect task binding and requirement extraction to RunManager before any v3 action. Complete task intent through IPC and add the New task control. Expose bound revision and current task progress in snapshots. Handle status without workspace actions. Preserve full request coverage on extraction failure and legacy continuation.
2. Add host setup and model selection for normal v3 runs, using fixed prepared probes for the exact selected transport. The dispatch boundary is implemented and tested, but RunManager does not yet create the verified counting profiles for a new v3 task. Finish the standalone server-counting source and setup recovery as required by the report.
3. Build the fresh context packet and the host action loop. Keep all capabilities registered by mode and environment. Remove category-based acceptance and Markdown action conversion from v3. Add bounded source/result pagination, action validation, repeat detection, and specific Partial reasons.
4. Add source read receipts and `edit_file`. Require observed anchors and current digests under locks. Bind approvals to concrete operations. Restrict whole-file replacement to complete observations. Preserve backups on failure.
5. Complete test-environment discovery, baseline and required test execution, revision-bound requirement evidence, a separate coverage review, and deterministic completion. Keep unavailable checks unverified. Reopen and invalidate evidence on regression.
6. Connect recovery, approval expiry, uncertain-mutation handling, legacy-to-v3 attempts, and the four separate progress facts in the UI. Preserve Chat and Work behavior.
7. Run isolated Flow D checks from preserved originals, other Agent workloads, packaged minimal-environment checks, and ten repair trials each on representative 7B and 14B models. The selected 7B is available. A 14B trial model is still needed. Require at least nine completed repairs per model and zero false completion or unauthorized mutation before production enablement.

No v3 runner has replaced the existing Agent engine yet. Production databases and the damaged Flow D workspace were not opened for writes by this work. The source now contains a schema migration that will run when this build opens an older profile.

## Next implementation step

Finish M1 integration, host counting setup, and the v3 runner. Reuse the task store, ledger, current scheduler, policy guard, and ResultStore. Keep fresh authority separate from task continuity. Save new proof and make a commit after each tested structural milestone. Do not enable production v3 until every required release gate passes.

## Commits

- `4ce72cb`: durable tasks, schema backup, local/server counter foundations, pinned dependencies, and initial counting evidence.
- The gateway admission milestone is the next regular commit. Earlier unrelated work remains outside these commits.
