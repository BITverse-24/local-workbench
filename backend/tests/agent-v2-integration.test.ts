import { describe, expect, it, vi, afterEach } from "vitest";
import { RunManager } from "../src/main/run/manager.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import type { RunEvent } from "../src/shared/contracts.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { getRunContract } from "../src/main/run/contract.js";
import { writeRunFile } from "../src/main/run/filesystem.js";

describe("Unified Agent Loop v2 RunManager Integration", () => {
  let tempDir = "";
  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    delete process.env.WORKBENCH_AGENT_V2;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("executes unified agent loop when WORKBENCH_AGENT_V2 is active", async () => {
    tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-v2-run-"));
    process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
    process.env.WORKBENCH_AGENT_V2 = "true";
    initDb(path.join(tempDir, "workbench.sqlite"));

    const events: RunEvent[] = [];

    const mockGateway = {
      async execute() { return { ok: true, value: { result: { intentType: "general_qa", driverModel: "draft-qwen3", taskType: "draft", primaryGoal: "Calculate thermal efficiency", isActionable: false, chatResponseOnly: true, workspaceMutationRequested: false, targetFiles: [], expectedDeliverables: [] } } }; },
      async chatWithTools() {
        return {
          ok: true,
          value: {
            content: "Thermal efficiency calculation is complete. Result is 88.4%.",
            tool_calls: null,
          },
        };
      },
      health() {
        return Promise.resolve([]);
      },
    } as unknown as ModelGateway;

    const manager = new RunManager(mockGateway, (event) => events.push(event));
    const started = await manager.start({ userText: "Calculate thermal efficiency" });

    // Wait for completed state
    await vi.waitFor(() => expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true), { timeout: 2000 });

    // Verify routing and thinking events
    expect(events.some((e) => e.type === "routing" && e.modelId === "draft-qwen3")).toBe(true);
    expect(events.some((e) => e.type === "agent_thinking")).toBe(true);
    expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
    expect(getRunContract(started.runId)?.objective).toBe("Calculate thermal efficiency");

    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    delete process.env.WORKBENCH_AGENT_V2;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses a persisted contract and native result retrieval through the active V2 loop without classification", async () => {
    tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-v2-memory-"));
    process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data"); process.env.WORKBENCH_AGENT_V2 = "true";
    initDb(path.join(tempDir, "workbench.sqlite"));
    let turns = 0, classifications = 0;
    let resultId = "";
    const events: RunEvent[] = [];
    const gateway = {
      async execute() { classifications++; return { ok: true, value: { result: { intentType: "file_inspection", primaryGoal: "Explain stored facts", isActionable: false, chatResponseOnly: true, workspaceMutationRequested: false, targetFiles: [], expectedDeliverables: [] } } }; },
      async chatWithTools(_model: unknown, messages: any[], tools: any[], options: { runId: string }) {
        turns++;
        if (turns === 1) {
          expect(tools.some((t) => t.function.name === "retrieve_result")).toBe(false);
          writeRunFile(options.runId, "intermediate", "facts.txt", Array.from({ length: 700 }, (_, line) => `fact ${line}: preserved-${line}`).join("\n"));
          return { ok: true, value: { content: null, tool_calls: [{ id: "read", name: "read_file", arguments: { path: "facts.txt" } }] } };
        }
        if (turns === 2) {
          expect(tools.some((t) => t.function.name === "retrieve_result")).toBe(true);
          const observation = messages.find((m) => m.tool_call_id === "read").content;
          resultId = observation.match(/DURABLE RESULT: ([0-9a-f-]{36})/)[1];
          expect(observation).not.toContain("fact 350:");
          return { ok: true, value: { content: null, tool_calls: [{ id: "recover", name: "retrieve_result", arguments: { result_id: resultId, mode: "lines", start_line: 351, count: 1 } }] } };
        }
        expect(messages.find((m) => m.tool_call_id === "recover").content).toContain("fact 350: preserved-350");
        return { ok: true, value: { content: "The stored source says fact 350: preserved-350.", tool_calls: null } };
      }, health: async () => [],
    } as unknown as ModelGateway;
    const manager = new RunManager(gateway, (e) => events.push(e));
    const { runId } = await manager.start({ userText: "Explain the source facts in chat; do not create deliverables." });
    await vi.waitFor(() => expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true), { timeout: 3000 });
    expect(classifications).toBe(0);
    expect(turns).toBe(3);
    expect(resultId).toMatch(/^[0-9a-f-]{36}$/);
    expect(getRunContract(runId)?.deliverables).toEqual([]);
    expect(events.some((e) => e.type === "artifact_ready")).toBe(false);
  });

  it("pauses before driver generation with plan_approval and resumes after confirmation", async () => {
    tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-v2-plan-"));
    process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
    process.env.WORKBENCH_AGENT_V2 = "true";
    initDb(path.join(tempDir, "workbench.sqlite"));

    const events: RunEvent[] = [];
    let callTurn = 0;

    const mockGateway = {
      async execute() { return { ok: true, value: { result: { intentType: "code_modification", driverModel: "code-qwen25coder", taskType: "code", primaryGoal: "Write temp.txt", isActionable: true, chatResponseOnly: false, workspaceMutationRequested: true, targetFiles: ["temp.txt"], expectedDeliverables: [] } } }; },
      async chatWithTools(_model: unknown, messages: any[]) {
        expect(messages[0].content).not.toContain("then validate the written implementation");
        callTurn++;
        if (callTurn === 1) {
          return {
            ok: true,
            value: {
              content: "To write temp.txt, I will:\n1. Inspect directory contents\n2. Write the requested file",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "temp.txt", content: "written content" }),
                  },
                },
              ],
            },
          };
        }
        return {
          ok: true,
          value: {
            content: "Requested file written successfully.",
            tool_calls: null,
          },
        };
      },
      health() {
        return Promise.resolve([]);
      },
    } as unknown as ModelGateway;

    const manager = new RunManager(mockGateway, (event) => events.push(event));
    const started = await manager.start({ userText: "Write temp.txt in the current workspace" });

    // Wait for confirmation_required event
    let confirmationEvent: any = null;
    await vi.waitFor(() => {
      confirmationEvent = events.find((e) => e.type === "confirmation_required");
      expect(confirmationEvent).toBeDefined();
    }, { timeout: 2000 });

    // Verify it is strictly plan_approval, NOT execute_python
    expect(confirmationEvent).toBeDefined();
    expect(confirmationEvent.action.kind).toBe("plan_approval");
    expect(confirmationEvent.action.preview).toContain("temp.txt");
    expect(callTurn).toBe(0);

    // State should be awaiting_confirmation
    expect(events.some((e) => e.type === "run_state" && e.state === "awaiting_confirmation")).toBe(true);

    // Confirm the plan
    await manager.confirm({
      runId: started.runId,
      actionId: confirmationEvent.action.actionId,
      approved: true,
    });

    // Wait for completed state
    await vi.waitFor(() => expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true), { timeout: 2000 });

    expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
    expect(events.some((e) => e.type === "assistant_message" && (e as any).text.includes("Requested file written successfully"))).toBe(true);
    expect(events.some((e) => e.type === "artifact_ready")).toBe(false);

    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    delete process.env.WORKBENCH_AGENT_V2;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("bypasses confirmation gate when turn 1 tool calls are strictly read-only", async () => {
    tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-v2-readonly-"));
    process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
    process.env.WORKBENCH_AGENT_V2 = "true";
    initDb(path.join(tempDir, "workbench.sqlite"));

    const events: RunEvent[] = [];
    let callTurn = 0;

    const mockGateway = {
      async execute() { return { ok: true, value: { result: { intentType: "file_inspection", driverModel: "code-qwen25coder", taskType: "code", primaryGoal: "Search syntax errors", isActionable: false, chatResponseOnly: false, workspaceMutationRequested: false, targetFiles: [], expectedDeliverables: [] } } }; },
      async chatWithTools() {
        callTurn++;
        if (callTurn === 1) {
          return {
            ok: true,
            value: {
              content: "I will search the repository and list the files.",
              tool_calls: [
                {
                  id: "call_search",
                  type: "function",
                  function: {
                    name: "search",
                    arguments: JSON.stringify({ query: "SyntaxError" }),
                  },
                },
              ],
            },
          };
        }
        return {
          ok: true,
          value: {
            content: "Analysis completed with no mutating changes needed.",
            tool_calls: null,
          },
        };
      },
      health() {
        return Promise.resolve([]);
      },
    } as unknown as ModelGateway;

    const manager = new RunManager(mockGateway, (event) => events.push(event));
    await manager.start({ userText: "Search for syntax errors" });

    // Wait for completed state
    await vi.waitFor(() => expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true), { timeout: 2000 });

    // Verify confirmation_required was NEVER emitted
    expect(events.some((e) => e.type === "confirmation_required")).toBe(false);
    expect(events.some((e) => e.type === "run_state" && e.state === "awaiting_confirmation")).toBe(false);
    expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
    expect(events.some((e) => e.type === "assistant_message" && (e as any).text.includes("Analysis completed"))).toBe(true);

    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    delete process.env.WORKBENCH_AGENT_V2;
    rmSync(tempDir, { recursive: true, force: true });
  });
});
