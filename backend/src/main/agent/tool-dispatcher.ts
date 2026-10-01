import type { AgentToolCall } from "../../shared/contracts.js";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "../tools/types.js";

export interface ExecutedToolOutput {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: ToolExecutionResult;
}

export function formatToolCallSummary(toolName: string, args: Record<string, unknown>): string {
  const p =
    typeof args?.path === "string"
      ? args.path
      : typeof args?.filePath === "string"
      ? args.filePath
      : typeof args?.filename === "string"
      ? args.filename
      : typeof args?.file === "string"
      ? args.file
      : typeof args?.target === "string"
      ? args.target
      : typeof args?.document === "string"
      ? args.document
      : "";
  const cmd = typeof args?.command === "string" ? args.command : (typeof args?.cmd === "string" ? args.cmd : "");
  const q = typeof args?.query === "string" ? args.query : (typeof args?.search_query === "string" ? args.search_query : "");

  switch (toolName) {
    case "read_file":
      return p ? `Reading "${p}"` : `Reading file`;
    case "write_file":
      return p ? `Writing "${p}"` : `Writing file`;
    case "delete_file":
      return p ? `Deleting "${p}"` : `Deleting file`;
    case "search":
      return q ? `Searching for "${q}"` : `Searching workspace`;
    case "list_dir":
      return p && p !== "." ? `Listing directory "${p}"` : `Listing workspace directory`;
    case "run_command":
      return cmd ? `Running: ${cmd}` : `Running terminal command`;
    case "execute_python": {
      const inputs = Array.isArray(args?.input_files) && args.input_files.length > 0
        ? ` (${args.input_files.join(", ")})`
        : "";
      return `Executing Python script in sandbox${inputs}`;
    }
    case "draft_code":
      return `Drafting verified code`;
    case "draft_note":
      return `Drafting engineering review note`;
    case "extract_document":
    case "ocr_extract":
      return p ? `Extracting document "${p}"` : `Extracting document`;
    case "inspect_drawing":
      return p ? `Inspecting drawing "${p}"` : `Inspecting engineering drawing`;
    case "retrieve_sop":
    case "retrieve_knowledge":
      return q ? `Querying knowledge base for "${q}"` : `Querying local knowledge base`;
    case "generate_deliverable": {
      const target = p || (typeof args?.title === "string" ? args.title : "");
      return target ? `Generating deliverable "${target}"` : `Generating deliverable`;
    }
    default:
      return `Executing ${toolName}`;
  }
}

export class ToolDispatcher {
  private readonly toolMap = new Map<string, AgentTool>();

  constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      this.toolMap.set(tool.name, tool);
    }
  }

  getTool(name: string): AgentTool | undefined {
    return this.toolMap.get(name);
  }

  getDefinitions() {
    return Array.from(this.toolMap.values()).map((t) => t.definition);
  }

  /**
   * Execute multiple tool calls emitted in a single model turn.
   * Tool calls from the same turn are independent and are executed concurrently
   * via Promise.all() to maximize throughput across distributed LAN endpoints.
   */
  async dispatchConcurrent(
    toolCalls: AgentToolCall[],
    context: ToolExecutionContext,
  ): Promise<ExecutedToolOutput[]> {
    return Promise.all(
      toolCalls.map(async (call) => {
        const tool = this.toolMap.get(call.name);
        if (!tool) {
          const notFoundResult: ToolExecutionResult = {
            output: `Error: Tool "${call.name}" is not available in the active environment.`,
            summary: `Tool "${call.name}" not found`,
          };
          return {
            id: call.id,
            name: call.name,
            args: call.arguments,
            result: notFoundResult,
          };
        }

        // Notify UI about tool execution
        const callSummary = formatToolCallSummary(call.name, call.arguments);
        if (context.emitRunEvent) {
          context.emitRunEvent({
            type: "tool_call",
            runId: context.runId,
            tool: call.name,
            summary: callSummary,
            callId: call.id,
            args: call.arguments,
          });
        }

        const t0 = Date.now();
        try {
          const result = await tool.execute(call.arguments, context);
          const durationMs = Date.now() - t0;

          // Notify UI about tool completion
          if (context.emitRunEvent) {
            context.emitRunEvent({
              type: "tool_result",
              runId: context.runId,
              tool: call.name,
              summary: result.summary,
              callId: call.id,
              output: typeof result.output === "string" ? result.output.slice(0, 4000) : JSON.stringify(result.output ?? "").slice(0, 4000),
              durationMs,
            });
            if (result.artifacts && result.artifacts.length > 0) {
              for (const artifact of result.artifacts) {
                context.emitRunEvent({
                  type: "artifact_ready",
                  runId: context.runId,
                  artifact,
                });
              }
            }
          }

          return {
            id: call.id,
            name: call.name,
            args: call.arguments,
            result,
          };
        } catch (err: any) {
          const durationMs = Date.now() - t0;
          const errorResult: ToolExecutionResult = {
            output: `Error executing tool "${call.name}": ${err?.message ?? String(err)}`,
            summary: `Error in ${call.name}: ${err?.message ?? String(err)}`,
          };

          if (context.emitRunEvent) {
            context.emitRunEvent({
              type: "tool_result",
              runId: context.runId,
              tool: call.name,
              summary: errorResult.summary,
              callId: call.id,
              output: errorResult.output,
              durationMs,
            });
          }

          return {
            id: call.id,
            name: call.name,
            args: call.arguments,
            result: errorResult,
          };
        }
      }),
    );
  }
}
