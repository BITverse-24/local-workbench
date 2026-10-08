# Phase 2 prerequisite — Demo/Fast generation profile

## Change

The existing `requestedGenerationTokens` budget path now accepts an explicit process profile, `demo_fast`: 1,024 tokens for action/validation calls and 768 after validation. The normal `default` profile still uses the existing 4,096-token allowance. No task text, filename, or fixture selects a profile.

Select the profile with `SW_AGENT_GENERATION_PROFILE=demo_fast npm run dev`. The visible General / Demo-Fast selector and per-run profile IPC field have been removed. The Chat/Agent selector and conditional Specialist dropdown remain. The prior experimental environment override remains as a fallback. `finishReason` propagation and fail-closed handling are unchanged.

The live runner now treats `partial` as terminal. This stops an incomplete run from hanging the acceptance script.

## Flow B comparison

The Phase 1.6 records report a bounded-profile mean of 83.8 seconds, 3.00 working calls, 1,241 completion tokens and 776 reasoning tokens. This is the reference from the prior benchmark.

Three fresh Demo/Fast runs used the current Phase 2 dynamic-dispatch implementation, the existing Flow B fixture and the same configured live model endpoint. Trials were sequential because each run uses the shared model server.

| Trial | Wall time | Working calls | Completion tokens | Reasoning tokens | Tool sequence | Acceptance | Length stops | Failed tools / repeated writes |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| 1 | 91.2s | 3 | 1,496 | 911 | write_file → run_command | 7/7 | 0 | 0 / 0 |
| 2 | 150.3s | 4 | 2,490 | 1,849 | read_file → write_file → run_command | 7/7 | 0 | 0 / 0 |
| 3 | 113.6s | 4 | 1,718 | 960 | read_file → write_file → run_command | 7/7 | 0 | 0 / 0 |
| **Mean** | **118.4s** | **3.67** | **1,901** | **1,240** | — | **3/3 passed** | **0** | **0 / 0** |

| Metric | Phase 1.6 Demo/Fast reference | Current Demo/Fast mean | Difference |
|---|---:|---:|---:|
| Wall time | 83.8s | 118.4s | +34.6s (+41%) |
| Working calls | 3.00 | 3.67 | +0.67 (+22%) |
| Completion tokens | 1,241 | 1,901 | +660 (+53%) |
| Reasoning tokens | 776 | 1,240 | +464 (+60%) |
| Acceptance | 3/3 pass | 3/3 pass | — |

All three current runs passed the seven Flow B acceptance checks. None called `request_capability`; `write_file` and `run_command` were already eligible and available. Dynamic dispatch added no capability-discovery turn in these runs. Two runs chose an extra `read_file` call. Completion and reasoning output varied across trials, so the 34.6-second difference from the reference mean cannot be assigned to dispatch from this sample.

One separate initial run ended with `finish_reason=length` after a read-only call and before a mutation proposal. The loop returned `partial`; it did not dispatch a truncated mutation. That diagnostic run is retained under `failed-partial-trial-before-runner-fix/` and excluded from the three-trial statistics.

## Other workflow screen

These are single screening runs, not validation across scenarios or warm-trial distributions.

| Workflow | Result | Working calls | Length stops | Notes |
|---|---|---:|---:|---|
| Flow A: inspection PDFs → approval note | Fail, 105.5s | 2 | 1 | The 1,024-token call ended before `generate_deliverable` could execute; no DOCX was produced. |
| Flow C: drawing / SOP review | Pass, 7/7 | 2 | 0 | Completed in 63.8s. No document artifact was required by the runner. |
| Financial reconciliation → DOCX | Fail, 110.0s | 2 | 1 | The 1,024-token call ended before computation or document generation. |

Demo/Fast must remain an explicit choice. The Flow A and financial runs show that this budget is not safe for every task. The default remains 4,096 tokens.

## Dynamic-dispatch comparison limit

The retained Phase 1.6 benchmark used Qwen3.5-9B through the live LM Studio endpoint and was run on 2026-10-04. Commit `3be62d5` added dynamic capability dispatch earlier that day. Therefore, the 83.8-second reference is **not a verified pre-dispatch measurement**. It is a valid Phase 1.6 budget reference, but it cannot establish a before/after causal effect for dispatch. The fresh runs show no capability-discovery call and no additional dispatch turn. A true pre-dispatch comparison requires replaying the same budgeted code on the parent of `3be62d5` under matched runtime conditions.

## Records

- Phase 1.6 reference and original trials: `.audit/phase1.6/REPORT.md` and `.audit/phase1.6/trials/`.
- New Flow B per-call traces and summaries: `.audit/phase2-prereq/flow-b/trials/` and `.audit/phase2-prereq/benchmark-results.json`.
- Other workflow traces: `.audit/phase2-prereq/other-workflows/`.

## Follow-up recovery audit

The environment-selected profile was run for three more trials after removing the UI selector. One passed all seven checks; two ended partial, including one length stop before a mutation and one length stop during final response. Mean wall time was 121.3 seconds. The results did not reproduce the 83.8-second reference. See [ROOT-CAUSE.md](ROOT-CAUSE.md) for the historical snapshot, request comparison, all controlled replay attempts, focused ablations and verified limits of the conclusion.
