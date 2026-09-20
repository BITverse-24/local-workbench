import type { AgentToolCall } from "../../shared/contracts.js";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "../tools/types.js";

export interface ExecutedToolOutput {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: ToolExecutionResult;
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
        if (context.emitRunEvent) {
          context.emitRunEvent({
            type: "tool_call",
            runId: context.runId,
            tool: call.name,
            summary: `Executing ${call.name}`,
          });
        }

        try {
          const result = await tool.execute(call.arguments, context);

          // Notify UI about tool completion
          if (context.emitRunEvent) {
            context.emitRunEvent({
              type: "tool_result",
              runId: context.runId,
              tool: call.name,
              summary: result.summary,
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
