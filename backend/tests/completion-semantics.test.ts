import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  detectRequestedDeliverables,
  evaluateCompletionOutcome,
  type ExpectedDeliverable,
} from "../src/main/agent/agent-loop.js";
import { AgentLoop } from "./helpers/agent-loop-fixture.js";
import { RunManager } from "../src/main/run/manager.js";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { getState, transition, createRun } from "../src/main/run/store.js";
import { createChat } from "../src/main/persistence/chats.js";
import type { AgentOutcome, RunEvent } from "../src/shared/contracts.js";
import type { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { testModelRegistry } from "./helpers/test-model-registry.js";

describe("P0-02: Truthful Completion Semantics", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "workbench-p0-02-"));
  });

  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    delete process.env.WORKBENCH_AGENT_V2;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── 1. Unit Tests: Deliverable Detection ─────────────────────────────────

  describe("detectRequestedDeliverables", () => {
    it("detects single requested DOCX deliverable", () => {
      const p1 = "Please draft an approval note for heat exchanger E-201";
      const d1 = detectRequestedDeliverables(p1);
      expect(d1.length).toBe(1);
      expect(d1[0].type).toBe("docx");

      const p2 = "Generate an approval note docx with findings";
      const d2 = detectRequestedDeliverables(p2);
      expect(d2.length).toBe(1);
      expect(d2[0].type).toBe("docx");

      const p3 = "Save the inspection summary as report.docx";
      const d3 = detectRequestedDeliverables(p3);
      expect(d3.length).toBe(1);
      expect(d3[0].type).toBe("docx");
      expect(d3[0].filename).toBe("report.docx");
    });

    it("detects single requested XLSX deliverable", () => {
      const p1 = "Export an excel sheet of the tube wall measurements";
      const d1 = detectRequestedDeliverables(p1);
      expect(d1.length).toBe(1);
      expect(d1[0].type).toBe("xlsx");

      const p2 = "Create summary.xlsx with calculated limits";
      const d2 = detectRequestedDeliverables(p2);
      expect(d2.length).toBe(1);
      expect(d2[0].type).toBe("xlsx");
      expect(d2[0].filename).toBe("summary.xlsx");
    });

    it("detects multi-deliverable requests (DOCX + XLSX)", () => {
      const p = "Draft an approval note in docx format and export an excel sheet of the findings";
      const d = detectRequestedDeliverables(p);
      expect(d.length).toBe(2);
      expect(d.some((item) => item.type === "docx")).toBe(true);
      expect(d.some((item) => item.type === "xlsx")).toBe(true);
    });

    it("distinguishes input files from requested deliverables", () => {
      const p1 = "Inspect inspection-report.docx and tell me if it complies with SOP-114";
      const d1 = detectRequestedDeliverables(p1, undefined, ["inspection-report.docx"]);
      expect(d1.length).toBe(0);

      const p2 = "Read from data.csv and calculate the mean temperature";
      const d2 = detectRequestedDeliverables(p2, undefined, ["data.csv"]);
      expect(d2.length).toBe(0);
    });

    it("returns empty list for pure chat and QA requests", () => {
      const p1 = "What is the allowable tube wall thinning under SOP-114?";
      expect(detectRequestedDeliverables(p1)).toEqual([]);

      const p2 = "Explain the difference between ASME Section VIII and API 510";
      expect(detectRequestedDeliverables(p2)).toEqual([]);
    });

    it("excludes files subject to negative constraints or prohibitions", () => {
      const p = "Update notes.md in the active workspace. Change the status from Draft to Reviewed and add a short section titled Review Notes containing the sentence 'Initial document review completed.' Do not modify config.json, unrelated.md, or any other existing file.";
      const deliverables = detectRequestedDeliverables(p);
      expect(deliverables.map((d) => d.filename)).toEqual(["notes.md"]);
      expect(deliverables.some((d) => d.filename === "config.json")).toBe(false);
      expect(deliverables.some((d) => d.filename === "unrelated.md")).toBe(false);

      const p2 = "Generate report.docx without modifying template.docx or data.xlsx";
      const deliv2 = detectRequestedDeliverables(p2);
      expect(deliv2.map((d) => d.filename)).toContain("report.docx");
      expect(deliv2.some((d) => d.filename === "template.docx")).toBe(false);
      expect(deliv2.some((d) => d.filename === "data.xlsx")).toBe(false);
    });
  });

  // ── 2. Unit Tests: Outcome Evaluation ───────────────────────────────────

  describe("evaluateCompletionOutcome", () => {
    it("Scenario 1: Simple chat answer, no tools required -> Completed", () => {
      const res = evaluateCompletionOutcome([], new Set(), false, false, false);
      expect(res.outcome).toBe("completed");
      expect(res.missingDeliverables).toEqual([]);
    });

    it("Scenario 2: Requested DOCX successfully generated and verified -> Completed", () => {
      const expected: ExpectedDeliverable[] = [{ type: "docx", description: "approval note" }];
      const produced = new Set(["approval-note.docx"]);
      const res = evaluateCompletionOutcome(expected, produced, false, false, false);
      expect(res.outcome).toBe("completed");
      expect(res.missingDeliverables).toEqual([]);
      expect(res.producedDeliverables).toContain("approval-note.docx");
    });

    it("Scenario 3: Model stops without creating requested DOCX -> Partial", () => {
      const expected: ExpectedDeliverable[] = [{ type: "docx", description: "Word document (.docx)" }];
      const produced = new Set<string>();
      const res = evaluateCompletionOutcome(expected, produced, false, false, false);
      expect(res.outcome).toBe("partial");
      expect(res.missingDeliverables.length).toBe(1);
    });

    it("Scenario 4: Agent reaches turn limit -> Limit exceeded", () => {
      const expected: ExpectedDeliverable[] = [{ type: "docx", description: "approval note" }];
      const produced = new Set<string>();
      const res = evaluateCompletionOutcome(expected, produced, false, true, false);
      expect(res.outcome).toBe("limit_exceeded");
    });

    it("Scenario 5: User cancels execution -> Cancelled", () => {
      const res = evaluateCompletionOutcome([], new Set(), false, false, true);
      expect(res.outcome).toBe("cancelled");
    });

    it("Scenario 6: Unrecoverable execution error -> Failed", () => {
      const expected: ExpectedDeliverable[] = [{ type: "docx", description: "report.docx" }];
      const produced = new Set<string>();
      const res = evaluateCompletionOutcome(expected, produced, true, false, false);
      expect(res.outcome).toBe("failed");
    });

    it("Scenario 7: One of two deliverables is produced -> Partial", () => {
      const expected: ExpectedDeliverable[] = [
        { type: "docx", filename: "report.docx", description: "report.docx" },
        { type: "xlsx", filename: "summary.xlsx", description: "summary.xlsx" },
      ];
      const produced = new Set(["report.docx"]);
      const res = evaluateCompletionOutcome(expected, produced, false, false, false);
      expect(res.outcome).toBe("partial");
      expect(res.producedDeliverables).toEqual(["report.docx"]);
      expect(res.missingDeliverables).toEqual(["summary.xlsx"]);
    });

    it("Scenario 8: Negated files excluded from expected deliverables results in truthful Completed", () => {
      const prompt = "Update notes.md in the active workspace. Do not modify config.json, unrelated.md, or any other existing file.";
      const expected = detectRequestedDeliverables(prompt);
      expect(expected.map((d) => d.filename)).toEqual(["notes.md"]);

      const produced = new Set(["notes.md"]);
      const res = evaluateCompletionOutcome(expected, produced, false, false, false);
      expect(res.outcome).toBe("completed");
      expect(res.missingDeliverables).toEqual([]);
      expect(res.producedDeliverables).toEqual(["notes.md"]);
    });
  });

  // ── 3. Integration Tests: AgentLoop Lifecycle Scenarios ───────────────────

  describe("AgentLoop Truthful Lifecycle Execution", () => {
    it("completes simple chat query with completed outcome", async () => {
      const loop = new AgentLoop();
      const mockGateway: any = {
        async chatWithTools() {
          return {
            ok: true,
            value: {
              content: "The maximum allowable tube wall thinning under SOP-114 is 15%.",
              tool_calls: null,
            },
          };
        },
      };

      const result = await loop.run({
        runId: "run-simple-chat",
        driverModelId: "draft-qwen3",
        userPrompt: "What is the allowable tube wall thinning under SOP-114?",
        systemPrompt: "You are a helpful assistant.",
        tools: [],
        context: {
          runId: "run-simple-chat",
          workspaceRoot: tempDir,
          gateway: mockGateway,
          emitRunEvent: () => {},
        },
        emitEvent: () => {},
      });

      expect(result.outcome).toBe("completed");
      expect(result.completed).toBe(true);
      expect(result.finalText).toContain("allowable tube wall thinning");
    });

    it("marks partial when model proposes finish without creating requested deliverable", async () => {
      const loop = new AgentLoop();
      const mockGateway: any = {
        async chatWithTools() {
          return {
            ok: true,
            value: {
              content: "I have reviewed the report and here are the findings in chat.",
              tool_calls: null,
            },
          };
        },
      };

      const result = await loop.run({
        runId: "run-missing-docx",
        driverModelId: "draft-qwen3",
        userPrompt: "Draft an approval note in docx format with findings",
        systemPrompt: "You are an assistant.",
        tools: [],
        context: {
          runId: "run-missing-docx",
          workspaceRoot: tempDir,
          gateway: mockGateway,
          emitRunEvent: () => {},
        },
        emitEvent: () => {},
      });

      expect(result.outcome).toBe("partial");
      expect(result.completed).toBe(false);
      expect(result.deliverables?.missing.length).toBeGreaterThan(0);
      expect(result.finalText).toContain("Notice: Execution partially completed");
    });

    it("marks partial when 1 of 2 deliverables is produced", async () => {
      const loop = new AgentLoop();
      let callCount = 0;
      const mockGateway: any = {
        async chatWithTools() {
          callCount++;
          if (callCount === 1) {
            return {
              ok: true,
              value: {
                content: "Generating report.docx",
                tool_calls: [
                  {
                    id: "call_docx",
                    name: "generate_deliverable",
                    arguments: {
                      filename: "report.docx",
                      type: "docx",
                      title: "Report",
                      content: "# Report",
                    },
                  },
                ],
              },
            };
          }
          return {
            ok: true,
            value: {
              content: "Generated report.docx. Excel sheet was omitted.",
              tool_calls: null,
            },
          };
        },
      };

      const mockDeliverableTool: any = {
        name: "generate_deliverable",
        description: "Generates deliverable",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ output: "Generated report.docx successfully." }),
      };

      const result = await loop.run({
        runId: "run-one-of-two",
        driverModelId: "draft-qwen3",
        userPrompt: "Create report.docx and summary.xlsx",
        systemPrompt: "You are an assistant.",
        tools: [mockDeliverableTool],
        context: {
          runId: "run-one-of-two",
          workspaceRoot: tempDir,
          gateway: mockGateway,
          emitRunEvent: () => {},
        },
        emitEvent: () => {},
      });

      expect(result.outcome).toBe("partial");
      expect(result.completed).toBe(false);
      expect(result.deliverables?.produced).toContain("report.docx");
      expect(result.deliverables?.missing).toContain("summary.xlsx");
      expect(result.finalText).toContain("summary.xlsx");
    });

    it("returns limit_exceeded when turn limit is reached", async () => {
      const loop = new AgentLoop();
      let turnCall = 0;
      const mockGateway: any = {
        async chatWithTools() {
          turnCall++;
          return {
            ok: true,
            value: {
              content: `Calling tool turn ${turnCall}`,
              tool_calls: [
                {
                  id: `call_read_${turnCall}`,
                  name: "read_file",
                  arguments: { path: `sample_${turnCall}.txt` },
                },
              ],
            },
          };
        },
      };

      const mockReadTool: any = {
        name: "read_file",
        description: "Read file",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ output: "file contents" }),
      };

      const result = await loop.run({
        runId: "run-limit-exceeded",
        driverModelId: "code-qwen25coder",
        userPrompt: "Process files continuously",
        systemPrompt: "You are an assistant.",
        tools: [mockReadTool],
        context: {
          runId: "run-limit-exceeded",
          workspaceRoot: tempDir,
          gateway: mockGateway,
          emitRunEvent: () => {},
        },
        maxTurns: 3,
        emitEvent: () => {},
      });

      expect(result.outcome).toBe("limit_exceeded");
      expect(result.completed).toBe(false);
      expect(result.turns).toBe(3);
      expect(result.finalText).toContain("Maximum execution turn limit (3 turns) reached");
    });

    it("returns cancelled when user cancels execution", async () => {
      const loop = new AgentLoop();
      let cancelled = false;
      const mockGateway: any = {
        async chatWithTools() {
          cancelled = true; // cancel during first turn
          return {
            ok: true,
            value: {
              content: "Thinking...",
              tool_calls: [
                {
                  id: "call_1",
                  name: "read_file",
                  arguments: { path: "foo.txt" },
                },
              ],
            },
          };
        },
      };

      const mockReadTool: any = {
        name: "read_file",
        description: "Read file",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ output: "data" }),
      };

      const result = await loop.run({
        runId: "run-cancelled",
        driverModelId: "draft-qwen3",
        userPrompt: "Analyze project",
        systemPrompt: "Assistant",
        tools: [mockReadTool],
        context: {
          runId: "run-cancelled",
          workspaceRoot: tempDir,
          gateway: mockGateway,
          emitRunEvent: () => {},
        },
        isCancelled: () => cancelled,
        emitEvent: () => {},
      });

      expect(result.outcome).toBe("cancelled");
      expect(result.completed).toBe(false);
    });

    it("returns failed when unrecoverable tool loop error occurs", async () => {
      const loop = new AgentLoop();
      const mockGateway: any = {
        async chatWithTools() {
          return {
            ok: true,
            value: {
              content: "Calling failing tool",
              tool_calls: [
                {
                  id: "call_err",
                  name: "run_command",
                  arguments: { command: "failing_command" },
                },
              ],
            },
          };
        },
      };

      const mockCommandTool: any = {
        name: "run_command",
        description: "Run command",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ output: "Error: command not found: failing_command" }),
      };

      const result = await loop.run({
        runId: "run-loop-failed",
        driverModelId: "code-qwen25coder",
        userPrompt: "Run command",
        systemPrompt: "Assistant",
        tools: [mockCommandTool],
        context: {
          runId: "run-loop-failed",
          workspaceRoot: tempDir,
          gateway: mockGateway,
          emitRunEvent: () => {},
        },
        emitEvent: () => {},
      });

      expect(result.outcome).toBe("failed");
      expect(result.completed).toBe(false);
      expect(result.finalText).toContain("Execution stopped");
    });
  });

  // ── 4. Persistence & RunManager Transition Verification ──────────────────

  describe("Persistence & Store Truthful Transitions", () => {
    it("transitions and preserves partial and limit_exceeded states in database", () => {
      initDb(path.join(tempDir, "workbench.sqlite"));

      const chat1Id = createChat("Chat 1");
      const runId1 = createRun(chat1Id, "partial run");
      transition(runId1, "planning");
      transition(runId1, "acting");
      transition(runId1, "partial");
      expect(getState(runId1)).toBe("partial");

      // Verify that partial is terminal
      expect(() => transition(runId1, "acting")).toThrow(/run is terminal/);

      const chat2Id = createChat("Chat 2");
      const runId2 = createRun(chat2Id, "limit exceeded run");
      transition(runId2, "planning");
      transition(runId2, "acting");
      transition(runId2, "limit_exceeded");
      expect(getState(runId2)).toBe("limit_exceeded");

      // Verify that limit_exceeded is terminal
      expect(() => transition(runId2, "completed")).toThrow(/run is terminal/);
    });

    it("RunManager dispatches partial and limit_exceeded outcomes correctly", async () => {
      process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
      process.env.WORKBENCH_AGENT_V2 = "true";
      initDb(path.join(tempDir, "workbench.sqlite"));

      const events: RunEvent[] = [];
      const mockGateway = {
        registry: new Map(testModelRegistry().map(model => [model.id, model])),
        inferenceGroupFor: () => "test-inference",
        async execute() { return { ok: true, value: { result: { intentType: "document_drafting", driverModel: "primary-model", taskType: "draft", primaryGoal: "Draft approval note", isActionable: true, chatResponseOnly: false, workspaceMutationRequested: false, targetFiles: [], expectedDeliverables: [{ type: "docx", filename: "approval-note.docx" }] } } }; },
        async chatWithTools() {
          // Model finishes without creating requested docx
          return {
            ok: true,
            value: {
              content: "I answered in text only.",
              tool_calls: null,
            },
          };
        },
        health() {
          return Promise.resolve([]);
        },
      } as unknown as ModelGateway;

      let manager: RunManager;
      manager = new RunManager(mockGateway, (event) => {
        events.push(event);
        if (event.type === "confirmation_required") {
          void manager.confirm({ runId: event.runId, actionId: event.action.actionId, approved: true });
        }
      });
      const started = await manager.start({
        userText: "Draft an approval note in docx format",
        mode: "work",
      });

      // Wait for run_state event indicating terminal state
      await vi.waitFor(() => expect(events.some((e) => e.type === "run_state" && ["partial", "completed", "failed"].includes(e.state))).toBe(true), { timeout: 2000 });

      expect(events.some((e) => e.type === "run_state" && e.state === "partial")).toBe(true);
      expect(getState(started.runId)).toBe("partial");
    });

    it("verifies workspace mutation completes truthfully without classifying updated workspace file as deliverable", () => {
      // Direct evaluateCompletionOutcome verification:
      // notes.md was modified as expected in workspaceContext, expectedDeliverables is empty
      const evalOutcome = evaluateCompletionOutcome(
        [], // expectedDeliverables: empty!
        new Set(["notes.md"]),
        false,
        false,
        false,
        {
          expectedMutations: ["notes.md"],
          actualModifiedFiles: new Set(["notes.md"]),
        },
      );

      expect(evalOutcome.outcome).toBe("completed");
      expect(evalOutcome.missingDeliverables).toEqual([]);
      expect(evalOutcome.producedDeliverables).toEqual([]);
      expect(evalOutcome.missingMutations).toEqual([]);
      expect(evalOutcome.producedMutations).toEqual(["notes.md"]);
    });

    it("evaluates workspace mutation as partial if expected target was not modified", () => {
      const evalOutcome = evaluateCompletionOutcome(
        [],
        new Set(),
        false,
        false,
        false,
        {
          expectedMutations: ["notes.md"],
          actualModifiedFiles: new Set(),
        },
      );

      expect(evalOutcome.outcome).toBe("partial");
      expect(evalOutcome.missingDeliverables).toEqual([]);
      expect(evalOutcome.missingMutations).toEqual(["notes.md"]);
    });
  });
});
