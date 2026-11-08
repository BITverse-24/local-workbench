import { randomUUID } from "node:crypto";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "../../tools/types.js";
import { createWorkFacade } from "./work-facade.js";
import { runWorkScript } from "./work-sandbox.js";

export const workExecTool: AgentTool = {
  name: "work_exec",
  definition: {
    type: "function",
    function: {
      name: "work_exec",
      description:
        "Execute an in-memory sandboxed JavaScript script (QuickJS-WASM) to inspect, filter, query, or aggregate attached data (CSV, XLSX, JSON, DOCX), or deterministically synthesize deliverables without token limits or arithmetic errors. APIs: readTable, readJson, readText, readDocument, getTableSchema, emitDeliverable, text(output), and built-in data helpers (parseCSV, toCSV, groupBy, sum, avg, min, max, sortBy, unique, round, lines, grep).",
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description:
              "The JavaScript code to execute. Use await readTable('file.csv') to get row objects, and text('summary') to output findings.",
          },
        },
        required: ["script"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const script = String(args.script ?? "");
    if (!script.trim()) {
      return {
        ok: false,
        output: "The script parameter is required and cannot be empty.",
        summary: "work_exec failed: empty script",
        error: { code: "invalid_arguments", message: "Script parameter cannot be empty", retryable: false },
      };
    }

    const facade = createWorkFacade(context);
    const result = await runWorkScript(script, facade, {
      timeoutMs: 10000,
      signal: context.signal,
    });

    const summary = result.ok
      ? `work_exec completed in ${result.durationMs}ms with ${facade.getExecutedDeliverables().length} deliverable(s)`
      : `work_exec failed: ${result.error?.message ?? result.output}`;

    // P1: Register execution result in immutable RunResultStore
    if (context.resultStore) {
      context.resultStore.registerResult({
        type: "structured",
        status: result.ok ? "complete" : "partial",
        origin: "execution",
        producer: {
          tool: "work_exec",
          callId: context.currentCallId || randomUUID(),
        },
        summary,
        payload: {
          script,
          output: result.output,
          durationMs: result.durationMs,
          discoveredDigests: result.discoveredDigests,
          executedDeliverables: result.executedDeliverables,
        },
        sources: [],
      });
    }

    if (!result.ok) {
      return {
        ok: false,
        output: `Script execution failed: ${result.error?.message ?? result.output}`,
        summary,
        error: {
          code: "sandbox_failure",
          message: result.error?.message ?? result.output,
          retryable: true,
        },
      };
    }

    return {
      ok: true,
      output: result.output,
      summary,
    };
  },
};
