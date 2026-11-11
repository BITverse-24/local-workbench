import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFileSync } from "../src/main/agent/symbol-index.js";
import { getWorkspaceCodeIndex, invalidateWorkspaceCodeIndex } from "../src/main/agent/codeintel/code-index.js";
import { createReadFacade } from "../src/main/agent/exec/facade.js";
import { runSandboxedScript } from "../src/main/agent/exec/sandbox.js";
import { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";
import { agentWorkspaceActions } from "../src/main/agent/workspace-actions.js";

const tempDirs: string[] = [];
afterEach(() => {
  invalidateWorkspaceCodeIndex();
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe("T8 Phase B & E — WorkspaceCodeIndex, Navigation, RepoMap & FTS5 Code Search", () => {
  it("parses symbols, imports, exports, and references for TypeScript and Python", () => {
    const tsSource = Buffer.from(
      [
        'import { computeTax } from "./tax.js";',
        "export function calculateInvoiceTotal(subtotal: number): number {",
        "  return subtotal + computeTax(subtotal);",
        "}",
      ].join("\n"),
      "utf8",
    );
    const tsParsed = parseFileSync("src/invoice.ts", tsSource);
    expect(tsParsed.symbols.map((s) => s.name)).toContain("calculateInvoiceTotal");
    expect(tsParsed.exports).toContain("calculateInvoiceTotal");
    expect(tsParsed.imports).toEqual([{ from: "./tax.js", names: ["computeTax"], line: 1 }]);
    expect(tsParsed.refs.some((r) => r.name === "computeTax" && r.kind === "call")).toBe(true);

    const pySource = Buffer.from(
      [
        "from billing.rates import lookup_rate",
        "",
        "def compute_charge(units):",
        "    return units * lookup_rate(units)",
      ].join("\n"),
      "utf8",
    );
    const pyParsed = parseFileSync("billing/charge.py", pySource);
    expect(pyParsed.symbols.map((s) => s.name)).toContain("compute_charge");
    expect(pyParsed.imports).toEqual([{ from: "billing.rates", names: ["lookup_rate"], line: 1 }]);
    expect(pyParsed.refs.some((r) => r.name === "lookup_rate" && r.kind === "call")).toBe(true);
  });

  it("resolves definitions, import-filtered references, repoMap, and identifier-split searchCode", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "codeintel-idx-"));
    tempDirs.push(root);
    mkdirSync(path.join(root, "src"), { recursive: true });

    writeFileSync(
      path.join(root, "src/tax.ts"),
      [
        "export function computeRegionalTax(amount: number): number {",
        "  return Math.round(amount * 0.08 * 100) / 100;",
        "}",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "src/checkout.ts"),
      [
        'import { computeRegionalTax } from "./tax.js";',
        "export function finalizeOrder(subtotal: number) {",
        "  const tax = computeRegionalTax(subtotal);",
        "  return subtotal + tax;",
        "}",
      ].join("\n"),
      "utf8",
    );
    // Unrelated file that happens to mention computeRegionalTax without importing it
    writeFileSync(
      path.join(root, "src/unrelated.ts"),
      [
        "export function note() {",
        "  const computeRegionalTax = 0;",
        "  return computeRegionalTax;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const idx = getWorkspaceCodeIndex(root);
    const syms = idx.symbols("src/tax.ts");
    expect(syms.map((s) => s.name)).toEqual(["computeRegionalTax"]);

    const defs = idx.definition("computeRegionalTax", { fromPath: "src/checkout.ts" });
    expect(defs.matches.length).toBeGreaterThanOrEqual(1);
    expect(defs.matches[0].path).toBe("src/tax.ts");
    expect(defs.matches[0].line).toBe(1);

    const refs = idx.references("computeRegionalTax");
    expect(refs.precision).toBe("import-filtered");
    const refPaths = refs.matches.map((m) => m.path);
    expect(refPaths).toContain("src/tax.ts");
    expect(refPaths).toContain("src/checkout.ts");
    expect(refPaths).not.toContain("src/unrelated.ts");

    const rm = idx.repoMap({ budgetTokens: 300 });
    // src/tax.ts has in-degree 1 (imported by src/checkout.ts), so it ranks first
    expect(rm.map.split("\n")[0]).toContain("src/tax.ts: computeRegionalTax:1");

    // Identifier-splitting FTS5 search: "regional tax" matches computeRegionalTax
    const search = idx.searchCode("regional tax");
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0].symbol).toBe("computeRegionalTax");

    // Invalidation updates symbols immediately after file edit
    writeFileSync(
      path.join(root, "src/tax.ts"),
      [
        "export function computeRegionalTax(amount: number): number {",
        "  return amount * 0.1;",
        "}",
        "export function taxExempt(): number { return 0; }",
      ].join("\n"),
      "utf8",
    );
    idx.invalidateFile("src/tax.ts");
    expect(idx.symbols("src/tax.ts").map((s) => s.name)).toEqual(["computeRegionalTax", "taxExempt"]);
  });

  it("exposes symbols, definition, references, repoMap, and searchCode in Code Mode sandbox", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "codeintel-sandbox-"));
    tempDirs.push(root);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src/math.ts"),
      "export function clampValue(x: number, lo: number, hi: number) {\n  return Math.max(lo, Math.min(hi, x));\n}\n",
      "utf8",
    );

    const dispatcher = new ToolDispatcher(agentWorkspaceActions);
    const facade = createReadFacade(
      dispatcher,
      {
        runId: "11111111-2222-3333-4444-555555555555",
        workspaceRoot: root,
        gateway: {} as any,
      },
      { parentExecId: "exec-1", requirementId: "req-1" },
    );

    const res = await runSandboxedScript(
      `
      const syms = await tools.symbols("src/math.ts");
      const def = await tools.definition("clampValue");
      const map = await tools.repoMap({ budgetTokens: 200 });
      const hits = await tools.searchCode("clamp value");
      text({ syms: syms.map(s => s.name), defPath: def.matches[0]?.path, map: map.map, topHit: hits.results[0]?.symbol });
      `,
      facade,
    );
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.syms).toEqual(["clampValue"]);
    expect(parsed.defPath).toBe("src/math.ts");
    expect(parsed.map).toContain("src/math.ts: clampValue:1");
    expect(parsed.topHit).toBe("clampValue");
  });
});
