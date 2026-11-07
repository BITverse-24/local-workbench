import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { setDataDir, createRunDirectories, runRoot } from "../src/main/run/filesystem.js";
import { createWorkFacade } from "../src/main/run/work-exec/work-facade.js";
import { runWorkScript } from "../src/main/run/work-exec/work-sandbox.js";
import { workExecTool } from "../src/main/run/work-exec/work-exec-tool.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";

describe("Work Mode Code Mode: WorkFacade & Sandbox", () => {
  let tempDir: string;
  let runId: string;
  let gateway: ModelGateway;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "work-exec-test-"));
    setDataDir(tempDir);
    initDb(path.join(tempDir, "db.sqlite"));
    const chatId = createChat();
    runId = createRun(chatId, "Work test");
    createRunDirectories(runId);
    gateway = new ModelGateway();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads attached CSV tables into structured row objects", async () => {
    const inputDir = path.join(runRoot(runId), "input");
    mkdirSync(inputDir, { recursive: true });

    const csvContent = "Category,Item,Quantity,UnitCost\nWidgets,Widget A,10,2.5\nWidgets,Widget B,20,5.0\nGadgets,Gadget X,5,15.0\n";
    writeFileSync(path.join(inputDir, "inventory.csv"), csvContent);

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
      inputSources: [
        {
          id: "src-1",
          filename: "inventory.csv",
          relativePath: `runs/${runId}/input/inventory.csv`,
          sha256: "0".repeat(64),
        },
      ],
    };

    const facade = createWorkFacade(context);
    const rows = await facade.readTable("inventory.csv");

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      Category: "Widgets",
      Item: "Widget A",
      Quantity: "10",
      UnitCost: "2.5",
    });
    expect(rows[2].Item).toBe("Gadget X");
  });

  it("filters and aggregates table data inside QuickJS script", async () => {
    const inputDir = path.join(runRoot(runId), "input");
    mkdirSync(inputDir, { recursive: true });

    const csvContent = "Category,Revenue,Costs\nElectronics,1000,600\nClothing,500,200\nElectronics,1500,800\nFood,300,250\n";
    writeFileSync(path.join(inputDir, "sales.csv"), csvContent);

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
      inputSources: [
        {
          id: "src-sales",
          filename: "sales.csv",
          relativePath: `runs/${runId}/input/sales.csv`,
          sha256: "0".repeat(64),
        },
      ],
    };

    const facade = createWorkFacade(context);
    const script = `
      const rows = await readTable("sales.csv");
      let totalElectronicsNet = 0;
      for (const row of rows) {
        if (row.Category === "Electronics") {
          totalElectronicsNet += (Number(row.Revenue) - Number(row.Costs));
        }
      }
      text("Electronics Net: " + totalElectronicsNet);
    `;

    const result = await runWorkScript(script, facade);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Electronics Net: 1100");
  });

  it("reads structured JSON files directly into JavaScript objects", async () => {
    const inputDir = path.join(runRoot(runId), "input");
    mkdirSync(inputDir, { recursive: true });

    const jsonPayload = {
      project: "Apollo",
      metrics: {
        velocity: 42.5,
        sprintsCompleted: 8,
      },
      tags: ["active", "q3"],
    };
    writeFileSync(path.join(inputDir, "config.json"), JSON.stringify(jsonPayload));

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
      inputSources: [
        {
          id: "src-cfg",
          filename: "config.json",
          relativePath: `runs/${runId}/input/config.json`,
          sha256: "0".repeat(64),
        },
      ],
    };

    const facade = createWorkFacade(context);
    const script = `
      const config = await readJson("config.json");
      text(config.project + " velocity: " + config.metrics.velocity);
    `;

    const result = await runWorkScript(script, facade);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Apollo velocity: 42.5");
  });

  it("programmatically emits deliverable files via emitDeliverable", async () => {
    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
      resultStore: new RunResultStore(runId),
    };

    const facade = createWorkFacade(context);
    const script = `
      const rows = [
        ["Product", "Units", "Total"],
        ["Alpha", 10, 100],
        ["Beta", 20, 300]
      ];
      const csv = rows.map(r => r.join(",")).join("\\n");
      await emitDeliverable({
        type: "csv",
        filename: "summary.csv",
        content: csv
      });
      text("Deliverable created");
    `;

    const result = await runWorkScript(script, facade);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Deliverable created");
    expect(result.executedDeliverables).toHaveLength(1);
    expect(result.executedDeliverables[0].filename).toBe("summary.csv");
  });

  it("executes work_exec tool and records intermediate result in ResultStore", async () => {
    const inputDir = path.join(runRoot(runId), "input");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(path.join(inputDir, "data.txt"), "Line 1: 10\nLine 2: 20\nLine 3: 30\n");

    const resultStore = new RunResultStore(runId);
    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
      resultStore,
      inputSources: [
        {
          id: "src-txt",
          filename: "data.txt",
          relativePath: `runs/${runId}/input/data.txt`,
          sha256: "0".repeat(64),
        },
      ],
    };

    const script = `
      const textData = await readText("data.txt");
      const lines = textData.trim().split("\\n");
      let sum = 0;
      for (const line of lines) {
        sum += Number(line.split(":")[1].trim());
      }
      text("Sum: " + sum);
    `;

    const toolResult = await workExecTool.execute({ script }, context);
    expect(toolResult.ok).toBe(true);
    expect(toolResult.output).toBe("Sum: 60");

    const storedResults = resultStore.listResults();
    expect(storedResults.length).toBeGreaterThan(0);
    const execResult = storedResults.find((r) => r.producer.tool === "work_exec");
    expect(execResult).toBeDefined();
    expect(execResult?.origin).toBe("execution");
    expect(execResult?.status).toBe("complete");
  });
});
