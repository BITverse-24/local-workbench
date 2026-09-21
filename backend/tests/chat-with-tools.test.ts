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

  it("normalizes multi-turn conversation messages into strict OpenAI wire format with functions and stringified arguments", async () => {
    let capturedBody: any = null;
    const mockTransport = {
      async request(_url: string, init: { body?: string }) {
        capturedBody = JSON.parse(init.body ?? "{}");
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Files listed and removed.",
                    tool_calls: null,
                  },
                },
              ],
            });
          },
        };
      },
    };

    const gateway = new ModelGateway(mockTransport);

    // Multi-turn messages containing agent internal fields (turn, toolName, arguments object)
    const multiTurnMessages = [
      { role: "system", content: "You are Sovereign Workbench." },
      { role: "user", content: "Delete all files in the workspace" },
      {
        role: "assistant",
        content: "To delete the files in the workspace, I will first list them.",
        tool_calls: [
          {
            id: "call_list123",
            name: "list_dir",
            arguments: { path: "." },
          },
        ],
        turn: 1,
      },
      {
        role: "tool",
        tool_call_id: "call_list123",
        toolName: "list_dir",
        content: "1 items in \".\":\n- file.txt",
        turn: 1,
      },
    ];

    const result = await gateway.chatWithTools("draft-qwen3", multiTurnMessages as any, sampleTools);

    expect(result.ok).toBe(true);
    expect(capturedBody).toBeDefined();

    // Verify messages array in the HTTP request payload
    const wireMessages = capturedBody.messages;
    expect(wireMessages).toHaveLength(4);

    // Message 0: system
    expect(wireMessages[0]).toEqual({
      role: "system",
      content: "You are Sovereign Workbench.",
    });

    // Message 1: user
    expect(wireMessages[1]).toEqual({
      role: "user",
      content: "Delete all files in the workspace",
    });

    // Message 2: assistant with normalized tool_calls
    const assistantMsg = wireMessages[2];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("To delete the files in the workspace, I will first list them.");
    expect(assistantMsg.turn).toBeUndefined(); // internal property stripped
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0]).toEqual({
      id: "call_list123",
      type: "function",
      function: {
        name: "list_dir",
        arguments: '{"path":"."}', // MUST be a stringified JSON!
      },
    });

    // Message 3: tool message
    const toolMsg = wireMessages[3];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call_list123");
    expect(toolMsg.content).toBe('1 items in ".":\n- file.txt');
    expect(toolMsg.turn).toBeUndefined(); // internal property stripped
    expect(toolMsg.toolName).toBeUndefined(); // internal property stripped
  });

  it("parses embedded <tool_call> XML blocks from local model message content", async () => {
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
                    content: "I will update the rate limiter now.\n<tool_call>\n{\"name\": \"write_file\", \"arguments\": {\"path\": \"middleware/rateLimiter.js\", \"content\": \"module.exports = {};\"}}\n</tool_call>",
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            });
          },
        };
      },
    };

    const gateway = new ModelGateway(mockTransport);
    const result = await gateway.chatWithTools(
      "code-qwen25coder",
      [{ role: "user", content: "Update rate limiter" }],
      sampleTools,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.tool_calls).toHaveLength(1);
    expect(result.value.tool_calls?.[0].name).toBe("write_file");
    expect(result.value.tool_calls?.[0].arguments).toEqual({
      path: "middleware/rateLimiter.js",
      content: "module.exports = {};",
    });
    expect(result.value.content).toBe("I will update the rate limiter now.");
  });

  it("parses raw JSON object tool calls from local model message content", async () => {
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
                    content: "```json\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"app.js\"}}\n```",
                  },
                },
              ],
              usage: { prompt_tokens: 80, completion_tokens: 20 },
            });
          },
        };
      },
    };

    const gateway = new ModelGateway(mockTransport);
    const result = await gateway.chatWithTools(
      "code-qwen25coder",
      [{ role: "user", content: "Inspect app.js" }],
      sampleTools,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.tool_calls).toHaveLength(1);
    expect(result.value.tool_calls?.[0].name).toBe("read_file");
    expect(result.value.tool_calls?.[0].arguments).toEqual({ path: "app.js" });
  });
});
