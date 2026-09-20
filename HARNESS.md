# Harness Audit — Agentic Work-Execution Layer (read-only, 2026-09-20)

## 1. Runtime Flow

1. `frontend/src/components/InputBar.tsx` → `lib/workbench.ts:startRun` → IPC `workbench:startRun` → `backend/src/main/ipc/handlers.ts:registerRunHandlers` → `run/manager.ts:RunManager.start` (creates `data/runs/<runId>/{input,intermediate,output,logs}`, copies chat attachments into `input/`).
2. `run/manager.ts:execute` classifies via `router/intent-classifier.ts:classifyIntent` (regex/evidence-score, not model) → branches to `executeStandaloneFileCreation` | `executeWorkspaceTask` | `executeVisionTask`/`executeDataTask` | generic plan path.
3. Generic plan path `manager.ts:execute:766-810`: `router/planner.ts:generatePlan` (fast-path single-task unless explicit `step 1…step 2`; else `plan-qwen3-8b` JSON plan) → emit `plan_step`s → sequential loop over `plan.tasks` calling `routeSubtask` + `executeDataTask`/`executeChatTask` with original text. No tool calls, no replan, subtask `description` unused except routing label.
4. Workspace branch `manager.ts:executeWorkspaceTask:1867`: emits 2 hardcoded `plan_step`s → snapshots tree once (`harness-manager.ts:getDirectoryTree` → `tools/list-dir.ts:listDir`, depth 4) → `harness-prompt.ts:buildHarnessSystemPrompt(tree)` + JSON-format instructions → `MAX_TURNS=10` loop: `gateway.execute(harness-step)` → `parseWorkspaceAction` → `harness.executeTool(toolCall, runId)` → append `Turn N Action/Result` strings to `conversationHistory` → next model call.
5. Tool dispatch `harness/harness-manager.ts:executeTool:99`: `resolveSafe` containment → `list_dir|read_file|search|write_file|delete_file|run_command` in `harness/tools/*.ts` → emits `tool_call`/`tool_result` summaries + `workspace_tree` refresh to UI; returns full result JSON-stringified into model `conversationHistory`.
6. Model I/O `gateway/model-gateway.ts:execute`: chat-completions with `messages=[system,user]+history`, `response_format=json_schema|json_object`, no `tools` parameter ever sent. `harness-step` schema constrains `tool` enum (omits `delete_file`). Results normalized via `normalizer.ts:parseProviderContent/normalizeResponse`.
7. State: run state in SQLite `run/store.ts:transition` (`created→classifying→planning→acting→completed/failed`, plus `awaiting_confirmation`); per-run `conversationHistory` is a local string, discarded at `complete()`; cross-run memory = last 10 chat messages (`getRecentChatHistory`), copied `input/` files, `artifacts` table. Workspace root persisted in settings (`workspace-manager.ts:restoreWorkspace`).
8. Completion: `final_answer` → `persistAssistant` → `complete()`; destructive `run_command` diverts to `awaitConfirmation` continuation and `return`s out of the loop; `executeDataTask` python path has its own bounded `MAX_REPAIRS=2` repair loop + confirmation gates for `execute_python`/`generate_xlsx`; vision/chat paths are single model call → optional artifact write → `complete()`.

## 2. Harness Map

```text
Agent loop
  ├─ Planning: one-shot hardcoded (workspace) or fast-path single-task (generic); LLM planner only on explicit multi-step phrasing; plan never revised from observations
  ├─ Workspace discovery: one-time tree snapshot injected into prompt; progressive list_dir/search/read_file possible ONLY inside executeWorkspaceTask loop
  ├─ File/resource access: 6 tools implemented (list_dir, read_file≤200KB, search, write_file+backup, delete_file+backup, run_command 60s/cwd-locked); all gated by resolveSafe path-guard
  ├─ Tool execution: HarnessManager.executeTool works; model invokes via fragile JSON-in-prompt (no native function calling; HARNESS_TOOL_DEFINITIONS never sent)
  ├─ Observation/result handling: full result JSON appended to local conversationHistory string; UI gets summaries only; tree snapshot never refreshed in model context; outputs truncated (8KB command, 200KB file, depth-4 list)
  ├─ State/context: per-run string + last-10 chat msgs + input/ copies + artifacts table; tool trace discarded between runs; workspace root persists
  └─ Completion/verification: unconditional accept of final_answer; MAX_TURNS fallback emits generic "Completed…" message; no filesystem/test verification before complete
```

## 3. Current Behavior

