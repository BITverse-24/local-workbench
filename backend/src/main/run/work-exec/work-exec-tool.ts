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
        "Execute an in-memory sandboxed JavaScript script (QuickJS-WASM, NOT Python) to inspect, filter, query, or aggregate data (CSV, XLSX, JSON, DOCX), or deterministically synthesize deliverables without token limits or arithmetic errors. APIs: readTable, readJson, readText, readDocument, getTableSchema, emitDeliverable, text(output), and built-in data helpers (parseCSV, toCSV, groupBy, sum, avg, min, max, sortBy, unique, round, lines, grep).",
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description:
              "The JavaScript (NOT Python) code to execute. Use await readTable('file.csv') to get row objects, and text('summary') to output findings.",
          },
        },
        required: ["script"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const script = String(args.script ?? args.code ?? "");
    if (!script.trim()) {
      return {
        ok: false,
        output: "The script parameter is required and cannot be empty.",
        summary: "work_exec failed: empty script",
        error: { code: "invalid_arguments", message: "Script parameter cannot be empty", retryable: false },
      };
    }
    if (/^\s*(?:import\s+(?:json|csv|pandas|numpy|sys|os)|from\s+\w+\s+import|def\s+\w+\s*\(|with\s+open\s*\()/m.test(script)) {
      try {
        const { executePythonTool } = await import("../../tools/specialist-tools.js");
        const pyRes = await executePythonTool.execute({ code: script }, context);
        if (pyRes.ok) return pyRes;
      } catch {
        // Fall back to instructional error
      }
      return {
        ok: false,
        output: "work_exec executes JavaScript (QuickJS-WASM), NOT Python. Do not use Python 'import', 'def', or 'with open()'. Use JavaScript syntax:\nconst rows = await readTable('filename.csv'); // returns array of row objects\nconst total = sum(rows, 'column_name'); // or use rows.reduce(...)\ntext(`Result: ${total}`); // record findings\n(Do NOT call emitDeliverable unless an output file was explicitly requested).",
        summary: "work_exec failed: python syntax in javascript sandbox",
        error: { code: "invalid_arguments", message: "work_exec requires JavaScript, not Python", retryable: true },
      };
    }

    const facade = createWorkFacade(context);
    let result = await runWorkScript(script, facade, {
      timeoutMs: 10000,
      signal: context.signal,
    });

    let currentScript = script;
    for (let fixAttempt = 0; fixAttempt < 3 && !result.ok && result.error?.message; fixAttempt++) {
      const readOnlyMatch = result.error.message.match(/'(\w+)' is read-only/);
      if (readOnlyMatch) {
        const varName = readOnlyMatch[1];
        const repairedScript = currentScript.replace(new RegExp(`\\bconst\\s+(${varName})\\b`, 'g'), 'let $1');
        if (repairedScript !== currentScript) {
          currentScript = repairedScript;
          result = await runWorkScript(currentScript, facade, {
            timeoutMs: 10000,
            signal: context.signal,
          });
          continue;
        }
      }

      const notInitMatch = result.error.message.match(/(?:'(\w+)'|\b(\w+))\s+is not initialized/);
      if (notInitMatch) {
        const varName = notInitMatch[1] || notInitMatch[2];
        const outerDefRegex = new RegExp(`\\b(const|let)\\s+(${varName})\\s*=\\s*(await\\s+)?(readJson|readTable|readText|JSON\\.parse|\\{|\\[)`);
        const innerShadowRegex = new RegExp(`\\b(const|let)\\s+${varName}\\s*=\\s*${varName}(\\s*\\[)`);
        if (outerDefRegex.test(currentScript) && innerShadowRegex.test(currentScript)) {
          const alias = `_${varName}_source`;
          const repairedScript = currentScript
            .replace(outerDefRegex, `$1 ${alias} = $3$4`)
            .replace(new RegExp(`\\b(const|let)\\s+(${varName})\\s*=\\s*${varName}(\\s*\\[)`, 'g'), `$1 $2 = ${alias}$3`);
          if (repairedScript !== currentScript) {
            currentScript = repairedScript;
            result = await runWorkScript(currentScript, facade, {
              timeoutMs: 10000,
              signal: context.signal,
            });
            continue;
          }
        }
      }

      if (result.error.message.includes("not a function") && /\b(?:const|let|var)\s+text\b/.test(currentScript)) {
        const repairedScript = currentScript.replace(/\b(?:const|let|var)\s+text\b/g, 'let _text_val');
        if (repairedScript !== currentScript) {
          currentScript = repairedScript;
          result = await runWorkScript(currentScript, facade, {
            timeoutMs: 10000,
            signal: context.signal,
          });
          continue;
        }
      }
      break;
    }

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
      const notInit = (result.error?.message ?? '').match(/(?:'(\w+)'|\b(\w+))\s+is not initialized/);
      const hint = notInit
        ? ` (Tip: '${notInit[1] || notInit[2]}' was shadowed in a local scope like 'const ${notInit[1] || notInit[2]} = ${notInit[1] || notInit[2]}[...]'. Use distinct names for dataset vs field, e.g. const targets = await readJson(...) and const target = targets[dept][cat])`
        : '';
      return {
        ok: false,
        output: `Script execution failed: ${result.error?.message ?? result.output}${hint}`,
        summary,
        error: {
          code: "sandbox_failure",
          message: `${result.error?.message ?? result.output}${hint}`,
          retryable: true,
        },
      };
    }

    return {
      ok: true,
      output: result.output,
      summary,
      artifacts: facade.getExecutedArtifacts(),
    };
  },
};
