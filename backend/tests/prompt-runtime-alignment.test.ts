import { describe, it, expect } from "vitest";
import { AgentLoop } from "./helpers/agent-loop-fixture.js";
import { buildHarnessSystemPrompt, HARNESS_TOOL_DEFINITIONS } from "../src/main/harness/harness-prompt.js";
import { workspaceTools } from "../src/main/tools/workspace-tools.js";
import type { AgentTool } from "../src/main/tools/types.js";

describe("P0-07: Prompt and Runtime Alignment", () => {
  describe("Harness Prompt & Tool Alignment", () => {
    it("ensures every tool defined in HARNESS_TOOL_DEFINITIONS exists in workspaceTools", () => {
      const workspaceToolNames = new Set(workspaceTools.map((t) => t.name));
      const harnessPromptToolNames = HARNESS_TOOL_DEFINITIONS.map((t) => t.function.name);

      for (const toolName of harnessPromptToolNames) {
        expect(workspaceToolNames.has(toolName)).toBe(true);
      }
    });

    it("verifies harness prompt does not claim unconstrained 'FULL PERMISSION' or demand bypassing safety policies", () => {
      const prompt = buildHarnessSystemPrompt("📁 src\n   src/index.ts (1.0KB)");
      expect(prompt).not.toContain("YOU HAVE FULL PERMISSION");
      expect(prompt).not.toContain("NEVER claim that you lack permissions");
      expect(prompt).toContain("subject to user review and safety policy containment");
      expect(prompt).toContain("workspace containment boundaries");
    });

    it("does not include nonexistent edit_file in harness tools", () => {
      const names = HARNESS_TOOL_DEFINITIONS.map((t) => t.function.name);
      expect(names).not.toContain("edit_file");
      const workspaceNames = workspaceTools.map((t) => t.name);
      expect(workspaceNames).not.toContain("edit_file");
    });
  });

  describe("Chat Code Snippet vs Filesystem Mutation Isolation", () => {
    it("ensures a code snippet requested in chat is not autonomously converted into a filesystem mutation", async () => {
      const loop = new AgentLoop();
      const writtenFiles: Array<{ path: string; content: string }> = [];

      const mockWriteFile: AgentTool = {
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
          writtenFiles.push({ path: String(args.path), content: String(args.content) });
          return { output: "Saved", summary: "Saved" };
        },
      };

      const mockGateway = {
        async chatWithTools() {
          return {
            ok: true as const,
            value: {
              content: `Here is how you parse a CSV in Node.js:
\`\`\`javascript
// parse.js
const fs = require('fs');
console.log('parsing');
\`\`\`
You can run this with \`node parse.js\`.`,
              tool_calls: null,
            },
          };
        },
      };

      const result = await loop.run({
        runId: "test-chat-snippet",
        driverModelId: "code-qwen25coder",
        userPrompt: "How do I parse a CSV in Node? Show me an example script",
        systemPrompt: "You are Sovereign Workbench.",
        tools: [mockWriteFile],
        context: {
          runId: "test-chat-snippet",
          workspaceRoot: ".",
          gateway: mockGateway as any,
        },
        emitEvent: () => {},
      });

      // Pure chat answer: No file writes should be performed!
      expect(writtenFiles).toHaveLength(0);
      expect(result.outcome).toBe("completed");
      expect(result.completed).toBe(true);
      expect(result.finalText).toContain("const fs = require('fs')");
    });
  });

  describe("Deliverable Verification Truthfulness", () => {
    it("does not claim deliverable success if generate_deliverable fails", async () => {
      const loop = new AgentLoop();

      const mockDeliverableTool: AgentTool = {
        name: "generate_deliverable",
        definition: {
          type: "function",
          function: {
            name: "generate_deliverable",
            description: "deliverable",
            parameters: { type: "object", properties: {} },
          },
        },
        async execute() {
          throw new Error("Failed to compile deliverable: invalid section structure");
        },
      };

      let turnCount = 0;
      const mockGateway = {
        async chatWithTools() {
          turnCount++;
          if (turnCount === 1) {
            return {
              ok: true as const,
              value: {
                content: "Generating approval note now.",
                tool_calls: [
                  {
                    id: "call_deliv",
                    name: "generate_deliverable",
                    arguments: {
                      filename: "approval-note.docx",
                      title: "Approval Note",
                      content: "# Invalid",
                    },
                  },
                ],
              },
            };
          }
          // Turn 2: after tool failure, model stops
          return {
            ok: true as const,
            value: {
              content: "The deliverable could not be compiled due to an error.",
              tool_calls: null,
            },
          };
        },
      };

      const result = await loop.run({
        runId: "test-failed-deliverable",
        driverModelId: "draft-qwen3",
        userPrompt: "Draft an approval note in approval-note.docx",
        systemPrompt: "You are Sovereign Workbench.",
        tools: [mockDeliverableTool],
        context: {
          runId: "test-failed-deliverable",
          workspaceRoot: ".",
          gateway: mockGateway as any,
        },
        emitEvent: () => {},
      });

      // Failed deliverable must NOT be claimed as completed or produced!
      expect(result.deliverables?.produced).not.toContain("approval-note.docx");
      expect(result.outcome).toBe("failed");
      expect(result.completed).toBe(false);
      expect(result.finalText).not.toContain("The official deliverable document has been compiled and saved as [approval-note.docx]");
    });
  });

  describe("Typed Error Feedback Alignment", () => {
    it("embeds real typed error code in failure summary when tool loops in failure", async () => {
      const loop = new AgentLoop();

      const mockFailingTool: AgentTool = {
        name: "read_file",
        definition: {
          type: "function",
          function: {
            name: "read_file",
            description: "read",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
        async execute() {
          const err = new Error("ENOENT: no such file or directory, open 'missing.txt'");
          (err as any).code = "ENOENT";
          throw err;
        },
      };

      const mockGateway = {
        async chatWithTools() {
          return {
            ok: true as const,
            value: {
              content: "Let me check missing.txt",
              tool_calls: [
                {
                  id: "call_missing",
                  name: "read_file",
                  arguments: { path: "missing.txt" },
                },
              ],
            },
          };
        },
      };

      const result = await loop.run({
        runId: "test-loop-error",
        driverModelId: "code-qwen25coder",
        userPrompt: "Read the missing file and explain it",
        systemPrompt: "You are Sovereign Workbench.",
        tools: [mockFailingTool],
        context: {
          runId: "test-loop-error",
          workspaceRoot: ".",
          gateway: mockGateway as any,
        },
        emitEvent: () => {},
      });

      expect(result.outcome).toBe("failed");
      expect(result.completed).toBe(false);
      // Failure summary must contain the classified error code [file_not_found]
      expect(result.finalText).toContain("[file_not_found]");
    });
  });

  describe("Non-Coercive System Nudges", () => {
    it("delivers non-coercive system context without imperative command demands", async () => {
      const loop = new AgentLoop();
      let callTurn = 0;
      let turn2Messages: any[] = [];

      const mockRunCommand: AgentTool = {
        name: "run_command",
        definition: {
          type: "function",
          function: {
            name: "run_command",
            description: "cmd",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
        async execute() {
          return { output: "npm installed", summary: "npm installed" };
        },
      };

      const mockGateway = {
        async chatWithTools(_model: any, messages: any[]) {
          callTurn++;
          if (callTurn === 1) {
            return {
              ok: true as const,
              value: {
                content: "I will install express and start the server.",
                tool_calls: null,
              },
            };
          }
          turn2Messages = messages;
          return {
            ok: true as const,
            value: {
              content: "Commands have been initiated.",
              tool_calls: null,
            },
          };
        },
      };

      await loop.run({
        runId: "test-nudge-non-coercive",
        driverModelId: "code-qwen25coder",
        userPrompt: "Install express using npm install and start the app",
        systemPrompt: "You are Sovereign Workbench.",
        tools: [mockRunCommand],
        context: {
          runId: "test-nudge-non-coercive",
          workspaceRoot: ".",
          gateway: mockGateway as any,
        },
        emitEvent: () => {},
      });

      const feedback = turn2Messages.find(
        (m) => typeof m.content === "string" && m.content.includes("[SYSTEM FEEDBACK]"),
      );
      expect(feedback).toBeDefined();
      // Should NOT contain coercive demand "You MUST invoke ... now"
      expect(feedback.content).not.toContain("You MUST invoke");
      // Should mention safety policies
      expect(feedback.content).toContain("workspace safety policies");
    });
  });
});
