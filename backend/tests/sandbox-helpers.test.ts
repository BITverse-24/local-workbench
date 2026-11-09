import { describe, it, expect } from "vitest";
import { runSandboxedScript } from "../src/main/agent/exec/sandbox.js";
import { smartTruncate } from "../src/main/agent/exec/smart-truncate.js";
import type { ReadFacade } from "../src/main/agent/exec/facade.js";

function createMockFacade(): ReadFacade {
  return {
    readFile: async () => ({ content: "", complete: true, digest: "d", totalBytes: 0 }),
    search: async () => [],
    listDir: async () => [],
    readInput: async () => ({ text: "", pages: 0 }),
    extractDocument: async () => ({ text: "" }),
    retrieveKnowledge: async () => [],
    result: async () => ({ content: "" }),
    getCallCount: () => 0,
    getDiscoveredDigests: () => [],
    getExecutedTools: () => [],
  };
}

describe("Sandbox Preloaded Data Utilities", () => {
  const facade = createMockFacade();

  it("parses CSV with headers, quotes, commas, and automatic type casting", async () => {
    const script = `
      const raw = 'name,dept,"annual_salary",active\\n"Alice, Jr.",Engineering,125000.50,true\\nBob,Design,95000,false\\nCharlie,Engineering,110000,true\\n';
      const parsed = parseCSV(raw);
      text(JSON.stringify(parsed));
    `;
    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      name: "Alice, Jr.",
      dept: "Engineering",
      annual_salary: 125000.5,
      active: true,
    });
    expect(parsed[1].active).toBe(false);
  });

  it("parses tab-delimited (TSV) and headerless CSV", async () => {
    const script = `
      const tsv = "apple\\t10\\norange\\t20";
      const noHeader = parseCSV(tsv, { hasHeader: false });
      text(JSON.stringify(noHeader));
    `;
    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    const data = JSON.parse(res.output);
    expect(data).toEqual([["apple", 10], ["orange", 20]]);
  });

  it("serializes arrays of objects to CSV with toCSV()", async () => {
    const script = `
      const rows = [
        { id: 1, item: "Widget, A", price: 19.99 },
        { id: 2, item: "Standard 'B'", price: 29.50 }
      ];
      text(toCSV(rows));
    `;
    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("id,item,price");
    expect(res.output).toContain('1,"Widget, A",19.99');
    expect(res.output).toContain("2,Standard 'B',29.5");
  });

  it("performs groupBy, countBy, sum, avg, median, min, max, and sortBy", async () => {
    const script = `
      const employees = [
        { name: "Alice", role: "Dev", score: 90 },
        { name: "Bob", role: "Design", score: 80 },
        { name: "Charlie", role: "Dev", score: 96 },
        { name: "Dana", role: "Dev", score: 85 }
      ];

      const groups = groupBy(employees, "role");
      const counts = countBy(employees, "role");
      const devTotal = sum(groups["Dev"], "score");
      const devAvg = round(avg(groups["Dev"], "score"), 2);
      const devMed = median(groups["Dev"], "score");
      const devMin = min(groups["Dev"], "score");
      const devMax = max(groups["Dev"], "score");
      const sorted = sortBy(employees, "score", "desc").map(e => e.name);

      text(JSON.stringify({
        devCount: counts["Dev"],
        devTotal,
        devAvg,
        devMed,
        devMin,
        devMax,
        sorted
      }));
    `;
    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    const stats = JSON.parse(res.output);
    expect(stats.devCount).toBe(3);
    expect(stats.devTotal).toBe(271);
    expect(stats.devAvg).toBe(90.33);
    expect(stats.devMed).toBe(90);
    expect(stats.devMin).toBe(85);
    expect(stats.devMax).toBe(96);
    expect(stats.sorted).toEqual(["Charlie", "Alice", "Dana", "Bob"]);
  });

  it("computes pivots, unique values, and mathematical comparisons", async () => {
    const script = `
      const sales = [
        { region: "North", qtr: "Q1", revenue: 100 },
        { region: "North", qtr: "Q2", revenue: 150 },
        { region: "South", qtr: "Q1", revenue: 80 },
        { region: "South", qtr: "Q2", revenue: 120 }
      ];

      const piv = pivot(sales, "region", "qtr", "revenue");
      const regions = unique(sales, "region").map(r => r.region);
      const diff = pctDiff(100, 150);
      const close = approxEqual(0.1 + 0.2, 0.3);

      text(JSON.stringify({ piv, regions, diff, close }));
    `;
    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    const data = JSON.parse(res.output);
    expect(data.piv).toEqual([
      { region: "North", Q1: 100, Q2: 150 },
      { region: "South", Q1: 80, Q2: 120 },
    ]);
    expect(data.regions).toEqual(["North", "South"]);
    expect(data.diff).toBe(50);
    expect(data.close).toBe(true);
  });

  it("filters lines with lines() and grep()", async () => {
    const script = `
      const log = "INFO: User logged in\\nWARN: High memory\\nERROR: Connection reset\\nINFO: Request finished";
      const allLines = lines(log);
      const errors = grep(allLines, /ERROR|WARN/);
      text(JSON.stringify({ totalLines: allLines.length, errors }));
    `;
    const res = await runSandboxedScript(script, facade);
    expect(res.ok).toBe(true);
    const resData = JSON.parse(res.output);
    expect(resData.totalLines).toBe(4);
    expect(resData.errors).toEqual(["WARN: High memory", "ERROR: Connection reset"]);
  });

  it("enforces assertion helpers assert(), assertEqual(), assertApprox()", async () => {
    const successScript = `
      assert(2 > 1, "math broken");
      assertEqual("abc", "abc", "string mismatch");
      assertApprox(10.0005, 10.0, 0.001);
      text("all passed");
    `;
    const successRes = await runSandboxedScript(successScript, facade);
    expect(successRes.ok).toBe(true);
    expect(successRes.output).toBe("all passed");

    const failScript = `
      assertEqual(10, 20, "values must match");
    `;
    const failRes = await runSandboxedScript(failScript, facade);
    expect(failRes.ok).toBe(false);
    expect(failRes.error?.message).toContain("values must match");
    expect(failRes.error?.message).toContain("Expected 20, received 10");
  });
});

