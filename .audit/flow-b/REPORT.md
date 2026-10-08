# Flow B controlled historical replay

## Result

The matched replay supports **more generated completion tokens, mostly reasoning, as the dominant measured cause** of the slower current runs. Effective completion throughput was similar across versions. Prompt-token totals were also similar on average, and current system prompts were shorter. Extra AgentLoop turns contribute on some runs, but the number of working turns was not consistently higher in current.

The earlier 211.6s run did not reproduce on every current replay. Three current observations were 211.6s (the supplied Phase 1.5 trace), 180.9s and 90.4s. The historical commits also varied substantially. The fastest full replay here was 75.5s at `ca42748`; its classifier consumed 16.6s, leaving 58.9s for work calls. Thus the old 60–70s working-loop result is consistent with this replay, but 60–70s end-to-end was not reproduced.

## Before / after

| Version | Full wall time, 3 trials | Model calls (incl. classifier) | Working calls | Working prompt tokens, mean | Working completion tokens, mean | Working reasoning tokens, mean | Working-call effective tokens/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| `ca42748` | 75.5 / 119.5 / 97.3s (mean 97.4) | 3 / 6 / 5 | 2 / 5 / 4 (mean 3.7) | 13,964 | 1,405 | 923 | 16.8 |
| `4262616` | 113.6 / 114.2 / 85.4s (mean 104.4) | 4 / 5 / 4 | 3 / 4 / 3 (mean 3.3) | 13,999 | 1,530 | 823 | 16.7 |
| Current Phase 1.5 | 211.6 / 180.9 / 90.4s (mean 161.0) | 5 / 5 / 4 | 4 / 4 / 3 (mean 3.7) | 12,314 | 2,453 | 1,634 | 16.4 |

“Effective tokens/s” is provider-reported completion tokens divided by measured request duration, including prompt prefill and response handling. It is not a pure decoder-speed metric. The reported current 211.6s row is the saved Phase 1.5 trace; the other trials were replayed from the isolated worktrees with the same external fetch instrumentation.

## Calls and outputs

| Path | Typical Flow B tool sequence | Per-call evidence |
|---|---|---|
| `ca42748` | `execute_python` → final; failed or wandering trials added `write_file`, `list_dir`, or `run_command` retries | Classifier: 516 prompt / 255 completion / 255 reasoning tokens, 12.6–16.6s. First working call: 3,427 prompt tokens, 429–1,227 completion tokens, 32.0–63.1s. Later calls used 3,775–4,263 prompt tokens and the post-mutation budget was 350 tokens. |
| `4262616` | `execute_python` (sometimes repeated), occasional `read_file` → final | Classifier was the same 516 / 255 / 255, 12.5–12.8s. Working prompts were 3,764–4,786 tokens per call, and tool schemas were 4,201 chars across 10 tools. Local generation was capped at 2,048 tokens, with 350-token post-mutation summaries. |
| Current | `read_file` → `write_file` → `run_command` → final; one current replay omitted `read_file` | In the 211.6s trace: working prompt/completion/reasoning per call were 2,716/729/672; 3,405/1,467/1,044; 3,855/75/34; 3,988/680/320. Durations were 49.7, 93.8, 13.3 and 41.1s. Current tool schema was 4,643–6,024 chars across 7–8 tools. |

## Ranked findings

