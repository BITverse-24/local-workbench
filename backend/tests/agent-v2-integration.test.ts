import { describe, expect, it } from "vitest";
import { RunManager } from "../src/main/run/manager.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import type { RunEvent } from "../src/shared/contracts.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

describe("Unified Agent Loop v2 RunManager Integration", () => {
  let tempDir = "";

  it("executes unified agent loop when WORKBENCH_AGENT_V2 is active", async () => {
    tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-v2-run-"));
    process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
    process.env.WORKBENCH_AGENT_V2 = "true";
    initDb(path.join(tempDir, "workbench.sqlite"));

    const events: RunEvent[] = [];

    const mockGateway = {
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
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (events.some((e) => e.type === "run_state" && e.state === "completed")) {
          clearInterval(interval);
          resolve(true);
        }
      }, 20);
    });

    // Verify routing and thinking events
    expect(events.some((e) => e.type === "routing" && e.modelId === "draft-qwen3")).toBe(true);
    expect(events.some((e) => e.type === "agent_thinking")).toBe(true);
    expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);

    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    delete process.env.WORKBENCH_AGENT_V2;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("pauses on turn 1 tool calls with kind 'plan_approval' (not execute_python) and resumes upon confirmation", async () => {
    tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-v2-plan-"));
    process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
    process.env.WORKBENCH_AGENT_V2 = "true";
    initDb(path.join(tempDir, "workbench.sqlite"));

    const events: RunEvent[] = [];
    let callTurn = 0;

    const mockGateway = {
      async chatWithTools() {
        callTurn++;
        if (callTurn === 1) {
          return {
            ok: true,
            value: {
              content: "To delete the files in the current workspace, I will:\n1. Inspect directory contents\n2. Clean up files",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "list_dir",
                    arguments: "{}",
                  },
                },
              ],
            },
          };
        }
        return {
          ok: true,
          value: {
            content: "Workspace cleaned up successfully.",
            tool_calls: null,
          },
        };
      },
      health() {
        return Promise.resolve([]);
      },
    } as unknown as ModelGateway;

    const manager = new RunManager(mockGateway, (event) => events.push(event));
    const started = await manager.start({ userText: "Delete the files in the current workspace" });

    // Wait for confirmation_required event
    let confirmationEvent: any = null;
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        const found = events.find((e) => e.type === "confirmation_required");
        if (found) {
          confirmationEvent = found;
          clearInterval(interval);
          resolve(true);
        }
      }, 20);
    });

    // Verify it is strictly plan_approval, NOT execute_python
    expect(confirmationEvent).toBeDefined();
    expect(confirmationEvent.action.kind).toBe("plan_approval");
    expect(confirmationEvent.action.preview).toContain("To delete the files in the current workspace");

    // State should be awaiting_confirmation
    expect(events.some((e) => e.type === "run_state" && e.state === "awaiting_confirmation")).toBe(true);

    // Confirm the plan
    await manager.confirm({
      runId: started.runId,
      actionId: confirmationEvent.action.actionId,
      approved: true,
    });

    // Wait for completed state
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (events.some((e) => e.type === "run_state" && e.state === "completed")) {
          clearInterval(interval);
          resolve(true);
        }
      }, 20);
    });

    expect(events.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
    expect(events.some((e) => e.type === "assistant_message" && (e as any).text.includes("Workspace cleaned up successfully"))).toBe(true);

    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    delete process.env.WORKBENCH_AGENT_V2;
    rmSync(tempDir, { recursive: true, force: true });
  });
});
