import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
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
      Quantity: 10,
      UnitCost: 2.5,
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

  it("leverages preloaded analysis helpers (groupBy, sum, round, smartTruncate) in work_exec", async () => {
    const inputDir = path.join(runRoot(runId), "input");
    mkdirSync(inputDir, { recursive: true });

    const csvContent = [
      "item,category,qty,unit_price",
      "Apple,Fruit,10,1.50",
      "Banana,Fruit,25,0.80",
      "Carrot,Vegetable,15,0.95",
      "Broccoli,Vegetable,8,2.20"
    ].join("\n");
    writeFileSync(path.join(inputDir, "inventory.csv"), csvContent);

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
      inputSources: [
        {
          id: "src-inv",
          filename: "inventory.csv",
          relativePath: `runs/${runId}/input/inventory.csv`,
          sha256: "0".repeat(64),
        },
      ],
    };

    const script = `
      const rows = await readTable("inventory.csv");
      const byCat = groupBy(rows, "category");
      const fruitValue = sum(byCat["Fruit"], r => Number(r.qty) * Number(r.unit_price));
      const vegValue = sum(byCat["Vegetable"], r => Number(r.qty) * Number(r.unit_price));
      const total = round(fruitValue + vegValue, 2);
      text(JSON.stringify({ fruitValue, vegValue, total }));
    `;

    const facade = createWorkFacade(context);
    const result = await runWorkScript(script, facade);
    expect(result.ok).toBe(true);
    const summary = JSON.parse(result.output);
    expect(summary.fruitValue).toBe(35); // 15 + 20
    expect(summary.vegValue).toBe(31.85); // 14.25 + 17.6
    expect(summary.total).toBe(66.85);
  });

  it("auto-repairs variable shadowing and TDZ initialization in work_exec tool", async () => {
    const { workExecTool } = await import("../src/main/run/work-exec/work-exec-tool.js");
    const runId = randomUUID();
    const inputDir = path.join(runRoot(runId), "input");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(path.join(inputDir, "targets.json"), JSON.stringify({ Engineering: { Cloud: 5000 } }));

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
      inputSources: [
        {
          id: "src-targets",
          filename: "targets.json",
          relativePath: `runs/${runId}/input/targets.json`,
          sha256: "0".repeat(64),
        },
      ],
    };

    // Script with variable shadowing: outer `const budget = await readJson(...)`
    // and inner `const budget = budget['Engineering']['Cloud']`
    const shadowingScript = `
      const budget = await readJson('targets.json');
      function compute() {
        const budget = budget['Engineering']['Cloud'];
        return budget * 2;
      }
      text(String(compute()));
    `;

    const res = await workExecTool.execute({ script: shadowingScript }, context);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("10000");
  });

  it("auto-awaits top-level un-awaited async function invocations and IIFEs", async () => {
    const { workExecTool } = await import("../src/main/run/work-exec/work-exec-tool.js");
    const runId = randomUUID();
    const inputDir = path.join(runRoot(runId), "input");
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(path.join(inputDir, "data.json"), JSON.stringify({ count: 42 }));

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
      inputSources: [
        {
          id: "src-data",
          filename: "data.json",
          relativePath: `runs/${runId}/input/data.json`,
          sha256: "0".repeat(64),
        },
      ],
    };

    // Script where top-level call to async function omits 'await'
    const unawaitedScript = `
      async function processData() {
        const d = await readJson('data.json');
        await emitDeliverable({ filename: 'out.txt', content: 'Count is ' + d.count });
        console.log('Processed ' + d.count);
      }
      processData();
    `;

    const res = await workExecTool.execute({ script: unawaitedScript }, context);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("Processed 42");
    const outPath = path.join(runRoot(runId), "output", "out.txt");
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, "utf8")).toBe("Count is 42");
  });

  it("captures returned values from async functions when text() is not explicitly called", async () => {
    const { workExecTool } = await import("../src/main/run/work-exec/work-exec-tool.js");
    const runId = randomUUID();
    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
      inputSources: [],
    };

    const scriptWithReturn = `
      async function computeSummary() {
        return "Total cleared: $221,000.00";
      }
      await computeSummary();
    `;

    const res = await workExecTool.execute({ script: scriptWithReturn }, context);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("Total cleared: $221,000.00");
  });

  it("diagnoses filterToolsForTurn for Work Mode", async () => {
    const { getAllAvailableTools, filterToolsForTurn } = await import("../src/main/router/tool-compositor.js");
    const { buildExecutionEnvelope } = await import("../src/main/run/envelope.js");

    const envelope = buildExecutionEnvelope({
      runId: "test-run",
      mode: "work",
      modelId: "primary-model",
      hasWorkspace: false,
      attachments: [{ filename: "general-ledger.csv" }, { filename: "budget-targets.json" }] as any,
      hasKnowledgeBaseDocs: false,
      computationRequested: true,
      deliverableRequested: true,
    });
    envelope.activeCapabilities = [...envelope.permittedCapabilities];
    const tools = getAllAvailableTools("primary-model").filter((t) => !["write_file", "delete_file", "run_command"].includes(t.name));
    const active = filterToolsForTurn(tools, envelope, new Set(envelope.activeCapabilities));
    expect(active.length).toBeGreaterThan(0);
  });

  it("handles case-insensitive and semantic aliasing in parseCSV row proxies", async () => {
    const facade = createWorkFacade({
      runId,
      workspaceRoot: runRoot(runId),
      gateway,
    });
    const script = `
      const csv = "sku,current_stock,reorder_threshold\\nSKU-101,15,50\\nSKU-102,40,80";
      const rows = parseCSV(csv);
      // Test case insensitivity (SKU vs sku)
      const skuUpper = rows[0].SKU;
      const skuLower = rows[0].sku;
      // Test semantic alias (stock vs current_stock)
      const stock = rows[0].stock;
      // Test camelCase alias (reorderThreshold vs reorder_threshold)
      const threshold = rows[0].reorderThreshold;
      text(JSON.stringify({ skuUpper, skuLower, stock, threshold }));
    `;
    const res = await runWorkScript(script, facade);
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.output as string);
    expect(parsed.skuUpper).toBe("SKU-101");
    expect(parsed.skuLower).toBe("SKU-101");
    expect(parsed.stock).toBe(15);
    expect(parsed.threshold).toBe(50);
  });

  it("extractScriptCode normalizes parseCSV(...).slice(1) to avoid dropping row 0", async () => {
    const { extractScriptCode } = await import("../src/main/agent/exec/exec-step.js");
    const script = "const rows = parseCSV(catalog.content).slice(1); // Skip header\\ntext(rows.length);";
    const cleaned = extractScriptCode(script);
    expect(cleaned).toBe("const rows = parseCSV(catalog.content); // Skip header\\ntext(rows.length);");
  });

  it("reads workspace CSV tables when workspaceRoot is provided in work_exec", async () => {
    const wsDir = path.join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(path.join(wsDir, "inventory.csv"), "sku,current_stock\nSKU-101,15\nSKU-102,40\n");

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: wsDir,
      gateway,
    };

    const res = await workExecTool.execute({
      script: `
        const rows = await readTable("inventory.csv");
        const total = sum(rows, "current_stock");
        text(total);
      `
    }, context);

    expect(res.ok).toBe(true);
    expect(res.output).toBe("55");
  });

  it("supports tools.import and fs/csv compatibility shims in work_exec", async () => {
    const wsDir = path.join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(path.join(wsDir, "test.csv"), "sku,qty\nSKU-1,10\nSKU-2,20\n");

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: wsDir,
      gateway,
    };

    const script = `
      const fs = await tools.import("fs");
      const csv = await tools.import("csv");
      const fileContent = await fs.promises.readFile("test.csv");
      const rows = csv.parse(fileContent);
      text("Parsed " + rows.length + " rows");
    `;

    const res = await workExecTool.execute({ script }, context);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("Parsed 2 rows");
  });

  it("handles await import('fs') and await import('work_exec') destructuring seamlessly", async () => {
    const wsDir = path.join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(path.join(wsDir, "orders.csv"), "sku,qty\nSKU-A,5\nSKU-B,15\n");

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: wsDir,
      gateway,
    };

    const script = `
      const fs = await import('fs');
      const { readTable, toCSV, emitDeliverable } = await import('work_exec');

      const rows = await readTable('orders.csv');
      const total = sum(rows, 'qty');
      text('Total: ' + total);
    `;

    const res = await workExecTool.execute({ script }, context);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("Total: 20");
  });

  it("handles synchronous readFileSync and parse without module imports", async () => {
    const wsDir = path.join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(path.join(wsDir, "data.csv"), "colA,colB\n10,20\n30,40\n");

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: wsDir,
      gateway,
    };

    const script = `
      import { readFileSync } from 'fs';
      import { parse } from 'csv-parse';

      const content = readFileSync('data.csv', 'utf-8');
      const rows = parse(content);
      text('Rows: ' + rows.length);
    `;

    const res = await workExecTool.execute({ script }, context);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("Rows: 2");
  });

  it("handles multi-line text({...}); and array.unique() prototype method chaining", async () => {
    const wsDir = path.join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(path.join(wsDir, "sample.csv"), "sku,cat\nS1,A\nS2,B\nS3,A\n");

    const context: ToolExecutionContext = {
      runId,
      workspaceRoot: wsDir,
      gateway,
    };

    const script = `
      const rows = await readTable("sample.csv");
      const cats = rows.map(r => r.cat).unique();
      text({
        count: rows.length,
        cats: cats
      });
    `;

    const res = await workExecTool.execute({ script }, context);
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.count).toBe(3);
    expect(parsed.cats).toEqual(["A", "B"]);
  });

  it("supports groupBy chaining (.map, .entries, .values) and proxy property access", async () => {
    const facade = createWorkFacade({ runId: "test-run", workspaceRoot: "/tmp" } as any);
    const script = `
      const rows = [
        { sku: "SKU-101", region: "NA", sales: 100 },
        { sku: "SKU-101", region: "EU", sales: 150 },
        { sku: "SKU-201", region: "NA", sales: 200 }
      ];
      const bySku = groupBy(rows, r => r.sku);
      
      // Test .entries()
      const entries = bySku.entries();
      
      // Test .values()
      const values = bySku.values();
      
      // Test .map() on groups with group item property access
      const mapped = bySku.map(group => {
        return {
          sku: group.sku,
          totalSales: group.reduce((acc, r) => acc + r.sales, 0),
          count: group.length
        };
      });

      // Test parseCSV unwrapping object with .content
      const parsedFromObj = parseCSV({ content: "colA,colB\\n1,2\\n3,4" });

      text(JSON.stringify({
        entriesCount: entries.length,
        valuesCount: values.length,
        mapped,
        parsedRows: parsedFromObj.length
      }));
    `;

    const res = await runWorkScript(script, facade);
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.output as string);
    expect(parsed.entriesCount).toBe(2);
    expect(parsed.valuesCount).toBe(2);
    expect(parsed.mapped).toEqual([
      { sku: "SKU-101", totalSales: 250, count: 2 },
      { sku: "SKU-201", totalSales: 200, count: 1 }
    ]);
    expect(parsed.parsedRows).toBe(2);
  });

  it("supports join() and unit_price aliases across relational datasets", async () => {
    const facade = createWorkFacade({ runId: "test-run-join", workspaceRoot: "/tmp" } as any);
    const script = `
      const catalog = [
        { sku: "SKU-101", category: "Electronics", reorder_threshold: 50 },
        { sku: "SKU-201", category: "Apparel", reorder_threshold: 40 }
      ];
      const sales = [
        { order_id: "O-1", sku: "SKU-101", region: "NA", quantity: 5, unit_price: 20 },
        { order_id: "O-2", sku: "SKU-101", region: "EU", quantity: 3, unit_price: 20 },
        { order_id: "O-3", sku: "SKU-201", region: "NA", quantity: 10, unit_price: 15 }
      ];

      // Join sales with catalog by sku
      const joined = join(sales, catalog, "sku");

      // Test aliased revenue (computed: quantity * unit_price)
      const totalRevenue = sum(joined, "revenue");
      const samplePrice = joined[0].price; // unit_price alias

      text(JSON.stringify({
        joinedCount: joined.length,
        firstCategory: joined[0].category,
        firstRegion: joined[0].region,
        totalRevenue,
        samplePrice
      }));
    `;

    const res = await runWorkScript(script, facade);
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.output as string);
    expect(parsed.joinedCount).toBe(3);
    expect(parsed.firstCategory).toBe("Electronics");
    expect(parsed.firstRegion).toBe("NA");
    expect(parsed.totalRevenue).toBe(310);
    expect(parsed.samplePrice).toBe(20);
  });
});
