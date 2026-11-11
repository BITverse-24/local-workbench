import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBufferSyntax,
  checkWorkspaceFiles,
  diffDiagnostics,
  formatDiagnostics,
  validateProposalSyntax,
} from "../src/main/agent/codeintel/diagnostics.js";

describe("codeintel diagnostics (T8 Phase A)", () => {
  it("reports JS and TS syntax errors with line numbers and accepts valid code", () => {
    expect(checkBufferSyntax("src/a.js", Buffer.from("function ok(x) { return x + 1; }\n"))).toEqual([]);
    expect(checkBufferSyntax("src/b.ts", Buffer.from("export const add = (a: number, b: number): number => a + b;\n"))).toEqual([]);
    const errs = checkBufferSyntax("src/broken.js", Buffer.from("function f(a) {\n  if (a > 0) {\n    return a;\n}\n"));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].path).toBe("src/broken.js");
    expect(errs[0].severity).toBe("error");
  });

  it("reports Python syntax errors and accepts valid Python", () => {
    expect(checkBufferSyntax("ok.py", Buffer.from("def f(x):\n    return x * 2\n"))).toEqual([]);
    const errs = checkBufferSyntax("bad.py", Buffer.from("def f(x)\n    return x * 2\n"));
    expect(errs.length).toBe(1);
    expect(errs[0].line).toBe(1);
    expect(errs[0].source).toBe("python-ast");
  });

  it("reports JSON syntax errors", () => {
    expect(checkBufferSyntax("cfg.json", Buffer.from('{"a": 1}'))).toEqual([]);
    expect(checkBufferSyntax("cfg.json", Buffer.from('{"a": 1,}'))).toHaveLength(1);
  });

  it("rejects a proposal with syntax errors before approval unless diagnostics are off", () => {
    const clean = Buffer.from("const a = 1;\n");
    const broken = Buffer.from("const a = ;\n");
    expect(() => validateProposalSyntax("src/a.js", clean, broken)).toThrow(/syntax error/i);
    expect(() => validateProposalSyntax("src/a.js", clean, Buffer.from("const a = 2;\n"))).not.toThrow();

    process.env.WORKBENCH_DIAGNOSTICS = "off";
    try {
      expect(() => validateProposalSyntax("src/a.js", clean, broken)).not.toThrow();
    } finally {
      delete process.env.WORKBENCH_DIAGNOSTICS;
    }
  });

  it("diffs diagnostics across line shifts and caps formatted output", () => {
    const before = [{ path: "a.ts", line: 10, severity: "error" as const, code: "TS2322", message: "Type 'string' is not assignable to type 'number'.", source: "tsc" }];
    const after = [
      // Same pre-existing error shifted to line 14 by an earlier edit: must be filtered out.
      { path: "a.ts", line: 14, severity: "error" as const, code: "TS2322", message: "Type 'string' is not assignable to type 'number'.", source: "tsc" },
      // Genuinely new error: must be kept.
      { path: "a.ts", line: 4, severity: "error" as const, code: "TS2304", message: "Cannot find name 'missingVar'.", source: "tsc" },
    ];
    const delta = diffDiagnostics(before, after);
    expect(delta).toHaveLength(1);
    expect(delta[0].code).toBe("TS2304");
    expect(formatDiagnostics(delta)).toContain("a.ts:4 [tsc TS2304] error: Cannot find name 'missingVar'.");
  });

  it("runs clang -fsyntax-only on C/C++ files when clang is present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wb-clang-test-"));
    try {
      writeFileSync(path.join(dir, "ok.cpp"), "int add(int a, int b) { return a + b; }\n");
      writeFileSync(path.join(dir, "bad.cpp"), "int add(int a, int b) { return a + }\n");
      expect(checkWorkspaceFiles(dir, ["ok.cpp"])).toEqual([]);
      const errs = checkWorkspaceFiles(dir, ["bad.cpp"]);
      expect(errs.some((e) => e.source === "clang" && e.path === "bad.cpp")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
