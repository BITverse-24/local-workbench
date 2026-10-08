# Phase 1.6 — inference efficiency and truncation safety

## Implementation

- `AgentTurnResponse.finishReason` now carries provider `finish_reason` through both native-tool and prompt-fallback gateway paths.
- `AgentLoop` stops immediately when `finishReason === "length"`. It does not dispatch any tool calls from that response. It returns `partial`, replaces any streamed partial text with an incomplete notice, and preserves earlier successful operations in the record.
- Added concise general instructions to reuse established findings, trust actual tool results, investigate contradictions before repeating a mutation, avoid routine tool-call narration, and keep final answers concise.
- Tool observations now use the explicit label `[Observed result from …]`.
- Repeated pending validation feedback is replaced, not appended. Once validation succeeds, stale pending feedback is removed. This prevents the loop from accumulating the same next-step instruction after every successful write.
- Added opt-in state-aware benchmark profiles through `SW_AGENT_EXPERIMENTAL_BUDGET_PROFILE`: `roomy` uses 2,048 tokens for action/validation turns and 1,024 after validation; `bounded` uses 1,024 and 768. The default remains unchanged at the existing allowance.

## Regression tests and verification

Tests cover cutoff before a tool call, cutoff during a tool proposal, and cutoff during the final response after a mutation. In all cases the run is incomplete. In the tool-proposal case, the mutation tool is not called.

`npm run typecheck`, `npm test`, and the focused gateway/AgentLoop tests passed. Full test suite: 625 passed, 6 skipped. Each live Flow B trial below passed all 7 existing acceptance checks.

## Flow B benchmark

Nine warm Flow B runs used the same current fixture, live Qwen3.5-9B MLX 4-bit model, LM Studio server, and host. Profiles alternated in three rounds. Times below are Flow B run wall time. Token counts are provider-reported working-model totals and exclude the classifier call.

| Profile | Action / final budget | Wall time, trials | Mean wall | Working calls, mean | Completion tokens, mean | Reasoning tokens, mean | Accepted | Length stops | Failed tools / repeated writes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Default | 4,096 / 4,096 | 126.7 / 96.5 / 223.3s | 148.8s | 3.67 | 2,369 | 1,748 | 3/3 | 0 | 0 / 0 |
| Roomy | 2,048 / 1,024 | 169.4 / 154.0 / 95.5s | 139.6s | 3.67 | 2,163 | 1,545 | 3/3 | 0 | 0 / 0 |
| Bounded | 1,024 / 768 | 82.2 / 85.2 / 83.9s | 83.8s | 3.00 | 1,241 | 776 | 3/3 | 0 | 0 / 0 |

Tool paths:

- Default: `write_file → run_command`; one trial added two `read_file` calls, and one added an initial `read_file`.
- Roomy: two trials used `read_file → write_file → run_command`; one used `write_file → run_command`.
- Bounded: all three used `write_file → run_command`.

Against this experiment’s default profile, bounded reduced mean wall time by 43.7%, mean working completion tokens by 47.6%, mean reasoning tokens by 55.6%, and mean working calls by 18.2%. All bounded calls ended normally; none reached the token limit. The small fixture’s corrected written source fit within the action budget, then the following action validated it.

The roomy profile reduced mean output by 8.7% and reasoning by 11.6%, but mean wall time improved by only 6.2%; results varied from 95.5 to 169.4s. It does not show a reliable benefit over default.

## Decision

The bounded profile is promising for this Flow B repair task: 3/3 runs passed with no failed tools, duplicate writes, or length stops. This is not enough evidence to enable 1,024/768 budgets by default for general-purpose work. The benchmark covers one short Python repair. Longer source files, large deliverables, and multi-step tasks can need more output, including reasoning tokens inside the same allowance.

Keep the default budget at 4,096. Keep `bounded` opt-in for more varied local evaluation. Keep the gateway/AgentLoop cutoff guard enabled for every profile. A future default decision needs representative long-code, document-generation, and multi-tool tasks, including at least one tested recovery path for `finish_reason=length`.

## Trial records

Per-call timing, provider token counts, generation limits, finish reasons, tool calls, and acceptance logs are under `.audit/phase1.6/trials/`. The aggregate is `.audit/phase1.6/benchmark-results.json`. The first pre-feedback-dedup default run was stopped and excluded; see `.audit/phase1.6/initial-default-aborted-feedback-duplication/`.
