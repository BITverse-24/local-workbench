import { describe, it, expect, vi } from "vitest";
import {
  determineOutputExpectation,
  isInformationalInquiry,
  detectDeliverableExpectations,
  detectWorkspaceMutation,
} from "../src/main/router/output-expectation.js";
import { AgentLoop } from "../src/main/agent/agent-loop.js";
import type { AgentTool } from "../src/main/tools/types.js";

describe("P0-05: Output Expectation & Chat vs File vs Artifact Routing", () => {
  describe("Specification Matrix Scenarios", () => {
    it('Scenario 1: "Explain this CSV" -> Chat response only, no files expected, no workspace mutation', () => {
      const expectation = determineOutputExpectation("Explain this CSV", {
        attachments: [{ filename: "data.csv", mediaType: "text/csv", relativePath: "input/data.csv", sizeBytes: 1024, attachmentId: "att-1" }],
      });

      expect(expectation.chatResponse).toBe(true);
      expect(expectation.expectedFiles).toEqual([]);
      expect(expectation.workspaceMutationRequested).toBe(false);
    });

    it('Scenario 2: "Create a cleaned Excel workbook" -> Verified XLSX deliverable expected, no workspace mutation', () => {
      const expectation = determineOutputExpectation("Create a cleaned Excel workbook", {
        attachments: [{ filename: "raw.csv", mediaType: "text/csv", relativePath: "input/raw.csv", sizeBytes: 1024, attachmentId: "att-1" }],
      });

      expect(expectation.chatResponse).toBe(true);
      expect(expectation.expectedFiles).toContain("cleaned.xlsx");
      expect(expectation.workspaceMutationRequested).toBe(false);
    });

    it('Scenario 3: "Update config.json" -> Authorized workspace mutation, config.json expected', () => {
      const expectation = determineOutputExpectation("Update config.json", {
        hasWorkspace: true,
        workspaceFiles: ["config.json", "index.ts", "package.json"],
      });

      expect(expectation.chatResponse).toBe(true);
      expect(expectation.expectedFiles).toContain("config.json");
      expect(expectation.workspaceMutationRequested).toBe(true);
    });

    it('Scenario 4: "Generate a report and supporting workbook" -> Both required artifacts (.docx + .xlsx)', () => {
      const expectation = determineOutputExpectation("Generate a report and supporting workbook", {
        attachments: [{ filename: "measurements.csv", mediaType: "text/csv", relativePath: "input/measurements.csv", sizeBytes: 1024, attachmentId: "att-1" }],
      });

      expect(expectation.chatResponse).toBe(true);
      expect(expectation.expectedFiles).toContain("report.docx");
      expect(expectation.expectedFiles).toContain("supporting-workbook.xlsx");
      expect(expectation.workspaceMutationRequested).toBe(false);
    });

    it('Scenario 5: "Show me how to do this in Python" -> Chat containing Python, no unsolicited file writes', () => {
      const expectation = determineOutputExpectation("Show me how to do this in Python", {
        hasWorkspace: true,
      });

      expect(expectation.chatResponse).toBe(true);
      expect(expectation.expectedFiles).toEqual([]);
      expect(expectation.workspaceMutationRequested).toBe(false);
    });
  });

  describe("Granular Intent & Edge Cases", () => {
    it("recognizes question and explanation inquiries without mutating files", () => {
      expect(isInformationalInquiry("What does parser.py do?")).toBe(true);
      expect(isInformationalInquiry("Explain how the auth middleware works")).toBe(true);
      expect(isInformationalInquiry("How do I parse a CSV in Node?")).toBe(true);
      expect(isInformationalInquiry("Can you describe the reactor architecture?")).toBe(true);
      expect(isInformationalInquiry("Review the skid drawing against SOP-220")).toBe(true);
      expect(isInformationalInquiry("What is the difference between A and B?")).toBe(true);

      // Mutating requests are NOT informational inquiries
      expect(isInformationalInquiry("Update config.json")).toBe(false);
      expect(isInformationalInquiry("Fix the bug and save to server.py")).toBe(false);
      expect(isInformationalInquiry("Create a cleaned Excel workbook")).toBe(false);
      expect(isInformationalInquiry("Draft an approval note in approval-note.docx")).toBe(false);
    });

    it("detects explicit and categorical deliverable expectations", () => {
      expect(detectDeliverableExpectations("Export results to summary.csv")).toContain("summary.csv");
      expect(detectDeliverableExpectations("Draft an approval note for E-201 in approval-note.docx")).toContain("approval-note.docx");
      expect(detectDeliverableExpectations("Draft an approval note")).toContain("approval-note.docx");
      expect(detectDeliverableExpectations("Compile report.docx for the plant manager")).toContain("report.docx");
    });

    it("detects workspace mutations with target files and project migrations", () => {
      const mut1 = detectWorkspaceMutation("Fix server.py and routes/auth.ts", true, ["server.py", "routes/auth.ts"]);
      expect(mut1.requested).toBe(true);
      expect(mut1.files).toContain("server.py");
      expect(mut1.files).toContain("routes/auth.ts");

      const mut2 = detectWorkspaceMutation("Convert codebase to TypeScript", true, ["src/index.js"]);
      expect(mut2.requested).toBe(true);
    });

    it("excludes files in negative directives from deliverable expectations and workspace mutations", () => {
      const p = "Update notes.md in the active workspace. Change the status from Draft to Reviewed and add a short section titled Review Notes containing the sentence 'Initial document review completed.' Do not modify config.json, unrelated.md, or any other existing file.";
      const expectation = determineOutputExpectation(p, {
        hasWorkspace: true,
        workspaceFiles: ["notes.md", "config.json", "unrelated.md"],
      });

      expect(expectation.workspaceMutationRequested).toBe(true);
      expect(expectation.expectedFiles).toContain("notes.md");
      expect(expectation.expectedFiles).not.toContain("config.json");
      expect(expectation.expectedFiles).not.toContain("unrelated.md");

      const delivs = detectDeliverableExpectations(p);
      expect(delivs).toContain("notes.md");
      expect(delivs).not.toContain("config.json");
      expect(delivs).not.toContain("unrelated.md");
    });
  });

  describe("Agent Loop Execution Integrity", () => {
    it('"Show me how to do this in Python" never writes code blocks to workspace', async () => {
      const loop = new AgentLoop();
      const writtenFiles: any[] = [];

      const mockWriteTool: AgentTool = {
        name: "write_file",
        definition: {
          type: "function",
          function: {
            name: "write_file",
            description: "Write file",
            parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
          },
        },
        execute: async (args) => {
          writtenFiles.push(args);
          return { output: "written", summary: "written" };
        },
      };

      const mockGateway = {
        chatWithTools: async () => ({
          ok: true as const,
          value: {
            content: "Here is how you can do it:\n\n```python\n# solution.py\ndef process_data(items):\n    return [x * 2 for x in items]\n```",
            tool_calls: [],
          },
        }),
      };

      const result = await loop.run({
        runId: "test-p05-python",
        driverModelId: "code-qwen25coder",
        userPrompt: "Show me how to do this in Python",
        systemPrompt: "You are Local Workbench.",
        tools: [mockWriteTool],
        semanticIntent: {
          driverModel: "code-qwen25coder",
          taskType: "code",
          primaryGoal: "Show python solution",
          isActionable: false,
          targetFiles: [],
          intentType: "general_qa",
          reason: "informational coding query",
        },
        context: { runId: "test-p05-python", workspaceRoot: ".", gateway: mockGateway as any },
        emitEvent: () => undefined,
      });

      // No write_file executed!
      expect(writtenFiles.length).toBe(0);
      expect(result.completed).toBe(true);
      expect(result.outcome).toBe("completed");
      expect(result.finalText).toContain("```python");
      expect(result.finalText).toContain("process_data");
    });

    it('"Explain this CSV" does not announce intermediate scripts as deliverables', async () => {
      const loop = new AgentLoop();

      const mockExecPythonTool: AgentTool = {
        name: "execute_python",
        definition: {
          type: "function",
          function: {
            name: "execute_python",
            description: "Execute python",
            parameters: { type: "object", properties: { code: { type: "string" } } },
          },
        },
        execute: async () => ({
          output: "rows: 10, columns: 3",
          summary: "Executed inspection script",
          artifacts: [
            {
              artifactId: "art-runner",
              runId: "test-p05-explain",
              kind: "txt",
              filename: "runner.py",
              relativePath: "runs/test-p05-explain/output/runner.py",
              sizeBytes: 120,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      };

      let turnCount = 0;
      const mockGateway = {
        chatWithTools: async () => {
          turnCount++;
          if (turnCount === 1) {
            return {
              ok: true as const,
              value: {
                content: "Let me check the CSV structure.",
                tool_calls: [
                  {
                    id: "call_py_1",
                    name: "execute_python",
                    arguments: { code: "import pandas as pd; print(pd.read_csv('data.csv').shape)" },
                  },
                ],
              },
            };
          }
          return {
            ok: true as const,
            value: {
              content: "This CSV contains 10 rows and 3 columns covering sensor temperatures and pressures.",
              tool_calls: [],
            },
          };
        },
      };

      const result = await loop.run({
        runId: "test-p05-explain",
        driverModelId: "draft-qwen3",
        userPrompt: "Explain this CSV",
        systemPrompt: "You are Local Workbench.",
        tools: [mockExecPythonTool],
        semanticIntent: {
          driverModel: "draft-qwen3",
          taskType: "draft",
          primaryGoal: "Explain CSV",
          isActionable: false,
          targetFiles: ["data.csv"],
          intentType: "general_qa",
          reason: "informational inquiry",
        },
        context: { runId: "test-p05-explain", workspaceRoot: ".", gateway: mockGateway as any },
        emitEvent: () => undefined,
      });

      expect(result.completed).toBe(true);
      expect(result.outcome).toBe("completed");
      expect(result.finalText).toContain("This CSV contains 10 rows and 3 columns");
      // Intermediate runner script MUST NOT be announced as a deliverable!
      expect(result.finalText).not.toContain("The verified script has been saved as [runner.py]");
    });
  });
});
