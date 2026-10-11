# Investigation: Unrequested DOCX plan and failed delivery

**Run:** `44a16e1f-37bf-450f-bf33-384b34508d01`  
**Status:** read-only investigation  
**Date reviewed:** 2026-10-11

## Finding

This run had two distinct defects.

First, intent classification turned a request to copy the existing `HelloWorld.md` into the workspace into a request to write `newfile.txt` and produce `newfile.docx`. The resulting contract treated both outputs as required. The Agent loop then showed them in one plan for approval. The user approved that plan, and the app attempted the DOCX operation.

Second, the DOCX tool call supplied `report_rows: []`. The tool rejects an empty report row list. It returned the concrete error “Report rows must contain source citations and supported text columns.” Later model output contained a JSON tool-call example inside ordinary text. The gateway did not parse it as a tool call. The run then failed, and the manager recorded the generic code `invalid_model_response`.

The evidence supports an intent-classification and contract-enforcement failure, followed by a bad tool call and a failed recovery response. It does not show the model’s raw classification output or full prompt. Therefore, it cannot explain which exact model output or token caused the false DOCX request.

## User request and observed result

The relevant conversation was:

1. User: “Make an md artifact with the text 'Hello, World!'”
2. Assistant: “HelloWorld.md saved. All required checks passed.”
3. User: “Now add this file into the workspace. Either by moving it or by creating new file with exact content into workspace”
4. The run produced a plan for `write_file newfile.txt` and `generate_deliverable newfile.docx`.

The screenshot shows the plan approval dialog. The run record says the approval outcome was `approved`. This approval was for the combined plan proposed by the app; the evidence does not indicate that the user had asked for or independently requested a DOCX.

The run’s saved contract listed the objective as `workspace edits`, the workspace target as `newfile.txt`, and the required deliverable as `newfile.docx` of type `docx`. The ledger says both remained pending. Its only recorded operation attempt was the failed `generate_deliverable` call. No output artifact was recorded.

## Timeline

Times below are UTC, read from the persisted run data and gateway logs.

| Time | Event |
|---|---|
| 22:15:38.897 | User requested an MD artifact containing “Hello, World!” |
| 22:15:52.159 | Assistant reported `HelloWorld.md` saved |
| 22:16:27.489 | User asked to add that file to the workspace by moving it or writing the exact content |
| 22:16:27.510 and 22:16:31.880 | Two intent-classification calls began; both returned HTTP 200 |
| 22:16:36.230 | Incorrect contract was persisted with `newfile.txt` and `newfile.docx` |
| 22:16:54.460 | User approved the combined plan |
| 22:17:06.425 | `generate_deliverable` failed on the empty `report_rows` list |
| 22:17:21.857–22:17:21.859 | Final error was stored and the run entered `failed` |

The run made seven model calls in total: two classification calls and five later Agent calls. The saved run metrics report about 36 seconds of inference time. Five Agent calls used the gateway’s `fallback_prompt_injection` tool-call path.

## Why an unrequested DOCX entered the plan

RunManager calls `resolveSemanticIntent` before it persists a RunContract. The classifier prompt includes the latest request and a short slice of recent chat history. The current classifier prompt says to classify the latest request and not invent operations or file outputs. Despite that instruction, the persisted result for this run treated the copy request as document drafting and created a DOCX deliverable.

The contract normalizer copies the resolved deliverables into the persisted contract. It does not independently compare each proposed file format and operation with the user’s explicit request. The Agent loop then reads every workspace operation and deliverable from that contract and includes them in the approval plan. This makes a mistaken classification actionable: once stored, the loop treats the inferred DOCX as a required output.

The recent chat history included the earlier request to create an MD artifact. That is relevant context and may have contributed to confusion. The latest request itself clearly refers to adding “this file” to the workspace. Since the raw classifier prompts and replies were redacted in the saved traces, history contamination is a plausible contributing factor, not a proven cause.

There is also a mismatch between the requested source file and the proposed targets. The user referred to the existing `HelloWorld.md`; the plan named `newfile.txt` and `newfile.docx`. The saved contract therefore lost both the source identity and the requested operation details before Agent execution began.

## Why approval did not prevent the error

