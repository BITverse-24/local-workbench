import { describe, expect, it } from "vitest";
import { compactConversationHistory, compactToolResult, type AgentMessage } from "../src/main/agent/context-manager.js";
import { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";
import { AgentLoop } from "../src/main/agent/agent-loop.js";
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
    // Turn 3: capped to 350 because write_file mutated disk on turn 2
    expect(maxTokensPerTurn[2]).toBe(350);
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
    expect(result.finalText).toContain("Execution stopped: The model repeatedly encountered errors");
    const errorEvent = emittedEvents.find((e) => e.type === "error" && e.code === "tool_loop_detected");
    expect(errorEvent).toBeDefined();
  });
});