- Messy multi-file task without explicit workspace nouns/paths is regex-routed to `chat`/`standalone_file`/`data`/`vision`, each a single model call with no discovery loop; files are injected upfront (`input/` copies, CSV preview, attachment bytes), not progressively inspected.
- Only an explicit workspace-framed request (`in workspace|folder|dir`, path syntax, `list files|search in codebase`, `run … test`) reaches the real observe→act→observe loop in `executeWorkspaceTask`.
- That loop starts with a stale-by-construction tree (names+sizes only, depth ≤4, 5s cache) and never re-injects a fresh tree; the model must remember to `list_dir` again.
- Each turn sends growing `conversationHistory` (all prior tool JSON) as one `userPrompt` string; long explorations risk context bloat/truncation with no compaction/summarization.
- `write_file`/`delete_file`/`run_command` mutate disk immediately (backups aside); only destructive-command strings and python/xlsx/docx outputs pause for `ConfirmationModal`; there is no dry-run/plan-approval step.
- `delete_file` is advertised in the prompt but excluded from the gateway `harness-step` JSON-schema enum, so schema-strict providers suppress it; only lenient local `json_object` mode lets it through (plus a write-empty→delete rewrite hack).
- Errors from tools become `Turn N Result: Error: …` text; the model may retry, but there is no error classification, no backoff, no replan — just another JSON guess.
- After 10 turns with no `final_answer`, the run still `complete()`s with a canned summary; unwritten/unverified work is reported as done.
- Follow-up turns start a new run with a fresh loop; prior tool trace is invisible except via 10 chat messages and copied files — the agent re-discovers from scratch.
- UI-exposed IPC tools (`LIST_DIR/READ_FILE/SEARCH/WRITE_FILE/RUN_COMMAND`) are user-driven and disconnected from the model loop; the model can only act through `executeWorkspaceTask`'s prompt loop.

## 4. Failure Points

| Problem | Location | Status | Consequence |
| ------- | -------- | ------ | ----------- |
| No native function-calling; tools via JSON-in-prompt + `parseWorkspaceAction` string matching | `gateway/model-gateway.ts:518-526` (no `tools` param); `run/manager.ts:2285-2430` | working but fragile | malformed JSON / wrong keys → silent fallback to `final_answer`; loop ends without action |
| `HARNESS_TOOL_DEFINITIONS` (6 OpenAI tools) never sent to any provider | `harness/harness-prompt.ts:43` vs all callers (only tests import it) | implemented but disconnected | duplicates prompt text; no provider-side validation/retry of tool calls |
| `delete_file` missing from gateway `harness-step` schema enum | `gateway/model-gateway.ts:479` | exposed but unused (schema-suppressed) | model on strict providers cannot discover/delete; deletes only via lenient mode or empty-write hack |
| Planner output never drives tools; generic plan loop re-calls chat/data tasks with original text | `router/planner.ts:31-40`; `run/manager.ts:789-810` | disconnected | multi-step tasks execute same prompt N times; no decomposition into explore→read→edit→verify |
| Workspace loop entry gated by regex intent classifier (needs workspace nouns/path verbs) | `router/intent-classifier.ts:527-549,700-723`; `run/manager.ts:743-758` | working but mis-gated | vague multi-file tasks ("fix the bug", "refactor auth") fall through to single-shot chat |
| Tree snapshot injected once, never refreshed in model context (UI gets `workspace_tree`, model doesn't) | `run/manager.ts:2081-2116,2274` | implemented but disconnected | model acts on stale layout after writes/deletes; must waste turns re-listing |
| Observations are unbounded JSON appends; outputs truncated (8KB cmd, 200KB file cap, depth-4 list, 5s list cache) | `harness/tools/run-command.ts:81`; `read-file.ts:18`; `list-dir.ts:61-68` | working | large repos/files invisible; model cannot page; cache can return stale listings |
| Tool trace (`conversationHistory`) is per-run local string, dropped on `complete()` | `run/manager.ts:2120,2130,2274,2281` | missing persistence | follow-up runs lose exploration state; only 10 chat msgs + file copies survive |
| Termination unverified: any `final_answer` accepted; `MAX_TURNS` expiry emits canned success | `run/manager.ts:2190-2193,2277-2282` | missing verification | incomplete/failed work reported completed; no test/build gate |
| Non-workspace branches (chat/vision/data-summary) are single-pass with no discovery loop | `run/manager.ts:executeChatTask:1779`, `executeVisionTask:929`, `executeDataTask:2432` | missing loop | attachment-heavy tasks can't iteratively read/search workspace or re-query |
| Destructive `run_command` confirmation path `return`s out of the turn loop | `run/manager.ts:2220-2247` | disconnected | post-approval result never re-enters planning; run ends after one command |
| IPC workspace tools are user-invoked, not model-invoked | `ipc/handlers.ts:150-169` | exposed but unused by agent | two parallel tool paths (UI vs model loop) with no shared turn context |

## 5. Biggest Architectural Gap

**Planning/decomposition is disconnected from tool execution — there is no planner-driven observe→act→observe loop outside one regex-gated side branch.**

- `router/planner.ts:31-40` fast-paths ~all prompts to a single task (`routeTask` label only), so the "plan" is one line and never references files/tools.
- `run/manager.ts:789-810` iterates `plan.tasks` but each iteration just re-invokes `executeChatTask`/`executeDataTask` with the original user text; subtask descriptions, dependencies, and tool results never flow into the next step, and no `HarnessToolCall` is ever constructed there.
- `gateway/model-gateway.ts:518-530` never sends `tools`/`tool_choice`; the only loop that executes `HarnessManager.executeTool` (`run/manager.ts:2249` inside `executeWorkspaceTask`) is unreachable unless the regex classifier emits `actionTarget==="harness"`, and it uses its own 2 hardcoded plan steps instead of the planner's output.
- `harness/harness-prompt.ts:43 HARNESS_TOOL_DEFINITIONS` — the canonical machine-readable tool contract — has zero runtime importers (only tests), proving the model loop was built on prompt conventions rather than provider tool-calling.

Net effect: the agent reasons (single completions, static plans) but does not reliably discover/traverse → act → observe → replan, because the component that knows how to decompose (`planner`) cannot call tools, and the component that can call tools (`executeWorkspaceTask`) never receives a dynamic plan.