The approval step reviewed the generated plan. It did not correct or independently verify the intent classification. The screenshot shows one approval action for the plan containing both operations. The run record confirms approval, but not that the DOCX was a user request. Once approved, the Agent loop was authorized to attempt the listed operations.

This means approval served as a safety gate for proposed actions, but it did not act as a check that the plan matched the latest user request. The user had to detect the invented deliverable in the plan.

## Why the DOCX call failed

The failed call requested a simple DOCX and also supplied `report_rows: []`. In the tool implementation, the presence of `report_rows` triggers validation. The schema requires at least one row, and each row must have a non-empty `source`. An empty array fails before document generation. The tool returned the error saved in the ledger: “Report rows must contain source citations and supported text columns.”

This is a deterministic argument-validation failure. The evidence does not show that DOCX package creation or file writing began. The run output directory contained no produced artifact, and the ledger has no completed operation.

## Why the retry did not recover

The tool error was marked retryable. The Agent loop’s recovery path feeds the actual tool error back to the model and can retry incomplete work up to three times. However, the run remained bound to the erroneous contract, which still required `newfile.docx` and the workspace write. Recovery was therefore trying to satisfy the wrong task as well as repair the failed call.

The final stored response says “Understood. I'll correct the JSON and try again.” It then includes a `tool_calls` JSON object as part of that text, with another `generate_deliverable` call and the same empty `report_rows` array. The gateway parser only extracts prompt-based calls from a complete JSON envelope, or a supported `<tool_call>` block. It does not extract JSON fragments embedded in ordinary prose. In the recorded response, the gateway trace has no parsed tool calls, so this text was not dispatched as a second tool call.

The run manager records uncaught failures with the fixed code `invalid_model_response`. This hides the sequence of concrete events from the final error label: the initial tool argument error, followed by a non-executable repair response. The ledger preserves both details in its attempts and blockers.

## Root cause assessment

**Primary cause:** the model’s intent interpretation was accepted as the execution contract without a deterministic check that the DOCX and `newfile.txt` matched the user’s request. This caused an unrequested deliverable to become required work and appear in the approval plan.

**Direct cause of delivery failure:** the generated DOCX call included `report_rows: []`, which the tool rejects.

**Recovery failure:** the later model response embedded a tool-call-shaped object in prose. The gateway did not parse or dispatch it. The persisted contract still contained the wrong required outputs, and the final error code concealed the original tool error.

**Not established:** the exact reason the local model classified the request incorrectly. The logs omit prompt and response content. It is not possible to determine whether the first or second classification call introduced each incorrect field, or how much the earlier MD turn affected the output.

## Evidence and method

This review used the chat messages, saved RunContract, run ledger, run-mode metrics, error record, gateway trace metadata, the screenshot, and the current source code. The database was opened in read-only mode. No model call, run replay, UI action, code change, or repair was performed.

The recorded run data is in `data/data/workbench.db` and `data/runs/44a16e1f-37bf-450f-bf33-384b34508d01/`. The run’s workspace root was `/Users/krishay/projects/test`.

Source locations:

- Classifier instructions and conversation-history construction: [contextual-router.ts](/Users/krishay/projects/agent/backend/src/main/router/contextual-router.ts:146)
- Classification before contract persistence: [manager.ts](/Users/krishay/projects/agent/backend/src/main/run/manager.ts:1059)
- Contract copies classified deliverables: [contract.ts](/Users/krishay/projects/agent/backend/src/main/run/contract.ts:67)
- Agent plan includes contract operations and deliverables: [agent-loop.ts](/Users/krishay/projects/agent/backend/src/main/agent/agent-loop.ts:791)
- Empty report rows rejected: [specialist-tools.ts](/Users/krishay/projects/agent/backend/src/main/tools/specialist-tools.ts:841)
- Fallback response parsing: [model-gateway.ts](/Users/krishay/projects/agent/backend/src/main/gateway/model-gateway.ts:322)
- Generic final failure code: [manager.ts](/Users/krishay/projects/agent/backend/src/main/run/manager.ts:3736)

## Limits

Gateway traces redact the raw prompt and most response content. The exact classifier output and complete retry context are not recoverable from the saved records inspected here. The screenshot shows the proposed plan, while the database confirms the contract and approval state. The report identifies where the control gap occurred, but it does not claim a specific internal model cause that the evidence cannot support.
