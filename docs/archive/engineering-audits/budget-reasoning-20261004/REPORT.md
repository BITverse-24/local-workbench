# Sovereign Workbench — Generation Budget and Reasoning Sensitivity

Date: 2026-10-04  
Model: `qwen/qwen3.5-9b` via local LM Studio 0.4.25+1 (MLX, 4-bit)  
Host: Mac mini, Apple M4, 16 GB  
Source revision: `7da5c3d42fc1050fcbcd802f22535bee3b93c0e0`

## Scope and controls

This was an audit-only CLI benchmark. Each profile ran in a copied project under `isolated-project/`. No production source, prompt, router, tool definition, policy, or profile was changed. The copy changes only the audit runner's generation-budget profile mapping. Existing unrelated worktree edits were present and left untouched.

Flow B used five valid, unseeded runs per profile, for 25 runs. Each run used the same fixture, prompt, harness, model, temperature (0.2), tool choice (`auto`), and request flow. The application context budget was 8192. LM Studio remained loaded at 32768 despite a CLI reload request for 8192; therefore the app's context budgeter, rather than LM Studio's loaded context setting, bounded these runs. The exact model directory manifest hash is in `environment.json`; file hashes are in `model-file-sha256.json`.

Profiles: A0 = 1024/768; A1 = 1280/1024; A2 = 1536/1024; A3 = 2048/1280; A4 = 4096/4096 (action / post-validation caps). Five CLI runs per profile are in `trials/`. `budget-results.json` contains every trial and per-call telemetry. P95 is nearest-rank. With five runs, P95 is the slowest observation, not a stable tail estimate.

## Flow B results

| Profile | Completed | Median wall time (all runs) | P95 wall time | Length stops | Acceptance checks |
|---|---:|---:|---:|---:|---:|
| A0 | 3/5 | 95.9 s | 131.9 s | 2 | 25/35 |
| A1 | 5/5 | 141.9 s | 179.3 s | 0 | 35/35 |
| A2 | 5/5 | 147.1 s | 169.6 s | 0 | 35/35 |
| A3 | 5/5 | 113.9 s | 165.4 s | 0 | 35/35 |
| A4 | 4/5 | 171.5 s | 315.6 s | 1 | 32/35 |

All successful Flow B runs passed all seven task checks and verified the repaired parser. A0 had two output-limit stops while proposing a next action. A4 had one stop in its final-answer phase after earlier work, including file write and execution. No partial tool call with empty arguments ran. The lowest median among the tested profiles was A3. A1 and A2 also completed all five runs, with slower medians. A4 was slower and had one failure. These five-run results do not prove general reliability.

Per-call telemetry separates working-model calls from classification calls. It records input, completion, reasoning and non-reasoning tokens, TTFT, decode duration, finish reason, tool-schema size, tools and tool execution time. Prompt-cache hit data was not exposed by the observed responses. Tool-schema token counts are estimates from serialized schema size divided by four.

## Cross-workflow CLI check

One run per profile was made for each of Flow A, Flow C and financial reconciliation. These are directional checks only; they are not reliability estimates.

| Workflow | A0 | A1 | A3 | A4 |
|---|---|---|---|---|
| Flow A | Fail, length stop (116.2 s) | Fail, length stop (131.6 s) | Pass (208.7 s) | Pass (201.8 s) |
| Flow C | Pass (170.6 s; 8 working calls) | Pass (117.0 s; 5 calls) | Pass (166.2 s; 6 calls) | Pass (81.8 s; 3 calls) |
| Financial | Fail, length stop (73.0 s) | Fail, length stop (86.4 s) | Fail, length stop (160.7 s) | Pass (336.6 s) |

A3 completed Flow A and Flow C, but stopped in financial reconciliation before Python ran. A4 completed all three workflows in this one-run check, but was slow on financial reconciliation. A0 and A1 failed two workflows each. Flow C passed for all profiles, but some runs repeated document extraction calls. This check does not support one safe default across all workflows.

## Reasoning-mode sensitivity

The OpenAI-compatible endpoint accepted a `seed` field and `chat_template_kwargs.enable_thinking=false`. The capability probe used a 96-token output limit. All three calls stopped at that limit and returned the same truncated reasoning prefix. The probe does not show that the seed changes sampling or that the template field disables reasoning. No matched-seed workflow comparison or valid reasoning-mode comparison was run. See `reasoning-results.json` and `raw/capability-probe.json`.

Qwen documents a `enable_thinking` template setting for Qwen3, and Qwen-Agent shows `chat_template_kwargs` in a Qwen3.5 example. LM Studio documents model load context settings, with runtime-specific support limits. These references do not prove that this LM Studio MLX server honors the reasoning flag or that its CLI context reload changes the loaded MLX context: [Qwen3 quickstart](https://github.com/QwenLM/Qwen3/blob/main/docs/source/getting_started/quickstart.md), [Qwen-Agent Qwen3.5 example](https://github.com/QwenLM/Qwen-Agent/blob/main/examples/assistant_qwen3.5.py), [LM Studio model loading](https://lmstudio.ai/docs/developer/rest/load).

## Finding and next step

For Flow B alone, A3 is the best observed balance in this sample: 5/5 completion, no length stops, and the lowest median wall time. Do not promote it as a universal profile. The cross-workflow runs show that performance depends on the workflow. Keep the current production profile unchanged. A follow-up should establish a real reasoning control before running a reasoning sensitivity comparison. Then repeat cross-workflow runs with more than one trial per condition.

## Files

- `budget-results.json`: all 25 Flow B trials and aggregates.
- `reasoning-results.json`: capability check and limits.
- `length-stop-analysis.md`: stop locations and truncated tool-call details.
- `cross-workflow-results.json`: all 12 directional checks.
- `trials/` and `cross-workflow/`: raw CLI logs, events and request/response traces.
- `environment.json`, `model-file-sha256.json`, `raw/`: environment and model identification evidence.
- `setup-issues/`: preserved invalid setup attempt; excluded from valid results.
