# Chat / Work / Agent v1 — implementation and release evidence

Date: 2026-10-11. Status: implemented in the working tree; FRAMEWORK.md minimum gates pass on the tested Mac configuration.

The three engines, backend authority, scheduling, cancellation, persistence, and product controls are in place. The full regression suite passes. One final Qwen2.5 Coder 7B campaign has 8/9 Pass and no harness failures. Visual fallback passes 3/3. See [final verification](evidence/framework-v0-final/README.md) for the audit, limits and genuine captured executions.

## Execution and authority

RunManager validates and stores `chat | work | agent` before classification or source preparation. Older callers default to Chat. A prompt cannot change mode. Mode and engine version are assigned once when a staging run starts. Schema 3 preserves historical records without guessing their mode.

| Mode | Implemented behavior |
| --- | --- |
| Chat | Direct response with no semantic router or autonomous loop. Ordinary text uses one generation call and no tool definitions. It can read authorized input and artifact snapshots, recent conversation, and enabled knowledge sources. It cannot inspect a workspace, compute, or create files. |
| Work | Dedicated requirements, preparation, generation, validation, repair, and delivery stages. Reads and writes stay in run storage. The submitted task authorizes supported generation and isolated computation. The run has 24 model calls and two recovery attempts across all stages and resumes. |
| Agent | Existing AgentLoop with a bound workspace. Scope checks, approval gates, mutation locks, backups, source review, and evidence-based completion remain active. Changing the workspace cancels its authority. |

Tool composition and dispatch both enforce mode policy. Unknown tools fail closed. Work receives no persistent workspace harness. Sources must belong to the chat and remain within their registered run. Staging uses stable source IDs and distinct aliases for duplicate names. Resume checks the saved input snapshot and digest.

One run can execute per chat. Agent runs against the same workspace execute in order. Other chats can continue. Feature flags `WORKBENCH_CHAT_ENGINE`, `WORKBENCH_WORK_ENGINE`, and `WORKBENCH_AGENT_ENGINE` can disable an engine with `false`; disabled engines report unavailable. `WORKBENCH_AGENT_V2=false` also disables Agent. These flags do not restore the old permissive Chat path.

## Shared resources and product behavior

Generation, vision, retries, and embeddings use one local inference slot. Chat has admission preference. After three Chat calls, a waiting Work or Agent call is admitted. Work and Agent alternate when both wait. Requests waiting 30 seconds are promoted at the next call boundary. The lease lasts through response consumption. Active generations are non-preemptive.

Cancellation removes queued calls, aborts transport and file readers, and stops subprocess trees. Late callbacks cannot complete a cancelled run. File processing has two worker slots. Python has one slot. All local endpoints share the default accelerator group.

The composer has three modes. Agent requires a workspace. Background run state is keyed by chat and run. Events, drafts, artifacts, approvals, and terminal states retain their owner. Snapshots restore state when the user changes chats or restarts the app. Pending sends also retain their chat owner and block duplicate submission.

Chat shows a streamed answer. Work shows stages and validation. Agent shows actions and verification. Detailed traces and manual Save As remain available. A mode change sets the composer for a new submission; it does not expand an existing run's authority.

Restart preserves interrupted text and files, marks interrupted runs Partial, and expires approvals. Work and Agent require explicit resume and fresh authority. Mutations do not replay automatically. Historical runs with unknown mode cannot resume under guessed authority.

## Work files and verification

Supported outputs are DOCX, XLSX tables, CSV, JSON, Markdown, text, and existing Python source exports. Formula requests return an explicit limitation and cannot be declared complete. PPTX, new PDF generators, and chart generators remain deferred.

RunContract stays at v1. Optional typed artifact checks have empty defaults for old records. Independent readers inspect saved DOCX and XLSX ZIP/XML, CSV quoting and row shape, JSON, and UTF-8 text. Checks cover headings, tables, sheets, headers, row counts, required values, and source content. XLSX readers preserve numeric, string, and Boolean cell types and reject invalid numeric values and formulas. Format integrity and required content have separate evidence. Saved evidence is tied to file digests.

