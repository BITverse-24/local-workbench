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
});