1. **Completion generation, especially reasoning — dominant; measured.** In the 211.6s trace, the four work calls generated 2,951 completion tokens, including 2,070 reasoning tokens. The historical three-run means were 1,405–1,530 work completion tokens and 823–923 reasoning tokens. Current average work output was 1.6–1.8× historical, while effective completion throughput was 16.4 tokens/s versus 16.7–16.8. At that rate, the extra ~920–1,050 tokens account for roughly 55–64 seconds, close to the replay mean gap of 57–64 seconds.
2. **Additional AgentLoop turns — secondary and variable.** Current averaged 3.7 work calls, equal to `ca42748` and only 0.4 more than `4262616`. Current paths often separate inspection, workspace write and command verification; older runs often used `execute_python` to combine code generation and execution. But old runs also retried failed tools, reaching five work calls. The observed latency does not support “one extra call” as the main cause.
3. **Prompt/context growth — not supported as the main cause.** Current mean prompt usage was 12.3k tokens per run versus 14.0k at both historical references. Current system prompts were 6,026 chars, shorter than historical 7,950 (`ca42748`) and 9,418 (`4262616`). Current schemas are larger in chars despite having fewer tools; the total prompt-token counts already include that cost.
4. **Model throughput/hardware regression — no evidence in these trials.** The same live Qwen3.5 9B model and server produced roughly the same effective completion throughput. The current run times varied with generated output: its 90.4s replay generated 1,441 work completion tokens, while the 180.9s replay generated 2,967. This spread cautions against treating a single 211.6s run as representative.

## Reasoning and generation settings

The historical loop did **not** have thinking disabled. Historical requests sent no reasoning-control parameter; the classifier used `max_tokens=256` and returned 255 reasoning tokens with `finish_reason=length` on all six historical trials. Historical work calls also returned reasoning tokens. Current requests used `max_tokens=4096`, `presence_penalty=0.1`, and the current instrumentation’s `reasoning_effort=none`; nevertheless, provider usage reported substantial reasoning output. That parameter therefore did not suppress reasoning in the observed LM Studio runs. The 4,096-token ceiling itself was not reached in these samples; the historical 2,048 ceiling was also above observed working-call completions. The old 350-token summary cap did truncate generations, including reasoning-only summaries, so restoring it globally would trade answer quality for speed.

## Controlled conditions and limitations

- The three worktrees were under this repository at `.audit/flow-b/{ca42748,4262616,current}`. Historical builds used the current CLI test harness copied into the worktree; historical backend/runtime source remained at the requested commit. A harness-only gateway injection pinned each version to the same local endpoint.
- All worktrees used the exact same current `broken-vendor-log-parser.py` and `vendor-maintenance-log.csv` fixtures, prompt, workspace/attachment staging, model aliases and `http://127.0.0.1:1234/v1` endpoint. Provider usage and request/response timing were recorded by an external Node fetch hook. It adds `stream_options.include_usage` to streamed calls equally across versions. Non-streaming historical calls have no TTFT measurement; streaming TTFT is split between first reasoning and first visible output in the raw logs.
- LM Studio reported `qwen/qwen3.5-9b`, MLX runtime, 4-bit quantization, 32,768 loaded context and four parallel slots. `lms ls` showed the selected `@4bit` model variant at 5.98 GB. The host was a Mac mini M4, 10 cores, 16 GB RAM. The loaded model/server remained up during the alternating trials. LM Studio app version and low-level MLX/Metal scheduling settings were not exposed by the queried API, so those cannot be compared to the original September environment.
- `ca42748` was faster in some trials but often failed the strict assistant-response checks; `4262616` passed all strict Flow B checks in all three trials. Current passed in its two replay trials; the supplied 211.6s run is measured telemetry rather than a rerun in this harness. Python reported that `sandbox-exec` was unavailable and used its validated development runner in this environment, consistently across all versions.

## Smallest safe follow-ups

Keep P0 policy checks, P1 result persistence and the current general-purpose loop. The smallest evidence-based target is to reduce **unnecessary reasoning/output per action**, not to disable the classifier or remove durable observations. First validate a Qwen3.5-compatible reasoning control; the observed `reasoning_effort=none` setting did not work as a control. If the server offers no effective reasoning switch, test bounded per-turn generation budgets and concise tool/action instructions while retaining room for tool arguments and final findings. Do not restore the 350-token post-mutation summary cap globally: it produced truncated or reasoning-only responses. The trace also suggests avoiding `read_file` when the attached source is already present in trusted run context, since the successful 90.4s replay omitted that call.

Raw per-invocation logs are retained in `.audit/flow-b/logs/`; the original 211.6s telemetry remains under `tests/.runtime/phase15/`.