describe("Smart Truncation & Summarization Heuristics", () => {
  it("leaves outputs under maxChars untouched", () => {
    const shortText = "Short observation within token limits";
    expect(smartTruncate(shortText, { maxChars: 100 })).toBe(shortText);

    const smallArray = [{ id: 1, name: "Alice" }];
    expect(smartTruncate(smallArray, { maxChars: 500 })).toBe(JSON.stringify(smallArray, null, 2));
  });

  it("intelligently summarizes large tabular datasets (array of objects)", () => {
    const table: Array<{ id: number; name: string; dept: string; salary: number }> = [];
    for (let i = 1; i <= 200; i++) {
      table.push({
        id: i,
        name: `Person ${i}`,
        dept: i % 2 === 0 ? "Engineering" : "Operations",
        salary: 50000 + i * 250,
      });
    }

    const truncated = smartTruncate(table, { maxChars: 1200 });
    expect(truncated).toContain("[Tabular Data Preview: showing 5 of 200 rows. Total rows: 200]");
    expect(truncated).toContain('Columns (4): [ "id", "name", "dept", "salary" ]');
    expect(truncated).toContain("Sample Head (3 rows):");
    expect(truncated).toContain('"id": 1');
    expect(truncated).toContain("Sample Tail (2 rows):");
    expect(truncated).toContain('"id": 200');
    expect(truncated).toContain("195 rows omitted to fit token budget");
    expect(truncated.length).toBeLessThan(1200);
  });

  it("intelligently summarizes large primitive arrays", () => {
    const arr = Array.from({ length: 150 }, (_, i) => `item_${i}`);
    const truncated = smartTruncate(arr, { maxChars: 300 });
    expect(truncated).toContain("[Array Preview: showing 8 of 150 items. Total items: 150]");
    expect(truncated).toContain('"item_0"');
    expect(truncated).toContain('"item_149"');
    expect(truncated).toContain("142 items omitted");
  });

  it("preserves line boundaries for long multi-line text (documents/logs)", () => {
    const docLines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      docLines.push(`Section ${i}: Detailed description of requirement paragraph.`);
    }
    const longDoc = docLines.join("\n");
    const truncated = smartTruncate(longDoc, { maxChars: 500 });
    expect(truncated).toContain("Section 1:");
    expect(truncated).toContain("... [Omitted ");
    expect(truncated).toContain("Section 100:");
    // Ensure clean line boundaries without sliced mid-word strings
    expect(truncated.split("\n").some((l) => l.startsWith("Section 1:"))).toBe(true);
  });

  it("maintains compatibility for single-line long strings", () => {
    const longSingle = "X".repeat(500);
    const truncated = smartTruncate(longSingle, { maxChars: 100 });
    expect(truncated).toContain("[truncated: 400 chars omitted]");
    expect(truncated.startsWith("X".repeat(100))).toBe(true);
  });
});
