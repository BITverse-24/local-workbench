import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import type { AgentToolDefinition } from "../src/shared/contracts.js";

const sampleTools: AgentToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read content of a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to file" },
        },
        required: ["path"],
      },
    },
  },
];

describe("ModelGateway.chatWithTools", () => {
  it("parses native tool calls from provider response", async () => {
    const mockTransport = {
      async request() {
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "I will read the file to see the content.",
                    tool_calls: [
                      {
                        id: "call_abc123",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: JSON.stringify({ path: "README.md" }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 150, completion_tokens: 45 },
            });
          },
        };
      },
    };

    const gateway = new ModelGateway(mockTransport);
    const result = await gateway.chatWithTools(
      "draft-qwen3",
      [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Read README.md" },
      ],
      sampleTools,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.content).toBe("I will read the file to see the content.");
    expect(result.value.tool_calls).toHaveLength(1);
    expect(result.value.tool_calls?.[0]).toEqual({
      id: "call_abc123",
      name: "read_file",
      arguments: { path: "README.md" },
    });
  });

  it("handles pure chat when model does not call any tools", async () => {
    const mockTransport = {
      async request() {
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "A heat exchanger transfers heat between two fluids.",
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 20 },
            });
          },
        };
      },
    };

    const gateway = new ModelGateway(mockTransport);
    const result = await gateway.chatWithTools(
      "draft-qwen3",
      [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is a heat exchanger?" },
      ],
      sampleTools,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.content).toBe("A heat exchanger transfers heat between two fluids.");
    expect(result.value.tool_calls).toBeNull();
  });

  it("falls back to schema-in-prompt when provider rejects native tools with 400", async () => {
    let callCount = 0;
    const mockTransport = {
      async request(_url: string, init: { body?: string }) {
        callCount++;
        // First call with native tools returns 400 rejecting tools
        if (callCount === 1) {
          return {
            status: 400,
            async text() {
              return JSON.stringify({ error: "unsupported parameter: tools" });
            },
          };
        }
        // Fallback call parses prompt-injected JSON response
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      content: "Inspecting directory first",
                      tool_calls: [{ name: "read_file", arguments: { path: "main.ts" } }],
                    }),
                  },
                },
              ],
            });
          },
        };
      },
    };

    const gateway = new ModelGateway(mockTransport);
    const result = await gateway.chatWithTools(
      "draft-qwen3",
      [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Read main.ts" },
      ],
      sampleTools,
    );

    expect(callCount).toBe(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.content).toBe("Inspecting directory first");
    expect(result.value.tool_calls).toHaveLength(1);
    expect(result.value.tool_calls?.[0].name).toBe("read_file");
    expect(result.value.tool_calls?.[0].arguments).toEqual({ path: "main.ts" });
  });
});
