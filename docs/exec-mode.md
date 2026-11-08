# Code Mode (Read-Only `exec`) in Agent Observe Phase

## Overview

Code Mode provides a programmable read-only execution interface for the **observe step** in Local Workbench's Agent loop. Instead of exposing individual JSON schemas for every read tool (`list_dir`, `read_file`, `search`, `read_input`, `extract_document`, `retrieve_knowledge`, `retrieve_result`) on every turn, the model is given a single execution interface against a typed TypeScript signature block.

The model writes a JavaScript or TypeScript snippet that executes inside a secure WebAssembly sandbox (QuickJS). Intermediate results (such as large directory listings or filtered search matches) remain inside the sandbox memory and do not bloat the model's context window. Only the final distilled observation passed to `text(...)` returns to the model.

If programmatic execution fails or is not supported by the model, the runtime executes a **one-way sticky switch to native tool calling**.

---

## Architecture

```text
                  Model Turn (Observe Phase)
                             │
                             ▼
              exec({ code: "..." })  [ToolCall]
                             │
                             ▼
       ┌───────────────────────────────────────────────┐
       │             QuickJS-WASM Sandbox              │
       │   - 32 MB Memory limit                        │
       │   - 5000 ms CPU deadline interrupt            │
       │   - Zero Node globals (no process, fs, fetch) │
       │   - tools.* facade + text() + escalate()      │
       └───────────────────────┬───────────────────────┘
                               │
                               ▼
       ┌───────────────────────────────────────────────┐
       │             ToolDispatcher Broker             │
       │   - Scoped reads (resolveSafe, allowedPaths)  │
       │   - Max 20 tool calls per script              │
       │   - Persists child results to ResultStore     │
       │   - Logs parentExecId in Execution Ledger     │
       └───────────────────────────────────────────────┘
```

### Safety and Security Guarantees
- **Sandboxed Execution**: Executes via `quickjs-emscripten` compiled to WebAssembly. The guest environment has no access to Node's runtime, file system, process tree, or network.
- **Read-Only Scope**: The facade allowlist permits only non-mutating operations: `read_file`, `search`, `list_dir`, `read_input`, `extract_document`, `retrieve_knowledge`, and `retrieve_result`. Any attempt to call mutating tools (`write_file`, `delete_file`, `run_command`, etc.) is rejected immediately.
- **Resource Constraints**:
  - Memory: 32 MB hard limit via QuickJS runtime.
  - Execution Time: 5,000 ms wall-clock deadline via QuickJS interrupt handler (`shouldInterruptAfterDeadline`).
  - Tool Call Limit: 20 calls maximum per script.
  - Output Cap: Distilled text output is capped at ~1,500 tokens (~6,000 characters).
- **Evidence Integrity**: Script outputs are registered in `ResultStore` as `model_derived` under `agent_exec_output`. The script itself cannot satisfy an `inspect` requirement; only underlying reads executed through the dispatcher create verified source receipts.

---

## State Machine & Sticky Fallback

The observe phase is governed by `nextObserveState` in `backend/src/main/agent/exec/exec-policy.ts`:

1. **Initial Mode**: Starts in `"exec"` when `WORKBENCH_AGENT_EXEC=observe`.
2. **Two-Strike Failure Switch**: A syntax error, runtime error, timeout, or empty parse increments the failure counter. On the second consecutive failure, the mode permanently switches to `"native"`.
3. **Progress Tracking**: If two consecutive scripts execute successfully but discover no new source evidence digests, the mode switches to `"native"`.
4. **Model Escalation**: If the model invokes `escalate(reason)`, the runtime immediately transitions to `"native"`.
5. **Sticky Persistence**: Once transitioned to `"native"`, the state remains in native mode for the rest of the task to avoid prompt cache thrashing on local inference engines.

---

## Empirical Transport Analysis (LM Studio & 7-14B SLMs)