Work uses deterministic format conversion where the task is exact. Other tasks use a bounded requirements pass. DOCX and text drafting can generate content directly, then use the backend writer, rather than require a large JSON tool-call payload. Repairs reuse valid results and share the run's recovery budget.

Attached-code repair retains the shared pre-execution and post-execution behavior checks. Successful execution alone does not prove repair correctness. The executed source digest must match the exported source. Useful files remain available when other required checks fail. Missing or unverified requirements produce Partial; no achieved requested result produces Failed.

Content review uses separate model calls with exact source and output quotes. It is not an independent correctness oracle. Exact source-fact checks are deliberately strict and can mark a correct paraphrase Partial. Broader task-quality work remains necessary.

## Python isolation exception

Work stages inputs read-only and starts Python with a minimal environment. The backend probes macOS sandbox-exec or Linux bubblewrap before use. If isolation is unavailable, it requires approval bound to the run, code, generated Python dependencies, and input digests. Changed source or inputs invalidate that approval. Approval is checked again after waiting for the Python slot.

The approval screen states that this fallback does not enforce filesystem or network isolation. The audit record stores its isolation status. Read-only copies, run folders, and a minimal environment do not turn this approved fallback into an OS sandbox. Linux and Windows runtime behavior was not certified on this Mac.

## Baseline and restore

The original commit, tracked local edits, untracked user test, model settings, fixtures, recordings, and runtime artifacts were saved before implementation:

`/Users/krishay/.codex/backups/local-workbench-three-mode-20261010-200451`

The backup includes `committed-source.tar.gz`, `working.patch`, `untracked.tar.gz`, `runtime-evidence.tar.gz`, `manifest.json`, and `RESTORE.txt`. `baseline-checkout/` contains the original source plus local changes and the untracked test. Its node_modules symlink points to the shared dependency install; use the saved lockfile and `npm ci` for an independent restore. Do not restore over a changed working tree.

Original HEAD: `381acd4035bbc3476e119197cd0c6bed2bfc7eeb`. No commit or PR was created. Original local edits and the user test remain in the working tree. Model configuration was not changed.

The stale verification model ID was corrected to `primary-model`. All 12 verification cases pass and require real reports. The recorded full baseline had 671 passes, 80 failures, and 6 skips. Historical 7/9, 3/3, and 164/164 figures were not reproduced and are not used as release evidence.

## Verification evidence

- Full suite: **922 passes, 0 failures, 6 existing opt-in live tests skipped**, across 78 files. The skipped files are `live-result-retrieval.test.ts` and `live-intention-verification.test.ts`. No new skips were added.
- Mode boundaries, saved content, recovery, source ownership, queues, cancellation, independent readers, Python approvals and background state have focused regression coverage. Each mode has at least 30 varied policy or requirement cases. These are not 30 live model-quality tasks per mode.
- `npm run typecheck`, `npm run typecheck:behavioral`, behavioral build and app build: pass.
- Unsigned macOS arm64 directory package: pass. The independent PDF, DOCX and XLSX readers and native canvas were checked with app.asar dependencies.
- The stale verification fixture is corrected; all 12 cases require actual reports. Remaining legacy end-to-end fixtures now use explicit modes, owned sources, native gateway responses and real filesystem/Python behavior. Obsolete implicit Chat computation and workspace mutation expectations were replaced with the required authority checks.

The original baseline had 671 passes, 80 failures and 6 skips. An earlier implementation checkpoint had 818 passes and 94 failures. Those logs remain in `docs/evidence/three-modes/`; they describe prior states. Final passing evidence is in `docs/evidence/framework-v0-final/`.

The package is at `release/0.1.0/mac-arm64/Sovereign Workbench.app`. It is unsigned. Signing, notarization and Windows/Linux certification were not performed. Interactive desktop checks were completed with an isolated profile. Chat, Work, queued cancellation, chat switching, restart restore and Agent enablement passed. The Agent approval gate blocked two model plans that added an unrelated DOCX action. See [manual UI results](evidence/framework-v0-final/manual-ui-checks.md). The first restart briefly touched the default database; no conversation content was inspected, and its prior state cannot be established.

