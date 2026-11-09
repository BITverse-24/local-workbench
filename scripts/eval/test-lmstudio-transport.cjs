const http = require("node:http");

async function queryModel(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      "http://127.0.0.1:1234/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("JSON parse error: " + body));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function testTransports() {
  const model = "qwen/qwen3.5-9b";
  console.log("Testing transport formats against LM Studio model:", model);

  const sigs = `declare const tools: {
  readFile(path: string): Promise<{ content: string; digest: string }>;
  listDir(path: string): Promise<string[]>;
};
declare function text(value: unknown): void;
declare function escalate(reason: string): never;`;

  // Test 1: Fenced code mode
  console.log("\n--- Testing Arm B: Fenced Script ---");
  const fencedPayload = {
    model,
    messages: [
      {
        role: "system",
        content: `You are in Code Mode (read-only execution).
Instead of calling individual tools, write a concise TypeScript script using tools.* to inspect the workspace.
Call text(...) with your findings.

${sigs}

Return ONE code block in \`\`\`ts containing your script. No markdown prose around it.`,
      },
      {
        role: "user",
        content: "Find the entry file in the current directory and read its contents.",
      },
    ],
    max_tokens: 512,
    temperature: 0,
  };

  const fencedRes = await queryModel(fencedPayload);
  const fencedContent = fencedRes.choices?.[0]?.message?.content || "";
  const fencedReasoning = fencedRes.choices?.[0]?.message?.reasoning_content || "";
  console.log("Fenced finish reason:", fencedRes.choices?.[0]?.finish_reason);
  console.log("Fenced completion tokens:", fencedRes.usage?.completion_tokens);
  console.log("Fenced reasoning snippet:", fencedReasoning.slice(0, 150));
  console.log("Fenced Content:\n", fencedContent);

  // Test 2: Tool call mode
  console.log("\n--- Testing Arm C: Tool Call ---");
  const toolPayload = {
    model,
    messages: [
      {
        role: "system",
        content: `You are in Code Mode (read-only execution).
Use the exec tool to run a script against the tools facade.

${sigs}`,
      },
      {
        role: "user",
        content: "Find the entry file in the current directory and read its contents.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "exec",
          description: "Execute a JavaScript/TypeScript script in Code Mode.",
          parameters: {
            type: "object",
            properties: {
              code: { type: "string", description: "Script to execute." },
            },
            required: ["code"],
          },
        },
      },
    ],
    tool_choice: "required",
    max_tokens: 512,
    temperature: 0,
  };

  const toolRes = await queryModel(toolPayload);
  const toolCalls = toolRes.choices?.[0]?.message?.tool_calls || [];
  console.log("ToolCall finish reason:", toolRes.choices?.[0]?.finish_reason);
  console.log("ToolCall completion tokens:", toolRes.usage?.completion_tokens);
  console.log("Tool Calls returned:\n", JSON.stringify(toolCalls, null, 2));
}

testTransports().catch(console.error);