Evaluated against `qwen/qwen3.5-9b` hosted on LM Studio:

| Dimension | Arm B: Fenced Markdown (```ts) | Arm C: Tool Call (`exec({ code })`) [WINNER] |
| :--- | :--- | :--- |
| **Completion Tokens** | 376 - 512+ tokens | **126 tokens** (66% - 75% reduction) |
| **Reasoning Loops** | High (burns up to 511 tokens in thinking tags before emitting content) | **Zero** (constrained logit sampling directs output to function arguments) |
| **Schema Compliance** | Prone to hallucinating host imports (`child_process`, `fs/promises`) | **High** (invokes `tools.listDir` / `tools.*` directly) |
| **Truncation Risk** | High when thinking tokens consume `max_tokens` | **Negligible** |

**Conclusion**: On modern reasoning-enabled SLMs (such as Qwen 3.5), Arm C (`toolcall`) with `tool_choice: "required"` decisively outperforms free-form fenced markdown. The default transport is set to `"toolcall"`.

---

## Configuration & Environment Flags

- `WORKBENCH_AGENT_EXEC`:
  - `observe` (default): Enables Code Mode in the observe step.
  - `off`: Disables Code Mode, reverting to sequential native tool schemas.
- `WORKBENCH_AGENT_EXEC_TRANSPORT`:
  - `toolcall` (default): Emits single `exec` tool call with JSON schema.
  - `fenced`: Emits fenced ` ```ts ` code block without tool schemas.

---

## Work Mode Code Mode (`work_exec`)

Work Mode provides a specialized Code Mode tool, `work_exec`, enabling autonomous document computation, financial ledger audits, sensor telemetry statistical profiling, and structured file generation in isolated QuickJS sandboxes.

### Key Features:
- **`createWorkFacade`**: Bridges the QuickJS runtime with run-scoped input and output storage (`runs/<runId>/input/`, `runs/<runId>/output/`).
- **`readTable(filename, options)`**: Ingests tabular data from CSV, TSV, or Excel spreadsheets with auto-casting and column projection.
- **`emitDeliverable(options, content)`**: Emits verified deliverable artifacts (`.csv`, `.xlsx`, `.docx`, `.md`, `.json`, `.txt`) into run output storage, checking persisted run contract authorization.
- **Automatic TDZ & Async Repair**: Auto-repairs temporal dead zones, variable shadowing, and un-awaited top-level async functions/IIFEs before execution.

---

## Route 3: Preloaded Analysis Utilities

To eliminate model arithmetic hallucinations and excessive LLM token overhead during data processing, Route 3 preloads high-performance pure JavaScript data analysis routines directly into the QuickJS guest context (`backend/src/main/agent/exec/sandbox-prelude.ts`):

1. **`parseCSV(text, options)` & `RowProxy`**:
   - RFC 4180 compliant CSV parser with quoted field preservation and automatic type coercion.
   - Wraps row objects in a dynamic `RowProxy` supporting casing-insensitive and punctuation-insensitive attribute access (`row["Actual Spend"]`, `row.actual_spend`, `row.actualSpend`).
2. **`toCSV(records, headers)`**:
   - High-speed array-of-objects serialization with proper delimiter escaping.
3. **`groupBy(records, keyFn, aggregator)`**:
   - Multi-key hierarchical grouping with method chaining (`.map()`, `.entries()`, `.values()`, `.reduce()`).
4. **`join(leftRecords, rightRecords, keyMatcher, mergeFn)`**:
   - Hash-based relational inner/left join supporting composite keys and outer defaults.
5. **Statistical Suite**:
   - `avg(values)`: Arithmetic mean.
   - `stdDev(values, sample)`: Bessel-corrected sample standard deviation.
   - `median(values)`: 50th percentile rank.
   - `pctDiff(base, target)`: Percentage variance calculation.
   - `round(value, decimals)`: Exact decimal rounding without IEEE-754 drift.