## Follow-up: reasoning-content inspection, thinking control, and bounded-output probe

This follow-up did not modify production source. Raw request/response reasoning captured by an audit-only fetch hook is in `.audit/flow-b/logs/4262616-reasoning/requests.jsonl` and `.audit/flow-b/logs/current-reasoning/requests.jsonl`.

### Reasoning content

A new `4262616` run completed in 120.8s: 4 working calls, 1,933 completion tokens, 984 reported reasoning tokens, and 108.1s across work requests. A current run completed in 306.7s: 9 working calls, 5,101 completion tokens, 3,149 reasoning tokens, and 295.4s across work requests. Its 17.3 effective completion tokens/s remains close to the historical 17.9, so the added model time follows extra generated tokens, not a measured decoding-throughput drop. The current run had an unusually long retry loop, so it is evidence about content patterns, not a replacement for the earlier three-trial aggregate.

The historical work turns also reasoned aloud, but were shorter and more action-oriented: they identified the missing-value and inclusive-boundary cases, then wrote/tested. The current first two work turns repeatedly re-evaluated whether `> 350` was correct, flipped between interpretations of the same boundary, and restated the row-by-row expected classifications. After tool output disagreed with its prediction, later turns speculated about stale writes and repeated mutations/verification. This verifies both redundant reconsideration and excess narration of straightforward action/verification. I did not find evidence in the sampled reasoning that most tokens merely restated the harness safety guarantees; the large repeated content was task-level diagnosis, contradictions, and recovery from surprising observations. The current system prompt already asks for concise scratchpad reasoning, so that instruction alone did not control the observed output.

### Thinking-control experiment

Using the same harmless file-repair tool prompt and generation settings, the default and `chat_template_kwargs: { enable_thinking: false }` calls returned identical output: 72 completion tokens, 40 reasoning tokens, same `read_file` call, with 5.5s vs 4.2s latency. The native parameter was therefore ineffective on this loaded LM Studio path in this observation. The official Qwen3.5 model card documents this parameter for Chat Completions, but it did not suppress returned reasoning here ([Qwen3.5-9B model card](https://huggingface.co/Qwen/Qwen3.5-9B)). Stop the control investigation unless the serving stack/template changes.

### Bounded-generation probe

A direct, non-executing `write_file` proposal probe used the same prompt/schema at 512, 600, 768, and 1,024 `max_tokens` (one call each; temperature 0.2). At 512 and 600 the model exhausted the allowance entirely in reasoning (`finish_reason=length`, 511/599 reasoning tokens) and emitted no tool call. At 768 and 1,024 it emitted a structurally valid `write_file` proposal and stopped at `tool_calls`, with 754/753 completion tokens, including 494/487 reasoning tokens. This identifies a sharp minimum for this specific action prompt but is not a general safe budget: it did not validate the generated source semantics or run a full capped Flow B.

The production `chatWithTools` path currently discards `finish_reason` from the returned `AgentTurnResponse`; `AgentLoop` can therefore receive tool calls without knowing generation ended by `length`. A truncated mutation proposal is not safe to execute. Before any bounded-budget rollout, carry `finishReason` through the gateway and fail closed before dispatching **any mutation** when it is `length` (optionally allow bounded repair/retry in a fresh inference call). Do not treat an empty/partial result as success. A 768 action cap is only a candidate for further controlled testing, not a recommendation to deploy globally; 512/600 demonstrably prevent this action from completing.

### Revised priority

1. **Verified:** Qwen-native thinking-off control did not change returned reasoning on this serving path.
2. **Verified:** Current reasoning spends extra tokens re-litigating already stated conditions and diagnosing unexpected observations; current replay added thousands of output tokens and additional retries while effective throughput stayed similar.
3. **Smallest safe follow-up:** Improve concise action/observation instructions and avoid prompting the model to re-derive deterministic harness guarantees; keep necessary task diagnosis. Then, in an isolated benchmark, try per-state modest caps with finish-reason propagation and fail-closed mutation handling. Keep the thinking-control path parked for now.
