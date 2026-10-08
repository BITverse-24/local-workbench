# Flow B performance recovery audit

## Finding

The retained 83.8-second Phase 1.6 result is a real successful sample. It is not evidence of a distinct faster AgentLoop implementation. Its source snapshot is the Phase 1.6 code checkpoint, `f4684a3`, based on `4a7ff83`. The benchmark was recorded before that snapshot was committed. The checkpoint contains the 1,024-token action/validation and 768-token post-validation profile, finish-reason guard, instructions, result formatting and dynamic-dispatch code that were active during the benchmark.

The first working-model request in the retained fast runs and the controlled replay has the same serialized messages, tools and generation parameters. Request hash: `c93a55627ebf`. It has a 6,522-character system prompt, 81-character user prompt, seven tools, 2,798 prompt tokens, temperature 0.2, 1,024 max tokens and `tool_choice=auto`. Both requests use `qwen/qwen3.5-9b`. The source file is already present in the user context, and `write_file` is eligible on the first call.

The old runs chose `write_file` directly. Current runs sometimes choose `read_file` first. That is a sampled model decision. The extra read is not caused by missing source context, a changed initial prompt, unavailable mutation capability, or a capability-discovery turn. No replay made a `request_capability` call.

## Results

The old Phase 1.6 reference completed all three runs in 82.2, 85.2 and 83.9 seconds. Each run passed 7/7 checks with three working calls and the sequence `write_file → run_command → final`. The mean was 1,241 completion tokens and 776 reasoning tokens.

| Run set | Wall seconds | Working calls | Completion / reasoning tokens | Outcomes |
|---|---|---:|---:|---|
| Phase 1.6 reference, 3 runs | 82.2 / 85.2 / 83.9 | 3 each | mean 1,241 / 776 | 3/3 passed; no length stops |
| Same checkpoint, old env selector, replay | 105.5 / 111.0 / 110.0 | 2 / 2 / 2 | mean 1,771 / 1,525 | 0/3 passed; all partial; one length stop each |
| Same checkpoint, current env selector, replay | 64.3 / 111.8 / 107.9 | 1 / 2 / 2 | mean 1,516 / 1,266 | 0/3 passed; all partial; one length stop each |
| Environment-selected profile, new trials | 64.3 / 125.0 / 174.5 | 1 / 4 / 4 | mean 1,861 / 1,392 | 1/3 passed; 2 partial; length stops in runs 1 and 3 |

The final row includes all attempts. Completion and reasoning totals in this table cover working-model calls only; the request logs also include a 170-token classifier completion per run. Across its 21 acceptance checks, 13 passed and 8 failed. Run 1 stopped before a usable mutation proposal. Run 2 passed all checks after `read_file → write_file → run_command`. Run 3 ended partial after the final generation hit its limit. The three-run mean was 121.3 seconds. This is not a recovery of the 83.8-second reference.

The six controlled replay trials used two profile-selection paths against the same checkpoint, not two different AgentLoop source versions. Their first-turn requests were equivalent. All six were partial, so they cannot show that one selection path is faster or more reliable. They do show that switching from the old per-run selector to the environment selector does not restore the fast sample.

## Cause assessment

1. **Verified: model output and sampling variation dominate the change in work.** With the same first-turn request at temperature 0.2 and no seed, repeated direct calls returned different choices: `write_file`, `read_file`, and a length-stopped incomplete proposal. In the recorded successful reference, the model chose a direct mutation. In later trials it sometimes spent a turn reading a file already supplied in context, and it sometimes used most of its budget on reasoning. The unseeded model response is not stable across these samples.
2. **Verified: reasoning/output volume tracks the slower trials.** The successful reference averaged 1,241 completion tokens and 776 reasoning tokens. The three latest environment-profile trials averaged 1,861 working completion and 1,392 reasoning tokens, with two partial outcomes. The additional generated work and calls coincide with longer runs. These samples do not support a precise per-token causal latency estimate.
3. **Verified: the first request size and settings did not grow between the reference and replay.** The request payload hash, prompt size, tool set, model identifier, temperature and token limit match. Later requests grow after tool observations: replay prompt counts rise from 2,798 to roughly 3,400–3,900. This is a consequence of the chosen read/repair path, not the initial cause of the extra read.
4. **Not established: model throughput changed.** Current LM Studio reported Qwen3.5-9B MLX 4-bit with a 32,768 context. Historical model-file checksum, loaded context and host telemetry were not recorded separately. The same live endpoint and host were used for the retained benchmark and replay, but the old settings cannot be independently verified from artifacts. The trials do not isolate throughput from response length and runtime variance.
5. **Not established: a code commit caused the 83.8-to-121.3-second difference.** The 83.8-second run was made on the same Phase 1.6 code now represented by `f4684a3`. In particular, the dynamic-dispatch commit `3be62d5` is already an ancestor of that checkpoint. The replays changed profile selection, not the AgentLoop implementation. The available evidence does not identify a source change that caused the slower samples.

## Focused ablations

- **Temperature 0:** On the exact first-turn payload, all three calls chose `read_file`. One of three temperature-0.2 calls chose `read_file`, one chose `write_file`, and one hit the length limit. Temperature 0 did not recover the fast path, so it is not a supported correction.
- **Prompt guidance:** Adding a general instruction to use complete source already in context produced `read_file`, `write_file`, `read_file` in three calls. The baseline produced `read_file`, `write_file`, `write_file`. This small sample shows no improvement. Do not add the instruction as a performance fix based on these results.
- **Profile-selection replay:** Old environment selection and the new `SW_AGENT_GENERATION_PROFILE` selection had the same limits (1,024/768), same checkpoint and equivalent first request. Both sets had three partial runs. No profile selection path consistently improved results.

These ablations do not prove that prompt wording or model settings can never help. They show that the tested changes did not establish a safe, measurable improvement. There is no evidence to justify a deterministic tool order, temperature change, tighter global cap, removed approval step or other behavior that would trade away general-purpose reasoning or truncation safety.

## Recommendation

Keep the P0/P1 protections, dynamic dispatch, bounded-profile budgets and universal `finish_reason=length` handling. Do not force `write_file`, skip reads when source may have changed, or retry a truncated mutation as success. The present evidence supports no production inference optimization that is both general-purpose and measured to recover 83.8 seconds. Treat 83.8 seconds as an observed good sample, not a repeatable guarantee, until a seeded or otherwise controlled model replay can reproduce it safely.

## Profile UI cleanup

The visible General / Demo-Fast selector has been removed. Select the profile at process start with `SW_AGENT_GENERATION_PROFILE=demo_fast npm run dev`; `default` and the existing 4,096-token general allowance remain the fallback. The Chat/Agent selector and conditional Specialist dropdown remain. This interface cleanup is separate from the performance comparison and did not alter the generation budgets.

## Evidence

- Phase 1.6 reference: [REPORT.md](../phase1.6/REPORT.md), [benchmark-results.json](../phase1.6/benchmark-results.json), and the trial records in `../phase1.6/trials/`.
- Worktree replay: [worktree-replay-results.json](worktree-replay-results.json) and captured request/response JSONL in `worktree-replay/`.
- Environment-selected trials: [env-profile-results.json](env-profile-results.json) and per-run logs/JSONL in `env-profile-trials/`.
- Temperature ablation: [temperature-ablation-results.json](temperature-ablation-results.json).
- Prompt ablation: [prompt-ablation-results.json](prompt-ablation-results.json).