The original backup is unchanged. A separate final source patch, untracked archive and runtime evidence archive are saved in the baseline backup directory. See `framework-final-RESTORE.txt` there for restoration.

## Matched Chat measurements

Apple M4, 16 GiB RAM, configured local model, temperature 0. Four ordinary text prompts were run twice in fresh chats. The first sample has unknown model residency; it is excluded from warm statistics. Percentiles use nearest rank. There are only seven warm idle samples and three busy samples, so these are observations, not release thresholds.

| Measurement | Baseline warm idle | Current warm idle | Current warm busy |
| --- | ---: | ---: | ---: |
| Request to first visible token, p50 | 3,688 ms | 381 ms | 6,087 ms |
| Request to first visible token, p95 | 7,141 ms | 384 ms | 6,150 ms |
| Total time, p50 | 4,368 ms | 1,109 ms | 6,872 ms |
| Total time, p95 | 7,144 ms | 1,907 ms | 7,658 ms |
| Model calls per ordinary Chat | 2 | 1 | 1 |

Busy Chat waited behind an active Work generation; queue delay had a median of 5,351 ms. Provider first-token time is recorded separately from request-to-visible time. Cancellation released the slot in 7 ms in one measured active case; the next answer began after 707 ms. Answers and cancellation drafts are retained for review. Speed does not establish answer quality. The benchmark does not include renderer paint time.

True cold model loading was **not measured**. No residency manager was added or used. Numerical speed gates remain open.

## Live canonical results

The final complete nine-case campaign has **8/9 Pass, 1/9 Partial, 0 Fail and 0 Harness Failure**. Document and code tasks use Work. Inspection tasks use Chat. One saved-output audit confirms these grades against real sources, actual Python probe results and persisted states.

| Family | Evaluation results | Production outcomes |
| --- | --- | --- |
| Documents | 2 Pass, 1 Partial | 3 Partial; valid files preserved |
| Code repair | 3 Pass | 3 Partial; real execution and source exports preserved |
| Inspection | 3 Pass | 3 Completed answers |

Production Partial is retained when required checks are missing or unverified. Evaluation Pass means the primary objective was achieved under FRAMEWORK.md. The training note remains Partial for an inconsistent next action. No audited Work run declared Completed. This observation does not prove that all possible false success cases are absent.

The cohort is `tests/.runtime/v0/2026-10-10T20-47-42-153Z`. It is not a combination of selected successes from previous failed campaigns. All nine cases finish under 78 seconds. At most two recovery attempts were used. The final visual campaign has 3/3 Pass, including actual image-only PDF, raster and SVG fallback calls with correct shapes and spatial relationships.

Genuine Flow A/B/C backend execution recordings are captured from the final campaign. The source PDFs/drawing/code, knowledge retrieval, events, model logs and output files remain unchanged. The viewer is `docs/evidence/framework-v0-final/recorded-demos.html`; it is not a screen video. Artifacts were independently reopened and their digests checked against persistence.

The minimum FRAMEWORK.md reference-model gates now pass. The runtime is frozen. The manual Agent check found repeated unrelated DOCX actions in model plans; the approval gate rejected them and no workspace file changed. True cold measurements, numerical speed gates, signed distribution and platform checks remain open. Qwen3.5 certification is optional for the V0 gate and was not run.

## Reproduce

```sh
npm run typecheck
npm run typecheck:behavioral
npm test
npm run benchmark:modes
npm run certify:v0
node scripts/certify-vision-v0.cjs
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:dir -- --mac --arm64
node scripts/check-mode-package.cjs
```

Do not run independent live benchmark and canonical processes at the same time: each process owns its scheduler. This application uses one backend process and one shared scheduler. Canonical commands return a nonzero status when quality gates fail.
