import type { AgentToolCall } from "../../shared/contracts.js";
import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolErrorCode,
  ToolErrorDetail,
  ToolResult,
} from "../tools/types.js";

export { ToolErrorCode, ToolErrorDetail, ToolResult };

export interface ExecutedToolOutput {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: ToolResult;
}

function tryParseJson(text: string): unknown {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}

export function classifyToolError(err: unknown, toolName?: string): ToolErrorDetail {
  if (!err) {
    return {
      code: "internal_error",
      message: "Unknown error occurred",
      retryable: false,
    };
  }

  // If already structured ToolErrorDetail
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    "retryable" in err
  ) {
    const candidate = err as ToolErrorDetail;
    const validCodes: ToolErrorCode[] = [
      "invalid_arguments",
      "permission_denied",
      "file_not_found",
      "timeout",
      "sandbox_failure",
      "gateway_failure",
      "validation_failure",
      "tool_not_found",
      "internal_error",
    ];
    if (validCodes.includes(candidate.code)) {
      return candidate;
    }
  }

  const errObj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
  const name = typeof errObj.name === "string" ? errObj.name : "";
  const code = typeof errObj.code === "string" ? errObj.code : "";
  const message = typeof errObj.message === "string" ? errObj.message : String(err);

  // 1. Permission / Access denied (path-guard, filesystem permission, sandbox security)
  if (
    name === "PermissionError" ||
    code === "EACCES" ||
    code === "EPERM" ||
    /permission denied|outside workspace|access denied|null byte in path|absolute path rejected|not permitted|forbidden/i.test(
      message,
    )
  ) {
    return {
      code: "permission_denied",
      message,
      retryable: false,
      details: { name, code },
    };
  }

  // 2. File not found
  if (
    code === "ENOENT" ||
    /not found|no such file or directory|does not exist|cannot find file|file missing/i.test(message)
  ) {
    return {
      code: "file_not_found",
      message,
      retryable: true,
      details: { name, code },
    };
  }

  // 3. Invalid arguments
  if (
    name === "InvalidArgumentError" ||
    code === "INVALID_ARGUMENTS" ||
    /parameter is required|requires a filename|missing required argument|missing argument|requires a|invalid argument|expected format|argument .* is required/i.test(
      message,
    )
  ) {
    return {
      code: "invalid_arguments",
      message,
      retryable: true,
      details: { name, code },
    };
  }

  // 4. Timeout
  if (code === "ETIMEDOUT" || /timed out|timeout|deadline exceeded/i.test(message)) {
    return {
      code: "timeout",
      message,
      retryable: true,
      details: { name, code },
    };
  }

  // 5. Validation failure
  if (
    name === "ZodError" ||
    name === "ValidationError" ||
    /validation failed|schema mismatch|contract violation|zod/i.test(message)
  ) {
    return {
      code: "validation_failure",
      message,
      retryable: true,
      details: { name, code },
    };
  }

  // 6. Sandbox failure
  if (name === "SandboxError" || /sandbox|bwrap|bubblewrap|exited with code/i.test(message)) {
    return {
      code: "sandbox_failure",
      message,
      retryable: true,
      details: { name, code },
    };
  }

  // 7. Model Gateway failure
  if (
    name === "GatewayError" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    /gateway|connection refused|fetch failed|failed to fetch|model .* unavailable|llama-server|ollama/i.test(
      message,
    )
  ) {
    return {
      code: "gateway_failure",
      message,
      retryable: true,
      details: { name, code },
    };
  }

  // 8. Tool not found
  if (code === "tool_not_found" || /is not available in the active environment|tool .* not found/i.test(message)) {
    return {
      code: "tool_not_found",
      message,
      retryable: false,
      details: { name, code },
    };
  }

  // 9. Internal error fallback
  return {
    code: "internal_error",
    message,
    retryable: false,
    details: { name, code },
  };
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
        const t0 = Date.now();

        if (!tool) {
          const durationMs = 0;
          const notFoundError: ToolErrorDetail = {
            code: "tool_not_found",
            message: `Tool "${call.name}" is not available in the active environment.`,
            retryable: false,
          };
          const notFoundResult: ToolResult = {
            ok: false,
            toolName: call.name,
            error: notFoundError,
            output: `Error: Tool "${call.name}" is not available in the active environment.`,
            summary: `Tool "${call.name}" not found`,
            durationMs,
          };

          if (context.emitRunEvent) {
            context.emitRunEvent({
              type: "tool_result",
              runId: context.runId,
              tool: call.name,
              summary: notFoundResult.summary,
              callId: call.id,
              output: notFoundResult.output,
              durationMs,
              ok: false,
              error: notFoundError,
            });
          }

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

        try {
          const rawResult = await tool.execute(call.arguments, context);
          const durationMs = Date.now() - t0;

          const rawOutput = typeof rawResult.output === "string" ? rawResult.output : "";
          const rawSummary = typeof rawResult.summary === "string" ? rawResult.summary : callSummary;

          let normalizedResult: ToolResult;
          if (rawResult.ok === false) {
            const errorDetail: ToolErrorDetail =
              rawResult.error ?? classifyToolError(rawOutput || rawSummary, call.name);
            normalizedResult = {
              ok: false,
              toolName: call.name,
              error: errorDetail,
              output: rawOutput,
              summary: rawSummary,
              artifacts: rawResult.artifacts,
              durationMs,
            };
          } else if (
            rawResult.ok === undefined &&
            call.name !== "read_file" &&
            call.name !== "extract_document" &&
            call.name !== "ocr_extract" &&
            (
              rawOutput.startsWith("Error") ||
              rawSummary.toLowerCase().startsWith("error") ||
              rawSummary.toLowerCase().startsWith("fail")
            )
          ) {
            const errorDetail: ToolErrorDetail = classifyToolError(rawOutput || rawSummary, call.name);
            normalizedResult = {
              ok: false,
              toolName: call.name,
              error: errorDetail,
              output: rawOutput,
              summary: rawSummary,
              artifacts: rawResult.artifacts,
              durationMs,
            };
          } else if (call.name === "execute_python" && rawOutput) {
            let pythonError: ToolErrorDetail | null = null;
            try {
              const parsed = JSON.parse(rawOutput);
              if (parsed.timedOut) {
                pythonError = {
                  code: "timeout",
                  message: "Python script execution timed out",
                  retryable: true,
                  details: parsed,
                };
              } else if (typeof parsed.exitCode === "number" && parsed.exitCode !== 0) {
                pythonError = {
                  code: "sandbox_failure",
                  message: parsed.stderr || `Python script exited with code ${parsed.exitCode}`,
                  retryable: true,
                  details: parsed,
                };
              }
            } catch {}

            if (pythonError) {
              normalizedResult = {
                ok: false,
                toolName: call.name,
                error: pythonError,
                output: rawOutput,
                summary: rawSummary,
                artifacts: rawResult.artifacts,
                durationMs,
              };
            } else {
              normalizedResult = {
                ok: true,
                toolName: call.name,
                data: rawResult.data ?? tryParseJson(rawOutput),
                output: rawOutput,
                summary: rawSummary,
                artifacts: rawResult.artifacts,
                durationMs,
              };
            }
          } else if (call.name === "run_command" && rawOutput) {
            let commandError: ToolErrorDetail | null = null;
            try {
              const parsed = JSON.parse(rawOutput);
              if (parsed.timedOut) {
                commandError = {
                  code: "timeout",
                  message: "Command execution timed out",
                  retryable: true,
                  details: parsed,
                };
              } else if (typeof parsed.exitCode === "number" && parsed.exitCode !== 0) {
                commandError = {
                  code: "sandbox_failure",
                  message: parsed.stderr || `Command exited with code ${parsed.exitCode}`,
                  retryable: true,
                  details: parsed,
                };
              }
            } catch {}

            if (commandError) {
              normalizedResult = {
                ok: false,
                toolName: call.name,
                error: commandError,
                output: rawOutput,
                summary: rawSummary,
                artifacts: rawResult.artifacts,
                durationMs,
              };
            } else {
              normalizedResult = {
                ok: true,
                toolName: call.name,
                data: rawResult.data ?? tryParseJson(rawOutput),
                output: rawOutput,
                summary: rawSummary,
                artifacts: rawResult.artifacts,
                durationMs,
              };
            }
          } else {
            normalizedResult = {
              ok: true,
              toolName: call.name,
              data: rawResult.data ?? tryParseJson(rawOutput),
              output: rawOutput,
              summary: rawSummary,
              artifacts: rawResult.artifacts,
              durationMs,
            };
          }

          // Notify UI about tool completion
          if (context.emitRunEvent) {
            context.emitRunEvent({
              type: "tool_result",
              runId: context.runId,
              tool: call.name,
              summary: normalizedResult.summary,
              callId: call.id,
              output:
                typeof normalizedResult.output === "string"
                  ? normalizedResult.output.slice(0, 4000)
                  : JSON.stringify(normalizedResult.output ?? "").slice(0, 4000),
              durationMs,
              ok: normalizedResult.ok,
              error: normalizedResult.ok ? undefined : normalizedResult.error,
            });
            if (normalizedResult.artifacts && normalizedResult.artifacts.length > 0) {
              for (const artifact of normalizedResult.artifacts) {
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
            result: normalizedResult,
          };
        } catch (err: any) {
          const durationMs = Date.now() - t0;
          const errorDetail = classifyToolError(err, call.name);
          const errorOutput = `Error executing tool "${call.name}": ${errorDetail.message}`;
          const errorSummary = `Error in ${call.name}: ${errorDetail.message}`;

          const failureResult: ToolResult = {
            ok: false,
            toolName: call.name,
            error: errorDetail,
            output: errorOutput,
            summary: errorSummary,
            durationMs,
          };

          if (context.emitRunEvent) {
            context.emitRunEvent({
              type: "tool_result",
              runId: context.runId,
              tool: call.name,
              summary: errorSummary,
              callId: call.id,
              output: errorOutput,
              durationMs,
              ok: false,
              error: errorDetail,
            });
          }

          return {
            id: call.id,
            name: call.name,
            args: call.arguments,
            result: failureResult,
          };
        }
      }),
    );
  }
}
