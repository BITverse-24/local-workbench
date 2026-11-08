import { describe, it, expect, vi } from "vitest";
import { runSandboxedScript } from "../src/main/agent/exec/sandbox.js";
import type { ReadFacade } from "../src/main/agent/exec/facade.js";

function createMockFacade(overrides: Partial<ReadFacade> = {}): ReadFacade {
  return {
    readFile: vi.fn().mockResolvedValue({
      content: "file content here",
      complete: true,
      digest: "sha256-mock",
      totalBytes: 17,
    }),
    search: vi.fn().mockResolvedValue([
      { path: "src/auth.ts", line: 12, text: "const token = auth();" },
    ]),
    listDir: vi.fn().mockResolvedValue(["auth.ts", "user.ts", "index.ts"]),
    readInput: vi.fn().mockResolvedValue({ text: "input text", pages: 1 }),
    extractDocument: vi.fn().mockResolvedValue({ text: "doc text" }),
    retrieveKnowledge: vi.fn().mockResolvedValue([
      { filename: "sop.md", page: 1, text: "procedure text" },
    ]),
    result: vi.fn().mockResolvedValue({ content: "result data" }),
    getCallCount: vi.fn().mockReturnValue(0),
    getDiscoveredDigests: vi.fn().mockReturnValue(new Set(["sha256-mock"])),
    getExecutedTools: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe("QuickJS Sandbox Execution", () => {
  it("executes code that invokes tools and returns text() output", async () => {
    const facade = createMockFacade();
    const script = `
      const list = await tools.listDir(".");
      const file = await tools.readFile("src/index.ts");
      text("Read " + list.length + " files, content: " + file.content);
    `;

    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("Read 3 files, content: file content here");
    expect(res.toolCalls).toHaveLength(0); // executedTools on mock facade
    expect(facade.listDir).toHaveBeenCalledWith(".", undefined);
    expect(facade.readFile).toHaveBeenCalledWith("src/index.ts", undefined);
  });

  it("handles Promise.all for concurrent tool execution", async () => {
    const facade = createMockFacade();
    const script = `
      const [f1, f2] = await Promise.all([
        tools.readFile("a.ts"),
        tools.readFile("b.ts")
      ]);
      text("Lengths: " + f1.content.length + ", " + f2.content.length);
    `;

    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("Lengths: 17, 17");
    expect(facade.readFile).toHaveBeenCalledTimes(2);
  });

  it("enforces complete isolation with zero access to Node globals", async () => {
    const facade = createMockFacade();
    const script = `
      const hasProcess = typeof process !== 'undefined';
      const hasRequire = typeof require !== 'undefined';
      const hasFetch = typeof fetch !== 'undefined';
      text(JSON.stringify({ hasProcess, hasRequire, hasFetch }));
    `;

    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.output)).toEqual({
      hasProcess: false,
      hasRequire: false,
      hasFetch: false,
    });
  });

  it("captures syntax errors cleanly with kind 'syntax'", async () => {
    const facade = createMockFacade();
    const script = `const a = ;`;

    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("syntax");
  });

  it("captures runtime errors cleanly with kind 'runtime'", async () => {
    const facade = createMockFacade();
    const script = `
      const obj = null;
      obj.missingMethod();
    `;

    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("runtime");
    expect(res.error?.message).toContain("null");
  });

  it("interrupts infinite loops and enforces execution timeout", async () => {
    const facade = createMockFacade();
    const script = `
      while (true) {}
    `;

    const res = await runSandboxedScript(script, facade, { timeoutMs: 100 });
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("timeout");
    expect(res.durationMs).toBeGreaterThanOrEqual(90);
  });

  it("stops execution immediately on cancellation signal", async () => {
    const facade = createMockFacade({
      readFile: vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { content: "late", complete: true, digest: "d", totalBytes: 4 };
      }),
    });
    const controller = new AbortController();
    const script = `
      await tools.readFile("slow.ts");
      text("done");
    `;

    setTimeout(() => controller.abort(), 10);
    const res = await runSandboxedScript(script, facade, {
      timeoutMs: 3000,
      signal: controller.signal,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("timeout");
    expect(res.error?.message).toContain("signal");
  });

  it("handles explicit escalate() calls", async () => {
    const facade = createMockFacade();
    const script = `
      escalate("Task is too complex for batch script; need single turns.");
    `;

    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(false);
    expect(res.escalated).toBe(true);
    expect(res.error?.kind).toBe("escalated");
    expect(res.error?.message).toContain("too complex");
  });

  it("handles imports and stripped module headers gracefully", async () => {
    const facade = createMockFacade();
    const script = `
      import { listDir } from 'tools';
      const files = await listDir('.');
      text("Found: " + files.join(", "));
    `;

    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("Found: auth.ts, user.ts, index.ts");
  });

  it("truncates outputs that exceed maxOutputChars", async () => {
    const facade = createMockFacade();
    const script = `
      text("A".repeat(500));
    `;

    const res = await runSandboxedScript(script, facade, { maxOutputChars: 100 });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("[truncated: 400 chars omitted]");
    expect(res.output.startsWith("A".repeat(100))).toBe(true);
  });

  it("supports console.log and uses it as fallback when text() is not called", async () => {
    const facade = createMockFacade();
    const script = `
      console.log("Found entry:", "index.ts");
    `;

    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("Found entry: index.ts");
  });

  it("handles multi-line text(JSON.stringify({...}, null, 2)) without syntax error", async () => {
    const facade = createMockFacade();
    const script = `
      const inventoryRows = parseCSV("sku,current_stock\\nSKU-101,35\\nSKU-201,22");
      const stockBySku = groupBy(inventoryRows, row => row.sku);
      const summedStock = Object.keys(stockBySku).map(sku => {
        const skuRows = stockBySku[sku];
        const totalStock = skuRows.reduce((sum, row) => sum + (Number(row.stock) || 0), 0);
        return { sku, totalStock };
      });

      text(JSON.stringify({
        inventorySummary: summedStock,
        totalRows: inventoryRows.length
      }, null, 2));
    `;

    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.totalRows).toBe(2);
    expect(parsed.inventorySummary).toEqual([
      { sku: "SKU-101", totalStock: 35 },
      { sku: "SKU-201", totalStock: 22 }
    ]);
  });
});
