import { describe, expect, it } from "vitest";
import { AgentLoop } from "./helpers/agent-loop-fixture.js";
import type { AgentTool } from "../src/main/tools/types.js";

describe("Agent Loop Plan Cleaning & Execution Nudges", () => {
  it("cleans plan preview removing [TOOL_RESULT] and premature Implemented claims before confirmation", async () => {
    const loop = new AgentLoop();
    let presentedPlan = "";

    const mockTool: AgentTool = {
      name: "run_command",
      definition: {
        type: "function",
        function: {
          name: "run_command",
          description: "Run command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
      async execute(args) {
        return { output: `Executed ${args.command}`, summary: "OK" };
      },
    };

    const mockGateway = {
      async chatWithTools() {
        return {
          ok: true,
          value: {
            content: `[TOOL_RESULT]
{
  "files": [{"name": "app.js", "type": "file"}]
}
[END_TOOL_RESULT]

I plan to install express-rate-limit and configure the middleware.

**Implemented**:
- Created middleware/rateLimiter.js
- Updated app.js

**Next Steps**:
Run node app.js`,
            tool_calls: [
              {
                id: "call_1",
                name: "run_command",
                arguments: { command: "npm install express-rate-limit" },
              },
            ],
          },
        };
      },
    };

    await loop.run({
      runId: "test-clean-plan",
      driverModelId: "code-qwen25coder",
      userPrompt: "Add a simple rate limiter middleware to the express app",
      systemPrompt: "You are Local Workbench.",
      tools: [mockTool],
      context: { runId: "test-clean-plan", workspaceRoot: ".", gateway: mockGateway as any },
      onPlanConfirmationRequired: async (plan) => {
        presentedPlan = plan;
        return false; // Reject to stop immediately after checking plan
      },
      emitEvent: () => {},
    });

    // Plan shown to user must NOT contain simulator tokens or premature Implemented claims
    expect(presentedPlan).not.toContain("[TOOL_RESULT]");
    expect(presentedPlan).not.toContain("[END_TOOL_RESULT]");
    expect(presentedPlan).not.toContain('"files"');
    expect(presentedPlan).not.toContain("**Implemented**");
    expect(presentedPlan).not.toContain("**Next Steps**");

    // Must contain genuine rationale and formatted proposed operations
    expect(presentedPlan).toContain("I plan to install express-rate-limit and configure the middleware.");
    expect(presentedPlan).toContain("• **run_command**: `npm install express-rate-limit`");
  });

  it("nudges model when user requests command execution (install deps / run app) without calling run_command", async () => {
    const loop = new AgentLoop();
    let turnCount = 0;
    let receivedTurn2Messages: any[] = [];

    const mockRunCommand: AgentTool = {
      name: "run_command",
      definition: {
        type: "function",
        function: {
          name: "run_command",
          description: "Run command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
      async execute() {
        return { output: "Dependencies installed.", summary: "installed" };
      },
    };

    const mockGateway = {
      async chatWithTools(_modelId: any, messages: any[]) {
        turnCount++;
        if (turnCount === 1) {
          // Model lazily answers with conversational text without calling run_command
          return {
            ok: true,
            value: {
              content: `Implemented:
- Created middleware/rateLimiter.js
Next Steps:
Run the server using node app.js`,
              tool_calls: null,
            },
          };
        }
        receivedTurn2Messages = messages;
        // On turn 2 after nudge, model calls run_command
        return {
          ok: true,
          value: {
            content: "Installing dependencies now.",
            tool_calls: [
              {
                id: "call_cmd",
                name: "run_command",
                arguments: { command: "npm install" },
              },
            ],
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-cmd-nudge",
      driverModelId: "code-qwen25coder",
      userPrompt: "Install the deps, run the app and check if everything working",
      systemPrompt: "You are Local Workbench.",
      tools: [mockRunCommand],
      context: { runId: "test-cmd-nudge", workspaceRoot: ".", gateway: mockGateway as any },
      emitEvent: () => {},
    });

    expect(turnCount).toBeGreaterThanOrEqual(2);
    const nudge = receivedTurn2Messages.find(
      (m) => typeof m.content === "string" && m.content.includes("[SYSTEM FEEDBACK]") && m.content.includes("run_command"),
    );
    expect(nudge).toBeDefined();
    expect(result.completed).toBe(true);
  });

  it("intercepts conversational modify code response, saves files to disk, and strips code dumps from chat", async () => {
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
            properties: { path: { type: "string" }, content: { type: "string" } },
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
          // Model lazily answers with conversational text and code blocks instead of native tool calls
          return {
            ok: true,
            value: {
              content: `I apologize for the oversight. Let's correct this by invoking the \`write_file\` tool to save the updated \`@middleware/rateLimiter.js\` and \`app.js\` files.

Here is the updated code for \`@middleware/rateLimiter.js\`:

\`\`\`javascript
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
module.exports = limiter;
\`\`\`

And here is the updated code for \`app.js\`:

\`\`\`javascript
const express = require('express');
const rateLimiter = require('./middleware/rateLimiter');
const app = express();
app.use(rateLimiter);
module.exports = app;
\`\`\`

Implemented:
- The \`@middleware/rateLimiter.js\` and \`app.js\` files have been updated.

Next Steps:
- Run the server using node app.js`,
              tool_calls: null,
            },
          };
        }
        // Turn 2: final answer after tool execution
        return {
          ok: true,
          value: {
            content: `Implemented:
- Updated middleware/rateLimiter.js and app.js.

Next Steps:
- Run node app.js`,
            tool_calls: null,
          },
        };
      },
    };

    const result = await loop.run({
      runId: "test-modify-app",
      driverModelId: "code-qwen25coder",
      userPrompt: "Modify the app code to reflect this, im asking you to do it for me",
      systemPrompt: "You are Local Workbench.",
      tools: [mockWriteFileTool],
      context: { runId: "test-modify-app", workspaceRoot: ".", gateway: mockGateway as any },
      onPlanConfirmationRequired: async () => true,
      emitEvent: () => {},
    });

    expect(writtenFiles).toHaveLength(2);
    expect(writtenFiles[0].path).toBe("middleware/rateLimiter.js");
    expect(writtenFiles[1].path).toBe("app.js");
    expect(result.completed).toBe(true);
    // Final text must be clean and NOT dump full source code
    expect(result.finalText).not.toContain("const rateLimit");
    expect(result.finalText).toContain("Implemented:");
    expect(result.finalText).toContain("Next Steps:");
  });

  it("formats formal task-based plan for execute_python without dumping raw code or JSON blobs", async () => {
    const loop = new AgentLoop();
    let presentedPlan = "";

    const mockPyTool: AgentTool = {
      name: "execute_python",
      definition: {
        type: "function",
        function: {
          name: "execute_python",
          description: "Execute python in sandbox",
          parameters: {
            type: "object",
            properties: {
              code: { type: "string" },
              input_files: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      async execute() {
        return { output: "ROWS 5; MALFORMED 1; ABOVE_LIMIT 1", summary: "verified" };
      },
    };

    const pythonCodeSnippet = `import csv\nimport sys\ndef summarize(path: str):\n    counts = {'ok': 0}\n    return counts`;

    const mockGateway = {
      async chatWithTools() {
        return {
          ok: true,
          value: {
            content: `Here is the updated script:

\`\`\`python
${pythonCodeSnippet}
\`\`\`

Now, let's execute this updated script using the execute_python tool:`,
            tool_calls: [
              {
                id: "call_py",
                name: "execute_python",
                arguments: {
                  code: pythonCodeSnippet,
                  input_files: ["broken-vendor-log-parser.py", "vendor-maintenance-log.csv"],
                },
              },
            ],
          },
        };
      },
    };

    await loop.run({
      runId: "test-py-plan",
      driverModelId: "code-qwen25coder",
      userPrompt: "This is crashing on our vendor log files. Fix it and make sure it actually works.",
      systemPrompt: "You are Local Workbench.",
      tools: [mockPyTool],
      context: { runId: "test-py-plan", workspaceRoot: ".", gateway: mockGateway as any },
      onPlanConfirmationRequired: async (plan) => {
        presentedPlan = plan;
        return false; // Stop after capturing the presented plan
      },
      emitEvent: () => {},
    });

    // 1. Must NOT contain conversational preamble or tool-calling chat
    expect(presentedPlan).not.toContain("Here is the updated script");
    expect(presentedPlan).not.toContain("Now, let's execute");
    // 2. Must NOT contain raw code blocks or code dumps
    expect(presentedPlan).not.toContain("```python");
    expect(presentedPlan).not.toContain("def summarize");
    expect(presentedPlan).not.toContain("import csv");
    // 3. Must NOT dump raw JSON stringified arguments
    expect(presentedPlan).not.toContain('{"code":');
    expect(presentedPlan).not.toContain('"input_files":');
    // 4. Must contain formal, task-based structure
    expect(presentedPlan).toContain("### Objective");
    expect(presentedPlan).toContain("Diagnose and repair reported script/code defects");
    expect(presentedPlan).toContain("### Proposed Operations");
    expect(presentedPlan).toContain("• **execute_python**: Run sandboxed script verification using `broken-vendor-log-parser.py, vendor-maintenance-log.csv`");
  });
});
