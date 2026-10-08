# Sovereign Workbench — Local Model Latency Baseline

## Measurement basis

Two evidence sources, and it's important to separate them:

- **Live model**: `qwen/qwen3.5-9b` on LMStudio at `127.0.0.1:1234` (I created a target profile at `tests/.runtime/latency/profile.qwen35-9b.json`; the checked-in `deployed.local.json` points at `qwen2.5-coder-7b-instruct-mlx`, which isn't loaded).
- **Existing evidence**: 148 real-model runs already recorded under `tests/.runtime/evidence/`, which turned out to be a far better sample than my own 12 trials.

I drove the app through the agent CLI at `tests/harness/cli.ts` (sandboxed Electron worker + recording relay), not the GUI. That relay captures every model request body and per-chunk timing, which is what makes the token and prefill numbers exact rather than estimated.

**The headline finding is that I could not complete A–E as intended, because the V2 harness fails on every real request.** 13 of 148 real runs (8.8%) die on a contract bug, and my 6 fresh live runs across A, B and E hit it 100% of the time.

`RunContractSchema` at backend/src/main/run/contract.ts:19 declares `successMarker: z.string().min(1).max(128).optional()`. The classifier schema in backend/src/main/router/contextual-router.ts:113 advertises `successMarker` as a plain string with no minimum, so the model legitimately returns `"successMarker": ""` when no success token was requested. `normalizeRunContract` then passes that empty string straight into `RunContractSchema.parse`, which throws `too_small`, and `execute` fails the whole run. A perfectly ordinary chat question never reaches the agent loop.

## 1\. Latency breakdown

End-to-end, n=148 real runs:

|  | median | p95 | max |
|---|---|---|---|
| Wall clock | 35\.2 s | 228\.8 s | 518\.5 s |
| Mandatory classifier call | 7\.9 s | 11\.4 s | 45\.4 s |
| Model calls per run | 4 | 10 | 19 |

The classifier call is a **median 18.1% of total wall clock**, and at p95 it is **88\.5%** — on short runs it _is_ the run. It's a fully sequential pre-loop stage: `resolveSemanticIntent` completes and persists a contract before `composeTools` and the first agent turn begin.

Model calls per run are bimodal, and the distribution explains why: 1 call (n=11), 2 (n=24), 3 (n=20), 4 (n=37), then a long tail to 19. The 1-call runs are exactly the ones dying on `successMarker`. Scenario medians range from 1 (`latency-a/b/e`) to 8 (`dependent-operations-parser`, n=41).

Inference itself is slow but consistent:

- TTFT \~555 ms, very tight (±10 ms across trials)
- Decode \~21 tok/s (512-token completion = 25.1 s)
- Classifier: 481 prompt tokens, 443 response-format tokens, `max_tokens: 768`, non-streaming → 7.4–10.0 s

Wall clock vs summed operation duration, as you asked: tool execution runs concurrently within a turn via `Promise.all` in `dispatchConcurrent`, and read-only calls overlap while mutations act as barriers. Summed tool time is 283 s over 148 runs (1913 ms/run mean) against35 s median wall clock, so summing durations would overstate cost several-fold. The honest reading is that time outside inference is small and inference is the bottleneck — with one exception below.

Non-inference overhead is negligible and not worth optimising: context compaction is **0\.005 ms/op** (pure local string truncation, no model call), result-payload serialize+write **0\.044 ms**, prompt serialization **0\.039 ms**. There is no low-hanging fruit here.

## 2\. Context budget for an 8K model

Tool schemas are the problem, and they're worse than the message history:

| Scenario | prompt tok | tool-schema tok | schema share |
|---|---|---|---|
| A simple chat | 538 | 1057 | 66\.3% |
| B CSV analysis | 654 | 1655 | 71\.7% |
| C single-doc report | 702 | 920 | 56\.7% |
| E workspace modify | 714 | 1076 | 60\.1% |

**Tool definitions consume 57–72% of every agent turn's input.** Per-tool breakdown: `retrieve_result` 1380 bytes, `run_command` 2057, `read_file` 394, `write_file` 539\.

Two budgets collide here. `retrieve_result` alone is \~345 tokens, and it's present in the workspace tool set even when the run has produced no results to retrieve — in scenario A, a pure chat question with no tools, 1057 tokens of schema are sent for a request that will use none of it. Meanwhile `agent-loop.ts:783` allocates `turnMaxTokens` of 4096 after disk mutations, so a single turn can request 4096 output against an 8K window.

Against 8192: system prompt \~950 tokens + schemas \~1100 + history (capped at 10 messages, `getRecentChatHistory`) + tool observations budgeted at 8000 chars for `read_file` and 2000 for older turns. A single large `read_file` observation (8000 chars ≈ 2000 tokens) plus schemas plus history crosses50% of the window. The `global`8000-char safety limit and the 4096 output allocation are not jointly consistent with an 8K budget — that's a real constraint violation, not just a tuning concern.

## 3\. Bottlenecks

1. **Mandatory pre-loop classifier.** \~7.9 s median, sequential, before any user-visible work, on every request including greetings. This is the single largest fixed cost.
2. **Tool-schema bloat.** 57–72% of input tokens, largely spent on tools the model won't call. Directly inflates prefill on every turn of every run.
3. **Multi-turn re-prefill.** Each agent turn resends the full growing history and the full schema set. Measured agent-turn cost climbs with turn count; the C scenario reached 7 calls / 10,709 total input tokens.
4. **`generate_code` nested model calls.** One recorded tool call took **208,343 ms**. `generate_code` delegates to `CodeModel.generate`, which is itself a model call plus an automatic validation-retry second call. It's billed as a _tool_, so it's invisible in call-count telemetry while being the single largest non-loop latency in the dataset. `run_command` also shows a 60 s max.
5. **JSON repair retries: 4.1%** (6/148 runs needed ≥1 retry). Low, but each retry re-sends the whole classifier prompt under a 15 s deadline, and the repair prompt appends up to 800 chars of prior output.
6. **Prefix-cache sensitivity.** My prefill sweep showed cold-vs-warm swings from 7.0 s to 1.3 s at 4000 tokens. LMStudio prefix caching makes steady-state runs much cheaper than first-run numbers, so single cold measurements overestimate badly.

## 4\. Recommended inference-saving changes

- **Skip the model classifier for unambiguous cases.** A deterministic pre-router already exists and is unused on this path: `pickDriverModel` in backend/src/main/router/driver-router.ts resolves attachment/workspace/keyword signals with zero inference. Route clear cases (single PDF attachment, active workspace, "fix"/"crash" keywords) through it and reserve the LLM classifier for genuinely ambiguous multi-signal requests. This is the highest-value change: it removes \~7.9 s from a large fraction of runs.
- **Fix `successMarker` before anything else.** `.min(1)` should become `.max(128).optional()` with empty string normalised to `undefined` at the boundary. Right now this is costing 8.8% of all real runs outright, and it blocks meaningful A–E latency measurement.
- **Trim tool schemas per turn.** Drop `retrieve_result` until the run has results, drop `run_command`/`write_file`/`delete_file` for read-only intents. `constrainToolsToIntent` already exists; extend it to prune rather than only restrict. This is pure prefill savings with no behavioural change.
- **Budget the 8K window explicitly.** The4096 `turnMaxTokens` should be derived from remaining context, not fixed, so schema + history + output can't jointly overflow.
- **Make `generate_code` visible in telemetry.** It should emit a distinct nested-call event; right now a 3.5-minute operation is indistinguishable from a slow file read.

I'd avoid touching compaction, ResultStore, and persistence. They're sub-millisecond and already correct.

## 5\. Maximum safe scope for a lightweight P1-C

All six of your constraints are satisfiable, and three are _already satisfied_ by existing architecture:

| Constraint | Status |
|---|---|
| Zero additional mandatory model invocations | Achievable — must not add a summarizer/planner call |
| Bounded model-facing state summary | Achievable — pure local derivation |
| No new planner-model call | Achievable — `planner.ts` is unused on the V2 path |
| No automatic retrieval after every tool call | **Already true** — retrieval is model-initiated only |
| No state writes during token streaming | **Already true** — `persistAssistant` fires once after the loop at /Users/krichay/projects/agent/backend/src/main/run/manager.ts:1144; chunks are buffered in `streamedChunks` |
| No change to the simple-chat fast path | Achievable, but see the blocker below |

Nothing in the existing architecture resists these constraints. The design is already controller-friendly: state is a local `messages` array, compaction is synchronous and local, `RunContract` is already persisted once before execution, and `RunResultStore` is explicitly documented as "run-bound facade over existing SQLite and intermediate files; contains no conversation state."

**The one genuine difficulty is that the simple-chat fast path doesn't currently exist.** `chatResponseOnly` is set correctly and persisted in the contract, but nothing in the V2 loop short-circuits on it. Scenario A — a two-sentence question — still costs a 7.9 s classifier call plus a full agent turn with 1057 tokens of tool schemas. So "don't change the fast path" is currently moot: there's nothing to protect.

**Maximum safe scope**, in my judgement:

- A local `ExecutionController` holding run state as an in-memory projection, persisted only at existing lifecycle points (contract creation, turn boundary, terminal state).
- A bounded, deterministically-derived model-facing state summary (turn index, tool names, result IDs, outstanding expectations) capped at a fixed small token budget — no model call to produce it.
- Derived from the existing `RunContract` acceptance fields, never re-interpreted from the raw prompt.
- Purely additive; no change to `resolveSemanticIntent`, `composeTools`, `dispatchConcurrent`, or the persistence cadence.

I'd explicitly exclude from P1-C: any change to the classifier, any schema pruning, any `turnMaxTokens` change. Those are separate changes that need their own measurement, and bundling them would make the latency effect unattributable.

## 6\. Methodology and regression thresholds

**Method.** Drive `tests/harness/cli.ts` via `runScenario` from a probe that never calls `appendFinding` (`run` mode writes to `tests/BEHAVIORAL_ISSUES.md`; my probe deliberately bypasses it). Pin an explicit target profile — never the ambient default. ≥5 trials per scenario, report median and p95, discard the first trial as cold-prefix. Record model metadata via `preflightTarget` so results are attributable to a specific model. Use the relay's captured request bodies with `gpt-tokenizer` for exact token counts rather than the `/4` heuristic.

**Two measurement traps worth encoding in the harness.** Prefix caching makes cold and warm runs differ by up to 5x, so single measurements are not comparable. And wall clock must not be derived from summed durations, since tools within a turn run concurrently behind mutation barriers.

**Proposed regression thresholds** (from this baseline; tighten after P1-C lands):

| Metric | Baseline | Gate |
|---|---|---|
| `successMarker` contract failure rate | 8\.8% | **0%** — blocking |
| Classifier calls per run | 1\.0 | must stay 1.0 |
| Median model calls, simple chat | 2 | ≤2 |
| Median model calls, 3-tool run | 5 | ≤5, never increase |
| Tool-schema share of turn input | 57–72% | ≤40% |
| Median wall clock, 3-tool run | \~35 s | no regression \>10% |
| Total input tokens, complex scenario | 10,709 | ≤10,709 |
| Non-inference overhead per run | \<2 ms | \<50 ms |
| Nested `generate_code` visibility | untracked | every call emits an event |

**Two caveats on this report.** The p95 wall clock (228.8 s) is dominated by a small number of long-tail runs, several of which hit the 600 s scenario deadline — treat it as a tail indicator, not a target. And A–E are not properly characterised yet: A, B and E each have n=1 real run because of the `successMarker` failure, and my mock runs for C and D failed on artifacts of my own scripted fixture (the mock returned prose where `extract_document` expected JSON), not on production behaviour. Once the contract bug is fixed, A–E should be re-run for a real baseline before any P1-C thresholds are locked.

All probe scripts, scenarios, the target profile, and raw results are under `tests/.runtime/latency/`, which is gitignored.
