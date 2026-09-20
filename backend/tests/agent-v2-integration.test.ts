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
});
