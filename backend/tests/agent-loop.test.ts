import { describe, expect, it } from "vitest";
import { compactConversationHistory, compactToolResult, type AgentMessage } from "../src/main/agent/context-manager.js";
import { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";
import { AgentLoop, extractInChatFindings, deriveFormalPlan, isSubstantiveReportOrFindings } from "../src/main/agent/agent-loop.js";
import type { AgentTool } from "../src/main/tools/types.js";

describe("Agent Loop Engine & Context Manager", () => {
  it("compacts tool outputs older than keepFullTurns (sliding window)", () => {
    const longOutput = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

    const messages: AgentMessage[] = [
      { role: "system", content: "system instructions" },
      { role: "user", content: "user goal" },
      { role: "assistant", content: "thinking 1", turn: 1 },
      { role: "tool", toolName: "read_file", content: longOutput, turn: 1 },
      { role: "assistant", content: "thinking 2", turn: 2 },
      { role: "tool", toolName: "read_file", content: longOutput, turn: 2 },
      { role: "assistant", content: "thinking 3", turn: 3 },
      { role: "tool", toolName: "read_file", content: longOutput, turn: 3 },
    ];

    // At turn 3 with keepFullTurns=1, turn 1 and turn 2 are older than cutoff (3-1 = 2)
    const compacted = compactConversationHistory(messages, 3, 1);

    // Turn 1 tool result should be compacted
    expect(compacted[3].content).toContain("compacted");
    // Turn 3 tool result should remain in full
    expect(compacted[7].content).toBe(longOutput);
  });

  it("dispatches independent tool calls concurrently", async () => {
    let order: string[] = [];

    const toolA: AgentTool = {
      name: "tool_a",
      definition: { type: "function", function: { name: "tool_a", description: "a", parameters: { type: "object", properties: {} } } },
      async execute() {
        await new Promise((r) => setTimeout(r, 20));
        order.push("a");
        return { output: "result_a", summary: "done a" };
      },
    };

    const toolB: AgentTool = {
      name: "tool_b",
      definition: { type: "function", function: { name: "tool_b", description: "b", parameters: { type: "object", properties: {} } } },
      async execute() {
        await new Promise((r) => setTimeout(r, 10));
        order.push("b");
        return { output: "result_b", summary: "done b" };
      },
    };

    const dispatcher = new ToolDispatcher([toolA, toolB]);
    const results = await dispatcher.dispatchConcurrent(
      [
        { id: "1", name: "tool_a", arguments: {} },
        { id: "2", name: "tool_b", arguments: {} },
      ],
      { runId: "test", workspaceRoot: ".", gateway: {} as any },
    );

    expect(results).toHaveLength(2);
    // Tool B (10ms) should finish before Tool A (20ms) because of concurrency!
    expect(order).toEqual(["b", "a"]);
    expect(results[0].result.output).toBe("result_a");
    expect(results[1].result.output).toBe("result_b");
  });

  it("terminates pure chat on turn 1 without triggering confirmation", async () => {
    const loop = new AgentLoop();
    let confirmationTriggered = false;

    const mockGateway = {
      async chatWithTools() {
        return {
          ok: true,
          value: {
            content: "A heat exchanger transfers heat safely.",
            tool_calls: null,
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test",
      driverModelId: "draft-qwen3",
      userPrompt: "What is a heat exchanger?",
      systemPrompt: "You are helpful.",
      tools: [],
      context: { runId: "test", workspaceRoot: ".", gateway: mockGateway as any },
      onPlanConfirmationRequired: async () => {
        confirmationTriggered = true;
        return true;
      },
      emitEvent: () => {},
    });

    expect(result.completed).toBe(true);
    expect(result.turns).toBe(1);
    expect(result.finalText).toBe("A heat exchanger transfers heat safely.");
    expect(confirmationTriggered).toBe(false);
  });

  it("intercepts markdown code blocks as write_file tool calls when model outputs files as chat", async () => {
    const loop = new AgentLoop();
    let writtenFiles: Array<{ path: string; content: string }> = [];
    let callTurn = 0;

    const mockWriteFileTool: AgentTool = {
      name: "write_file",
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "Write file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
          },
        },
      },
      async execute(args) {
        writtenFiles.push({ path: String(args.path), content: String(args.content) });
        return { output: `Saved ${args.path}`, summary: `Saved ${args.path}` };
      },
    };

    const mockGateway = {
      async chatWithTools() {
        callTurn++;
        if (callTurn === 1) {
          // Model lazily returns text with code blocks without calling write_file
          return {
            ok: true,
            value: {
              content: `Sure, I will set up the Express app.
Create a file named app.js:
\`\`\`javascript
// app.js
const express = require('express');
const app = express();
module.exports = app;
\`\`\`
`,
              tool_calls: null,
            },
          };
        }
        return {
          ok: true,
          value: {
            content: "Express app has been set up successfully.",
            tool_calls: null,
          },
        };
      },
    };

    let planConfirmed = false;
    const result = await loop.run({
      runId: "test-lazy",
      driverModelId: "code-qwen25coder",
      userPrompt: "Setup an express app in the workspace",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockWriteFileTool],
      context: { runId: "test-lazy", workspaceRoot: ".", gateway: mockGateway as any },
      onPlanConfirmationRequired: async () => {
        planConfirmed = true;
        return true;
      },
      emitEvent: () => {},
    });

    expect(planConfirmed).toBe(true);
    expect(writtenFiles).toHaveLength(1);
    expect(writtenFiles[0].path).toBe("app.js");
    expect(writtenFiles[0].content).toContain("const express = require('express');");
    expect(result.completed).toBe(true);
    expect(result.finalText).toBe("Express app has been set up successfully.");
  });

  it("nudges model when it answers conversational text without tools for a file creation request", async () => {
    const loop = new AgentLoop();
    let callTurn = 0;
    let receivedMessagesOnTurn2: any[] = [];

    const mockWriteFileTool: AgentTool = {
      name: "write_file",
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "Write file",
          parameters: { type: "object", properties: {} },
        },
      },
      async execute(args) {
        return { output: `Saved ${args.path}`, summary: "Saved" };
      },
    };

    const mockGateway = {
      async chatWithTools(_modelId: any, messages: any[]) {
        callTurn++;
        if (callTurn === 1) {
          // Model returns purely conversational text with no code blocks or tools
          return {
            ok: true,
            value: {
              content: "To set up an express app, you should run npm init and create an app.js file with express routing.",
              tool_calls: null,
            },
          };
        }
        receivedMessagesOnTurn2 = messages;
        // On turn 2, model calls write_file
        return {
          ok: true,
          value: {
            content: "Created app.js.",
            tool_calls: null,
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-nudge",
      driverModelId: "code-qwen25coder",
      userPrompt: "Setup an express app in the workspace",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockWriteFileTool],
      context: { runId: "test-nudge", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: () => {},
    });

    expect(callTurn).toBe(2);
    // Turn 2 messages should include the system nudge feedback
    const nudgeMsg = receivedMessagesOnTurn2.find((m) => typeof m.content === "string" && m.content.includes("[SYSTEM FEEDBACK]"));
    expect(nudgeMsg).toBeDefined();
    expect(result.completed).toBe(true);
  });

  it("does not nudge or reset chat when user asks for a code snippet without workspace file targets", async () => {
    const loop = new AgentLoop();
    let callTurn = 0;
    const emittedEvents: any[] = [];

    const mockWriteFileTool: AgentTool = {
      name: "write_file",
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "write",
          parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
        },
      },
      async execute(args) {
        return { output: `Saved ${args.path}`, summary: "Saved" };
      },
    };

    const snippetText = `Here is a FastAPI snippet that logs incoming IP addresses:
\`\`\`python
from fastapi import FastAPI, Request
app = FastAPI()
@app.middleware("http")
async def log_ip(request: Request, call_next):
    print(f"IP: {request.client.host}")
    return await call_next(request)
\`\`\``;

    const mockGateway = {
      async chatWithTools() {
        callTurn++;
        return {
          ok: true,
          value: {
            content: snippetText,
            tool_calls: null,
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-snippet",
      driverModelId: "code-qwen25coder",
      userPrompt: "Write a fastapi snippet which logs all incoming requests' IP address",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockWriteFileTool],
      context: { runId: "test-snippet", workspaceRoot: "", gateway: mockGateway as any },
      emitEvent: (e) => emittedEvents.push(e),
    });

    expect(callTurn).toBe(1);
    expect(result.completed).toBe(true);
    expect(result.finalText).toContain("from fastapi import FastAPI");
    // Verify assistant_message_reset was NOT emitted
    const resetEvent = emittedEvents.find((e) => e.type === "assistant_message_reset");
    expect(resetEvent).toBeUndefined();
    // Verify agent_thinking was emitted for telemetry
    const thinkingEvent = emittedEvents.find((e) => e.type === "agent_thinking");
    expect(thinkingEvent).toBeDefined();
  });

  it("detects and terminates tool call loops when identical tool calls repeat", async () => {
    const loop = new AgentLoop();
    let callCount = 0;

    const mockWriteFileTool: AgentTool = {
      name: "write_file",
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "write",
          parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
        },
      },
      async execute(args) {
        return { output: `Saved ${args.path}`, summary: "Saved" };
      },
    };

    const mockGateway = {
      async chatWithTools() {
        callCount++;
        // Model keeps repeating the exact same tool call
        return {
          ok: true,
          value: {
            content: "Writing file app.js",
            tool_calls: [
              {
                id: `call_${callCount}`,
                name: "write_file",
                arguments: { path: "app.js", content: "const x = 1;" },
              },
            ],
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-loop",
      driverModelId: "code-qwen25coder",
      userPrompt: "Write app.js",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockWriteFileTool],
      context: { runId: "test-loop", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: () => {},
    });

    // Should stop on turn 2 because turn 2 repeated turn 1's call signature
    expect(callCount).toBe(2);
    expect(result.completed).toBe(true);
  });

  it("detects and terminates 2-cycle alternating tool call loops (A -> B -> A -> B)", async () => {
    const loop = new AgentLoop();
    let callCount = 0;

    const mockToolA: AgentTool = {
      name: "generate_deliverable",
      definition: { type: "function", function: { name: "generate_deliverable", description: "gen", parameters: { type: "object", properties: {} } } },
      async execute() {
        return { output: "deliverable created", summary: "done" };
      },
    };

    const mockToolB: AgentTool = {
      name: "read_file",
      definition: { type: "function", function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
      async execute() {
        return { output: "deliverable content", summary: "read" };
      },
    };

    const mockGateway = {
      async chatWithTools() {
        callCount++;
        // Alternating pattern: Turn 1: tool A, Turn 2: tool B, Turn 3: tool A, Turn 4: tool B
        const isToolA = callCount % 2 === 1;
        return {
          ok: true,
          value: {
            content: isToolA ? "Generating doc" : "Reading doc",
            tool_calls: [
              {
                id: `call_${callCount}`,
                name: isToolA ? "generate_deliverable" : "read_file",
                arguments: isToolA ? { filename: "approval-note.docx" } : { path: "approval-note.docx" },
              },
            ],
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-alternating-loop",
      driverModelId: "draft-qwen3",
      userPrompt: "Draft approval note",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockToolA, mockToolB],
      context: { runId: "test-alternating-loop", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: () => {},
    });

    // Should stop at turn 4 because [A, B, A, B] was detected!
    expect(callCount).toBe(4);
    expect(result.completed).toBe(true);
  });

  it("aborts execution immediately when isCancelled returns true", async () => {
    const loop = new AgentLoop();
    let callCount = 0;

    const mockTool: AgentTool = {
      name: "write_file",
      definition: {
        type: "function",
        function: { name: "write_file", description: "w", parameters: { type: "object", properties: {} } },
      },
      async execute() {
        return { output: "ok", summary: "ok" };
      },
    };

    let cancelled = false;
    const mockGateway = {
      async chatWithTools() {
        callCount++;
        // Trigger cancellation after first model invocation
        cancelled = true;
        return {
          ok: true,
          value: {
            content: "Step 1 done",
            tool_calls: [{ id: "c1", name: "write_file", arguments: { path: "a.js", content: "1" } }],
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-cancel",
      driverModelId: "code-qwen25coder",
      userPrompt: "Do something long",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockTool],
      context: { runId: "test-cancel", workspaceRoot: ".", gateway: mockGateway as any },
      isCancelled: () => cancelled,
      emitEvent: () => {},
    });

    expect(callCount).toBe(1);
    expect(result.completed).toBe(false);
    expect(result.finalText).toContain("cancelled");
  });

  it("streams free-text responses via assistant_message_chunk on pure chat turns and returns messageId", async () => {
    const loop = new AgentLoop();
    const emittedEvents: any[] = [];

    const mockGateway = {
      async chatWithTools(_model: string, _msgs: any[], _tools: any[], options?: any) {
        if (options?.onChunk) {
          options.onChunk("Thinking ");
          options.onChunk("and explaining.");
        }
        return {
          ok: true,
          value: {
            content: "Thinking and explaining.",
            tool_calls: null,
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-stream-pure",
      driverModelId: "draft-qwen3",
      userPrompt: "Explain how heat exchangers work",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [],
      semanticIntent: {
        driverModel: "draft-qwen3",
        taskType: "draft",
        primaryGoal: "Explanation",
        isActionable: false,
        targetFiles: [],
        intentType: "general_qa",
        reason: "General question",
      },
      context: { runId: "test-stream-pure", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: (e) => emittedEvents.push(e),
    });

    expect(result.completed).toBe(true);
    expect(result.messageId).toBeDefined();

    const chunks = emittedEvents.filter((e) => e.type === "assistant_message_chunk");
    expect(chunks.length).toBe(2);
    expect(chunks[0].delta).toBe("Thinking ");
    expect(chunks[1].delta).toBe("and explaining.");
    expect(chunks[0].messageId).toBe(result.messageId);
  });

  it("streams post-tool summary turn via assistant_message_chunk", async () => {
    const loop = new AgentLoop();
    const emittedEvents: any[] = [];
    let turnCount = 0;

    const mockTool: AgentTool = {
      name: "write_file",
      definition: {
        type: "function",
        function: { name: "write_file", description: "write", parameters: { type: "object", properties: {} } },
      },
      async execute() {
        return { output: "created", summary: "file written" };
      },
    };

    const mockGateway = {
      async chatWithTools(_model: string, _msgs: any[], _tools: any[], options?: any) {
        turnCount++;
        if (turnCount === 1) {
          // Turn 1: tool call (no streaming chunks)
          return {
            ok: true,
            value: {
              content: null,
              tool_calls: [{ id: "c1", name: "write_file", arguments: { path: "a.js", content: "1" } }],
            },
          };
        } else {
          // Turn 2: summary turn (should stream!)
          expect(options?.onChunk).toBeDefined();
          if (options?.onChunk) {
            options.onChunk("File ");
            options.onChunk("created successfully.");
          }
          return {
            ok: true,
            value: {
              content: "File created successfully.",
              tool_calls: null,
            },
          };
        }
      },
    };

    const result = await loop.run({
      runId: "test-stream-summary",
      driverModelId: "code-qwen25coder",
      userPrompt: "Create a.js",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockTool],
      semanticIntent: {
        driverModel: "code-qwen25coder",
        taskType: "code",
        primaryGoal: "Create a.js",
        isActionable: true,
        targetFiles: ["a.js"],
        intentType: "code_modification",
        reason: "file creation",
      },
      context: { runId: "test-stream-summary", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: (e) => emittedEvents.push(e),
    });

    expect(result.completed).toBe(true);
    expect(result.turns).toBe(2);

    const chunks = emittedEvents.filter((e) => e.type === "assistant_message_chunk");
    expect(chunks.length).toBe(2);
    expect(chunks.map((c) => c.delta).join("")).toBe("File created successfully.");
    expect(chunks[0].messageId).toBe(result.messageId);
  });

  it("does not treat read-only search as a disk mutation, maintains full token budget on turn 2, and intercepts code blocks", async () => {
    const loop = new AgentLoop();
    let turnCount = 0;
    const writtenFiles: { path: string; content: string }[] = [];
    const maxTokensPerTurn: (number | undefined)[] = [];

    const mockSearchTool: AgentTool = {
      name: "search",
      definition: {
        type: "function",
        function: { name: "search", description: "Search workspace", parameters: { type: "object", properties: { query: { type: "string" } } } },
      },
      async execute(args) {
        return { output: JSON.stringify(["app.js"]), summary: "Found app.js" };
      },
    };

    const mockWriteFileTool: AgentTool = {
      name: "write_file",
      definition: {
        type: "function",
        function: { name: "write_file", description: "Write file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
      },
      async execute(args) {
        writtenFiles.push({ path: args.path as string, content: args.content as string });
        return { output: `Saved ${args.path}`, summary: `Saved ${args.path}` };
      },
    };

    const mockGateway = {
      async chatWithTools(_model: string, _msgs: any[], _tools: any[], options?: any) {
        turnCount++;
        maxTokensPerTurn.push(options?.maxTokens);

        if (turnCount === 1) {
          // Turn 1: Model calls search (read-only inspection)
          return {
            ok: true,
            value: {
              content: "I will search for JavaScript files in the workspace.",
              tool_calls: [{ id: "call_search_1", name: "search", arguments: { query: "app.js" } }],
            },
          };
        } else if (turnCount === 2) {
          // Turn 2: Model outputs code block for converted TypeScript file
          return {
            ok: true,
            value: {
              content: "Here is the converted TypeScript code:\n```typescript\n// app.ts\nimport express from 'express';\nconst app = express();\nexport default app;\n```\n",
              tool_calls: null,
            },
          };
        } else {
          // Turn 3: Final summary
          return {
            ok: true,
            value: {
              content: "Successfully converted app.js to app.ts.",
              tool_calls: null,
            },
          };
        }
      },
    };

    const result = await loop.run({
      runId: "test-search-no-mutation",
      driverModelId: "code-qwen25coder",
      userPrompt: "Convert codebase to TypeScript",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockSearchTool, mockWriteFileTool],
      semanticIntent: {
        driverModel: "code-qwen25coder",
        taskType: "code",
        primaryGoal: "Convert codebase to TypeScript",
        isActionable: true,
        targetFiles: ["app.ts"],
        intentType: "code_modification",
        reason: "TypeScript conversion",
      },
      context: { runId: "test-search-no-mutation", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: () => {},
    });

    expect(result.completed).toBe(true);
    // Turn 1: undefined maxTokens (full budget)
    expect(maxTokensPerTurn[0]).toBeUndefined();
    // Turn 2: should NOT be capped to 350 because search is read-only!
    expect(maxTokensPerTurn[1]).toBeUndefined();
    // Turn 3: capped to 4096 because write_file mutated disk on turn 2
    expect(maxTokensPerTurn[2]).toBe(4096);
    // Code block was intercepted as write_file tool call and written to disk
    expect(writtenFiles.length).toBe(1);
    expect(writtenFiles[0].path).toBe("app.ts");
    expect(writtenFiles[0].content).toContain("import express from 'express';");
  });

  it("terminates and reports error when tool calls repeatedly fail in an error loop", async () => {
    const loop = new AgentLoop();
    let callCount = 0;
    const emittedEvents: any[] = [];

    const mockFailingTool: AgentTool = {
      name: "write_file",
      definition: {
        type: "function",
        function: { name: "write_file", description: "write", parameters: { type: "object", properties: {} } },
      },
      async execute() {
        return { output: "Error in write_file: path parameter is required", summary: "Failed" };
      },
    };

    const mockGateway = {
      async chatWithTools() {
        callCount++;
        return {
          ok: true,
          value: {
            content: "I apologize for the repeated errors. Let's manually correct the file content and write it using write_file.",
            tool_calls: [{ id: `call_${callCount}`, name: "write_file", arguments: {} }],
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-failing-loop",
      driverModelId: "code-qwen25coder",
      userPrompt: "Convert codebase to TypeScript",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockFailingTool],
      context: { runId: "test-failing-loop", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: (e) => emittedEvents.push(e),
    });

    expect(callCount).toBe(2);
    expect(result.completed).toBe(false);
    expect(result.finalText).toContain("Execution stopped: The model repeatedly encountered errors invoking `write_file`");
    const errorEvent = emittedEvents.find((e) => e.type === "error" && e.code === "tool_loop_detected");
    expect(errorEvent).toBeDefined();
  });

  it("reports the specific failed tool in tool_loop_detected when multiple tools are invoked concurrently", async () => {
    const loop = new AgentLoop();
    let callCount = 0;
    const emittedEvents: any[] = [];

    const mockWriteSuccess: AgentTool = {
      name: "write_file",
      definition: {
        type: "function",
        function: { name: "write_file", description: "write", parameters: { type: "object", properties: {} } },
      },
      async execute() {
        return { output: JSON.stringify({ written: true }), summary: "Wrote file" };
      },
    };

    const mockPythonFail: AgentTool = {
      name: "execute_python",
      definition: {
        type: "function",
        function: { name: "execute_python", description: "exec", parameters: { type: "object", properties: {} } },
      },
      async execute() {
        return { output: JSON.stringify({ exitCode: 1, stderr: "SyntaxError: unexpected token" }), summary: "Exit 1" };
      },
    };

    const mockGateway = {
      async chatWithTools() {
        callCount++;
        return {
          ok: true,
          value: {
            content: "Fixing script.",
            tool_calls: [
              { id: `c1_${callCount}`, name: "write_file", arguments: { path: "script.py", content: "x = 1" } },
              { id: `c2_${callCount}`, name: "execute_python", arguments: { code: "import script" } },
            ],
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-multi-tool-loop",
      driverModelId: "code-qwen25coder",
      userPrompt: "Fix python script",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockWriteSuccess, mockPythonFail],
      context: { runId: "test-multi-tool-loop", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: (e) => emittedEvents.push(e),
    });

    expect(callCount).toBe(2);
    expect(result.completed).toBe(false);
    expect(result.finalText).toContain("invoking `execute_python`");
    expect(result.finalText).toContain("SyntaxError: unexpected token");
  });

  it("suppresses assistant_message_chunk during intermediate tool-calling turns and emits only clean summary on final turn", async () => {
    const loop = new AgentLoop();
    const emittedEvents: any[] = [];
    let turnCount = 0;

    const mockTool: AgentTool = {
      name: "execute_python",
      definition: {
        type: "function",
        function: { name: "execute_python", description: "run", parameters: { type: "object", properties: {} } },
      },
      async execute() {
        if (turnCount === 1) {
          // Turn 1 fails with error exitCode
          return {
            output: JSON.stringify({ exitCode: 1, stderr: "IndexError: list index out of range", stdout: "" }),
            summary: "Exit code 1",
          };
        } else {
          // Turn 2 succeeds
          return {
            output: JSON.stringify({ exitCode: 0, stderr: "", stdout: "{'ok': 3, 'malformed': 1, 'high': 1}" }),
            summary: "Exit code 0",
          };
        }
      },
    };

    const mockGateway = {
      async chatWithTools(_model: string, _msgs: any[], _tools: any[], options?: any) {
        turnCount++;
        if (turnCount === 1) {
          return {
            ok: true,
            value: {
              content: "Let us run the script with execute_python.",
              tool_calls: [{ id: "c1", name: "execute_python", arguments: { code: "import sys..." } }],
            },
          };
        } else if (turnCount === 2) {
          // Turn 2: model attempts to stream code before calling execute_python again
          if (options?.onChunk) {
            options.onChunk("The script crashed on sys.argv[1]. Let's update it:\n```python\nimport sys\n```");
          }
          return {
            ok: true,
            value: {
              content: "The script crashed on sys.argv[1]. Let's update it:\n```python\nimport sys\n```\nNow let us execute it.",
              tool_calls: [{ id: "c2", name: "execute_python", arguments: { code: "import sys\nif len(sys.argv) > 1: ..." } }],
            },
          };
        } else {
          // Turn 3: final summary
          if (options?.onChunk) {
            options.onChunk("The script has been repaired and verified to handle missing arguments.");
          }
          return {
            ok: true,
            value: {
              content: "The script has been repaired and verified to handle missing arguments.",
              tool_calls: null,
            },
          };
        }
      },
    };

    const result = await loop.run({
      runId: "test-multiturn-chunk-suppression",
      driverModelId: "code-qwen25coder",
      userPrompt: "Fix the crashing script",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockTool],
      semanticIntent: {
        driverModel: "code-qwen25coder",
        taskType: "code",
        primaryGoal: "Fix script",
        isActionable: true,
        targetFiles: ["task.py"],
        intentType: "code_modification",
        reason: "bug fix",
      },
      context: { runId: "test-multiturn-chunk-suppression", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: (e) => emittedEvents.push(e),
    });

    expect(result.completed).toBe(true);
    expect(result.turns).toBe(3);

    // Chunks from Turn 2 (which called tools) MUST NOT be emitted as assistant_message_chunk!
    const chunks = emittedEvents.filter((e) => e.type === "assistant_message_chunk");
    expect(chunks.length).toBe(1);
    expect(chunks[0].delta).toBe("The script has been repaired and verified to handle missing arguments.");
    expect(chunks[0].messageId).toBe(result.messageId);

    // Intermediate scratchpad was emitted as agent_thinking instead of assistant_message_chunk
    const thinking = emittedEvents.filter((e) => e.type === "agent_thinking");
    expect(thinking.some((t) => t.turn === 2 && t.text.includes("The script crashed"))).toBe(true);
  });

  it("does not auto-manufacture deliverable via regex when model drafts note without tool call on turn 2, marking outcome as partial", async () => {
    const loop = new AgentLoop();
    let turnCount = 0;
    const generatedDeliverables: any[] = [];
    const emittedEvents: any[] = [];

    const mockReadTool: AgentTool = {
      name: "read_file",
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      execute: async () => ({
        output: "Inspection report: Heat Exchanger E-201 wall thickness 2.4mm (allowable min 3.0mm).",
        summary: "Read report",
      }),
    };

    const mockDeliverableTool: AgentTool = {
      name: "generate_deliverable",
      definition: {
        type: "function",
        function: {
          name: "generate_deliverable",
          description: "Generate deliverable",
          parameters: {
            type: "object",
            properties: {
              type: { type: "string" },
              title: { type: "string" },
              content: { type: "string" },
              filename: { type: "string" },
            },
          },
        },
      },
      execute: async (args) => {
        generatedDeliverables.push(args);
        return {
          output: `Generated deliverable "${args.filename}" (4500 bytes)`,
          summary: `Generated deliverable "${args.filename}"`,
          artifacts: [
            {
              artifactId: "art-1",
              runId: "test-auto-deliv",
              kind: "docx",
              filename: String(args.filename),
              relativePath: `runs/test-auto-deliv/output/${args.filename}`,
              sizeBytes: 4500,
              createdAt: new Date().toISOString(),
            },
          ],
        };
      },
    };

    const mockGateway = {
      chatWithTools: async (_model: string, _msgs: any[], _tools: any[], options?: any) => {
        turnCount++;
        if (turnCount === 1) {
          return {
            ok: true as const,
            value: {
              content: "Reading inspection report...",
              tool_calls: [
                {
                  id: "call_read_1",
                  name: "read_file",
                  arguments: { path: "report.pdf" },
                },
              ],
            },
          };
        } else {
          // Turn 2: Model outputs full structured approval note in content without invoking generate_deliverable!
          const noteText = `# Technical Inspection Approval Note\n\n**Subject:** Heat Exchanger E-201 Clearance\n\n| Equipment | Measured Value | Allowable Limit | Status |\n| E-201 | 2.4mm | 3.0mm | REJECT |\n\n## Action Items\n1. Re-inspect weld joints.\n2. Replace degraded bundle.`;
          // It streams chunks if onChunk provided
          if (options?.onChunk) {
            options.onChunk("Key findings: E-201 wall thinning detected.");
          }
          return {
            ok: true as const,
            value: {
              content: noteText,
              tool_calls: [],
            },
          };
        }
      },
    };

    const result = await loop.run({
      runId: "test-auto-deliv",
      driverModelId: "draft-qwen3",
      userPrompt: "Read these inspection reports, pull out key findings, and draft an approval note for the plant manager in a docx file",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockReadTool, mockDeliverableTool],
      semanticIntent: {
        driverModel: "draft-qwen3",
        taskType: "draft",
        primaryGoal: "Draft approval note",
        isActionable: true,
        targetFiles: [],
        intentType: "document_drafting",
        reason: "Document drafting",
      },
      context: { runId: "test-auto-deliv", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: (e) => emittedEvents.push(e),
    });

    // P0-05 / P0-02 Truthful completion: Model stopped without invoking generate_deliverable,
    // so no deliverable was manufactured via regex fallback, and outcome is partial!
    expect(result.completed).toBe(false);
    expect(result.outcome).toBe("partial");
    expect(generatedDeliverables.length).toBe(0);

    // No artifact ready event should have been emitted
    const artEvent = emittedEvents.find((e) => e.type === "artifact_ready");
    expect(artEvent).toBeUndefined();

    // Missing deliverable is recorded truthfully
    expect(result.deliverables?.missing).toContain("Word document / Approval note (.docx)");
    expect(result.finalText).toContain("Execution partially completed");
  });

  it("does not auto-generate deliverable when user only asked for an in-chat drawing compliance review", async () => {
    const loop = new AgentLoop();
    const generatedDeliverables: any[] = [];
    const emittedEvents: any[] = [];

    const mockDeliverableTool: AgentTool = {
      name: "generate_deliverable",
      definition: {
        type: "function",
        function: {
          name: "generate_deliverable",
          description: "Generate deliverable",
          parameters: { type: "object", properties: { filename: { type: "string" } } },
        },
      },
      execute: async (args) => {
        generatedDeliverables.push(args);
        return { output: "OK", summary: "OK" };
      },
    };

    const mockGateway = {
      chatWithTools: async () => {
        return {
          ok: true as const,
          value: {
            content: `### Engineering Summary:\n- **Equipment ID**: P-204 Pump Skid\n| Equipment | Component | Measured Value | Allowable Limit | Status |\n| P-204 Pump Skid | Discharge Line | DN80 | DN100 or larger | Non-Compliant |\n\n### Technical Evaluation:\nDischarge line diameter DN80 is non-compliant with SOP-220.`,
            tool_calls: [],
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-in-chat-review",
      driverModelId: "vision-qwen25vl",
      userPrompt: "Review the pump skid drawing and check if it follows our piping spec SOP-220",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockDeliverableTool],
      semanticIntent: {
        driverModel: "vision-qwen25vl",
        taskType: "vision",
        primaryGoal: "Inspect and review pump skid drawing against SOP-220",
        isActionable: false,
        targetFiles: [],
        intentType: "file_inspection",
        reason: "Visual drawing review in chat",
      },
      context: { runId: "test-in-chat-review", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: (e) => emittedEvents.push(e),
    });

    expect(result.completed).toBe(true);
    // Deliverable MUST NOT be auto-generated when user only requested in-chat review!
    expect(generatedDeliverables.length).toBe(0);
    const artEvent = emittedEvents.find((e) => e.type === "artifact_ready");
    expect(artEvent).toBeUndefined();
    expect(result.finalText).toContain("P-204 Pump Skid");
    expect(result.finalText).not.toContain("approval-note.docx");
  });

  it("nudges model on turn 1 when model returns a brief placeholder without invoking generate_deliverable", async () => {
    const loop = new AgentLoop();
    let callTurn = 0;
    let receivedMessagesOnTurn2: any[] = [];
    const generatedDeliverables: any[] = [];
    const emittedEvents: any[] = [];

    const mockDeliverableTool: AgentTool = {
      name: "generate_deliverable",
      definition: {
        type: "function",
        function: {
          name: "generate_deliverable",
          description: "Generate deliverable",
          parameters: {
            type: "object",
            properties: {
              type: { type: "string" },
              title: { type: "string" },
              content: { type: "string" },
              filename: { type: "string" },
            },
          },
        },
      },
      execute: async (args) => {
        generatedDeliverables.push(args);
        return {
          output: `Generated deliverable "${args.filename}" (4500 bytes)`,
          summary: `Generated deliverable "${args.filename}"`,
          artifacts: [
            {
              artifactId: "art-nudge-1",
              runId: "test-nudge-deliv",
              kind: "docx",
              filename: String(args.filename),
              relativePath: `runs/test-nudge-deliv/output/${args.filename}`,
              sizeBytes: 4500,
              createdAt: new Date().toISOString(),
            },
          ],
        };
      },
    };

    const mockGateway = {
      chatWithTools: async (_model: string, messages: any[]) => {
        callTurn++;
        if (callTurn === 1) {
          // Model lazily outputs ONLY a 1-sentence promise without calling generate_deliverable (exact run:a6aed379 bug)
          return {
            ok: true as const,
            value: {
              content: "Generating the technical approval note in approval-note.docx...",
              tool_calls: null,
            },
          };
        } else {
          receivedMessagesOnTurn2 = messages;
          // On turn 2, after receiving SYSTEM FEEDBACK, model calls generate_deliverable
          return {
            ok: true as const,
            value: {
              content: "Generating the document now.",
              tool_calls: [
                {
                  id: "call_deliv_2",
                  name: "generate_deliverable",
                  arguments: {
                    type: "docx",
                    filename: "approval-note.docx",
                    title: "Technical Inspection Approval Note",
                    content: "# Approval Note\n\nFindings: Wall thickness 3.8mm below allowable.",
                  },
                },
              ],
            },
          };
        }
      },
    };

    const result = await loop.run({
      runId: "test-nudge-deliv",
      driverModelId: "draft-qwen3",
      userPrompt: "Read these inspection reports, pull out the key findings, and draft an approval note for the plant manager.",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockDeliverableTool],
      semanticIntent: {
        driverModel: "draft-qwen3",
        taskType: "draft",
        primaryGoal: "Draft approval note",
        isActionable: true,
        targetFiles: [],
        intentType: "document_drafting",
        reason: "Document drafting",
      },
      context: { runId: "test-nudge-deliv", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: (e) => emittedEvents.push(e),
    });

    // Loop should NOT have finished on turn 1 with just "Generating..."!
    expect(callTurn).toBeGreaterThanOrEqual(2);
    // Turn 2 messages should include system feedback pointing out the missing tool call
    const feedbackMsg = receivedMessagesOnTurn2.find(
      (m) => typeof m.content === "string" && m.content.includes("[SYSTEM FEEDBACK]"),
    );
    expect(feedbackMsg).toBeDefined();
    expect(feedbackMsg.content).toContain("generate_deliverable");

    // The deliverable was generated!
    expect(generatedDeliverables.length).toBe(1);
    expect(generatedDeliverables[0].filename).toBe("approval-note.docx");
    expect(result.completed).toBe(true);
  });

  it("extractInChatFindings isolates key findings from draft approval note boilerplate", () => {
    const rawContent = `### Key Findings from Inspection Reports

**Report ID: IR-E201-2026-08-20**
- **Equipment:** E-201 Heat Exchanger
- **Tube Wall Thickness:**
  - Rows 12-15 measured 3.8-4.2 mm.
  - Minimum allowable tube wall thickness: 4.6 mm.
  - **Deviation:** Below allowable limit.
- **Corrosion:** Localised pitting corrosion at the shell inlet nozzle; depth 1.8 mm.

### Draft Approval Note for Plant Manager

**Header & Ref**
- Subject: Inspection Report Summary
- Classification: OFFICIAL

| Equipment | Component | Status |
|-----------|-----------|--------|
| E-201     | Tube Wall | Rejected |`;

    const extracted = extractInChatFindings(rawContent);
    expect(extracted).toContain("### Key Findings from Inspection Reports");
    expect(extracted).toContain("Rows 12-15 measured 3.8-4.2 mm.");
    expect(extracted).not.toContain("### Draft Approval Note for Plant Manager");
    expect(extracted).not.toContain("Classification: OFFICIAL");
  });

  it("extractInChatFindings ignores code repair and tool execution chatter", () => {
    const rawContent = `Sure, I can help you fix the Python script to work with the attached CSV file. Let's go through the issues.
### Issues Identified:
1. Bug 1: Missing temperature field crashes run.
2. Bug 2: Temperature upper limit.
### Steps to Execute:
1. Write code via write_file.
2. Execute script via execute_python.`;
    const extracted = extractInChatFindings(rawContent);
    expect(extracted).toBe("");
  });

  it("preserves turn-1 in-chat key findings when turn-2 returns deliverable confirmation", async () => {
    const loop = new AgentLoop();
    let turnCount = 0;

    const mockGateway = {
      async chatWithTools(_modelId: string, _messages: any[], _tools: any[]) {
        turnCount++;
        if (turnCount === 1) {
          return {
            ok: true,
            value: {
              content: `### Key Findings from Inspection Reports

**Report ID: IR-E201-2026-08-20**
- **Equipment:** E-201 Heat Exchanger
- **Tube Wall Thickness:** Rows 12-15 measured 3.8-4.2 mm (Allowable: 4.6 mm).
- **Corrosion:** Localised pitting corrosion 1.8 mm depth.

### Draft Approval Note for Plant Manager
- Sign-off: Pending Repair`,
              tool_calls: [
                {
                  id: "call_deliv_123",
                  name: "generate_deliverable",
                  arguments: {
                    type: "docx",
                    filename: "approval-note.docx",
                    title: "Technical Approval Note",
                    content: "Full document markdown",
                  },
                },
              ],
            },
          };
        }

        // Turn 2: tool completed, model provides concise deliverable notification
        return {
          ok: true,
          value: {
            content: "The approval note for the E-201 inspection has been generated as \"approval-note.docx\" in the run output folder.",
            tool_calls: null,
          },
        };
      },
    };

    const mockDeliverableTool: AgentTool = {
      name: "generate_deliverable",
      definition: {
        type: "function",
        function: {
          name: "generate_deliverable",
          description: "Generate deliverable document",
          parameters: { type: "object", properties: { filename: { type: "string" } } },
        },
      },
      async execute(args: any) {
        return {
          output: `Generated deliverable "${args.filename || "approval-note.docx"}"`,
          summary: "Deliverable generated",
        };
      },
    };

    const result = await loop.run({
      runId: "test-preserve-findings",
      driverModelId: "draft-qwen3",
      userPrompt: "Review both inspection reports. Pull out all key findings, deviations, and annotations. Summarize them here first, then draft an official approval note for the plant manager.",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockDeliverableTool],
      semanticIntent: {
        driverModel: "draft-qwen3",
        taskType: "draft",
        primaryGoal: "Summarize findings and draft approval note",
        isActionable: true,
        targetFiles: [],
        intentType: "document_drafting",
        reason: "Document drafting",
      },
      context: { runId: "test-preserve-findings", workspaceRoot: ".", gateway: mockGateway as any },
      onPlanConfirmationRequired: async () => true,
      emitEvent: () => {},
    });

    expect(result.completed).toBe(true);
    // Key findings from Turn 1 MUST be preserved in the final text displayed in chat!
    expect(result.finalText).toContain("### Key Findings from Inspection Reports");
    expect(result.finalText).toContain("Rows 12-15 measured 3.8-4.2 mm");
    // AND the deliverable notification from Turn 2 must also be present!
    expect(result.finalText).toContain("The approval note for the E-201 inspection has been generated as \"approval-note.docx\"");
  });

  it("preserves turn-1 summary and strips [TOOL_RESULT] tags when model wraps response in simulator tags (run:b05a2acd)", async () => {
    const loop = new AgentLoop();
    let turnCount = 0;
    const emittedEvents: any[] = [];

    const mockGateway = {
      async chatWithTools(_modelId: string, _messages: any[], _tools: any[], options?: any) {
        turnCount++;
        if (turnCount === 1) {
          const rawTurn1 = `[TOOL_RESULT]
# Inspection Report E-201 Heat Exchanger
**Report ID:** IR-E201-2026-08-20
**Equipment:** E-201 Heat Exchanger
**Inspection Findings:**
- **Tube Wall Thickness:** Rows 12-15 measured 3.8-4.2 mm.
- **Minimum Allowable Tube Wall Thickness:** 4.6 mm.
- **Localised Pitting Corrosion at the Shell Inlet Nozzle; Maximum Depth:** 1.8 mm.

**Action Items:**
1. Recheck Weld Joint 4B.

# Inspection Report E-202 Pressure Vessel
**Report ID:** IR-E202-2026-08-21
**Equipment:** E-202 Pressure Vessel
**Inspection Findings:**
- **Tube Wall Thickness:** Rows 12-15 measured 3.8-4.2 mm.

**Action Items:**
1. Verify After Repair.
[END_TOOL_RESULT]`;

          // Stream in chunks including simulator tag boundaries
          options?.onChunk?.("[TOOL_");
          options?.onChunk?.("RESULT]\n# Inspection Report E-201 Heat Exchanger\n");
          options?.onChunk?.("**Report ID:** IR-E201-2026-08-20\n");
          options?.onChunk?.("- **Tube Wall Thickness:** Rows 12-15 measured 3.8-4.2 mm.\n");
          options?.onChunk?.("[END_TOOL_RESULT]");

          return {
            ok: true,
            value: {
              content: rawTurn1,
              tool_calls: [
                {
                  id: "call_deliv_999",
                  name: "generate_deliverable",
                  arguments: {
                    type: "docx",
                    filename: "approval-note.docx",
                    title: "Equipment Inspection Approval Note",
                    content: "Full docx content",
                  },
                },
              ],
            },
          };
        }

        // Turn 2: tool completed, model provides concise confirmation
        return {
          ok: true,
          value: {
            content: "The inspection reports have been read, and key findings have been extracted. An approval note has been drafted and saved as \"approval-note.docx\" in the run output folder.",
            tool_calls: null,
          },
        };
      },
    };

    const mockTool: AgentTool = {
      name: "generate_deliverable",
      definition: {
        type: "function",
        function: {
          name: "generate_deliverable",
          description: "Generate deliverable document",
          parameters: { type: "object", properties: { filename: { type: "string" } } },
        },
      },
      async execute(args: any) {
        return {
          output: `Generated deliverable "${args.filename || "approval-note.docx"}" successfully.`,
          summary: "Created deliverable",
        };
      },
    };

    const result = await loop.run({
      runId: "test-b05a2acd",
      driverModelId: "draft-qwen3",
      userPrompt: "Review both inspection reports. Pull out all key findings, deviations, and annotations. Summarize them here first, then draft an official approval note for the plant manager.",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockTool],
      context: { runId: "test-b05a2acd", workspaceRoot: ".", gateway: mockGateway as any },
      onPlanConfirmationRequired: async () => true,
      emitEvent: (ev) => emittedEvents.push(ev),
    });

    expect(result.completed).toBe(true);

    // 1. Live streamed chunks MUST NEVER contain [TOOL_RESULT] or [END_TOOL_RESULT]
    const chunkEvents = emittedEvents.filter((e) => e.type === "assistant_message_chunk");
    for (const chunk of chunkEvents) {
      expect(chunk.delta).not.toContain("[TOOL_RESULT]");
      expect(chunk.delta).not.toContain("[END_TOOL_RESULT]");
    }

    // 2. Final text MUST NOT contain [TOOL_RESULT]
    expect(result.finalText).not.toContain("[TOOL_RESULT]");
    expect(result.finalText).not.toContain("[END_TOOL_RESULT]");

    // 3. Final text MUST preserve the full Turn 1 summary!
    expect(result.finalText).toContain("# Inspection Report E-201 Heat Exchanger");
    expect(result.finalText).toContain("Tube Wall Thickness");
    expect(result.finalText).toContain("Recheck Weld Joint 4B");
    expect(result.finalText).toContain("# Inspection Report E-202 Pressure Vessel");

    // 4. Final text MUST include the Turn 2 deliverable note
    expect(result.finalText).toContain("approval-note.docx");
  });

  it("presents a generic 2-step plan in confirmation modal instead of dumping report findings", async () => {
    const loop = new AgentLoop();
    let presentedPlan = "";
    const emittedEvents: any[] = [];

    const mockGateway = {
      async chatWithTools() {
        return {
          ok: true,
          value: {
            content: `### Key Findings from Inspection Reports\n\n#### Report ID: IR-E201\n- Tube Wall Thickness: Rows 12-15 measured 3.8-4.2 mm (allowable: 4.6 mm).\n- Localised pitting corrosion: 1.8 mm.\n\n### Draft Approval Note\nSubject: Inspection Report Summary\nClearance: REJECTION PENDING REPAIRS`,
            tool_calls: [
              {
                id: "call_deliv",
                name: "generate_deliverable",
                arguments: {
                  type: "docx",
                  filename: "approval-note.docx",
                  content: "Full note content",
                },
              },
            ],
          },
        };
      },
    };

    const mockTool: AgentTool = {
      name: "generate_deliverable",
      definition: {
        type: "function",
        function: {
          name: "generate_deliverable",
          description: "Generate deliverable document",
          parameters: { type: "object", properties: { filename: { type: "string" } } },
        },
      },
      async execute() {
        return { output: "Generated approval-note.docx", summary: "OK" };
      },
    };

    await loop.run({
      runId: "test-generic-plan-modal",
      driverModelId: "draft-qwen3",
      userPrompt: "Review both inspection reports. Pull out all key findings, deviations, and annotations. Summarize them here first, then draft an official approval note for the plant manager.",
      systemPrompt: "You are Sovereign Workbench.",
      tools: [mockTool],
      context: { runId: "test-generic-plan-modal", workspaceRoot: ".", gateway: mockGateway as any },
      onPlanConfirmationRequired: async (plan) => {
        presentedPlan = plan;
        return false; // Stop after inspecting plan
      },
      emitEvent: (ev) => emittedEvents.push(ev),
    });

    // 1. When in-chat findings were already formulated/streamed, the confirmation focuses forward on compiling the deliverable:
    expect(presentedPlan).toContain("### Proposed Action");
    expect(presentedPlan).toContain("Compile and export the official deliverable document");
    expect(presentedPlan).toContain("approval-note.docx");
    expect(presentedPlan).toContain("### Proposed Operations");
    expect(presentedPlan).toContain("• **generate_deliverable**: Generate DOCX artifact (`approval-note.docx`)");

    // 2. The plan modal MUST NOT contain the 500-word findings dump:
    expect(presentedPlan).not.toContain("Tube Wall Thickness: Rows 12-15 measured 3.8-4.2 mm");
    expect(presentedPlan).not.toContain("Localised pitting corrosion");
    expect(presentedPlan).not.toContain("Clearance: REJECTION PENDING REPAIRS");

    // 3. The findings must have been emitted to the chat so they are visible as a first response:
    const chunkEvents = emittedEvents.filter((e) => e.type === "assistant_message_chunk");
    expect(chunkEvents.length).toBeGreaterThan(0);
    const combinedEmittedText = chunkEvents.map((e) => e.delta).join("");
    expect(combinedEmittedText).toContain("### Key Findings from Inspection Reports");

    // 4. When no in-chat summary was produced yet, deriveFormalPlan produces standard N-step execution plan:
    const upfrontPlan = deriveFormalPlan(
      "Inspect reports and draft approval note",
      [{ name: "generate_deliverable", arguments: { filename: "approval-note.docx" } }],
      false,
    );
    expect(upfrontPlan).toContain("### Execution Plan");
    expect(upfrontPlan).toContain("1. **Inspection & Analysis**");
    expect(upfrontPlan).toContain("2. **Document Generation**");
  });
});


