import { describe, expect, it } from "vitest";
import { ToolDispatcher, formatToolCallSummary } from "../src/main/agent/tool-dispatcher.js";
import type { AgentTool, ToolExecutionContext } from "../src/main/tools/types.js";
import type { RunEvent } from "../src/shared/contracts.js";

describe("Agent Execution Timeline & Event Enrichment Suite", () => {
  it("formats human-readable tool call summaries correctly", () => {
    expect(formatToolCallSummary("read_file", { path: "src/main.ts" })).toBe('Reading "src/main.ts"');
    expect(formatToolCallSummary("write_file", { path: "src/App.tsx", content: "..." })).toBe('Writing "src/App.tsx"');
    expect(formatToolCallSummary("delete_file", { path: "temp.log" })).toBe('Deleting "temp.log"');
    expect(formatToolCallSummary("search", { query: "useVoice" })).toBe('Searching for "useVoice"');
    expect(formatToolCallSummary("list_dir", { path: "src" })).toBe('Listing directory "src"');
    expect(formatToolCallSummary("run_command", { command: "npm test" })).toBe("Running: npm test");
    expect(formatToolCallSummary("execute_python", {})).toBe("Executing Python script in sandbox");
    expect(formatToolCallSummary("retrieve_sop", { query: "pressure vessel" })).toBe('Querying knowledge base for "pressure vessel"');
    expect(formatToolCallSummary("extract_document", { path: "report.pdf" })).toBe('Extracting document "report.pdf"');
  });

  it("emits enriched tool_call and tool_result events through ToolDispatcher", async () => {
    const emittedEvents: RunEvent[] = [];

    const mockTool: AgentTool = {
      name: "read_file",
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      async execute(args) {
        return {
          output: "file contents sample line 1\nline 2",
          summary: `Read "${args.path}" (32 chars)`,
        };
      },
    };

    const dispatcher = new ToolDispatcher([mockTool]);

    const mockContext: ToolExecutionContext = {
      runId: "run-test-123",
      workspaceRoot: process.cwd(),
      gateway: {} as any,
      emitRunEvent: (event: RunEvent) => emittedEvents.push(event),
    };

    const toolCalls = [
      {
        id: "call_abc123",
        name: "read_file",
        arguments: { path: "src/index.ts" },
      },
    ];

    const results = await dispatcher.dispatchConcurrent(toolCalls, mockContext);

    expect(results).toHaveLength(1);
    expect(results[0]?.result.summary).toBe('Read "src/index.ts" (32 chars)');

    // Verify tool_call event
    const callEvent = emittedEvents.find((e) => e.type === "tool_call") as any;
    expect(callEvent).toBeDefined();
    expect(callEvent.tool).toBe("read_file");
    expect(callEvent.summary).toBe('Reading "src/index.ts"');
    expect(callEvent.callId).toBe("call_abc123");
    expect(callEvent.args).toEqual({ path: "src/index.ts" });

    // Verify tool_result event
    const resultEvent = emittedEvents.find((e) => e.type === "tool_result") as any;
    expect(resultEvent).toBeDefined();
    expect(resultEvent.tool).toBe("read_file");
    expect(resultEvent.summary).toBe('Read "src/index.ts" (32 chars)');
    expect(resultEvent.callId).toBe("call_abc123");
    expect(resultEvent.output).toContain("file contents sample line 1");
    expect(typeof resultEvent.durationMs).toBe("number");
  });
});
