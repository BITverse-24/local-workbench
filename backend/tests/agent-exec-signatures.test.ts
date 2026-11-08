import { describe, it, expect } from "vitest";
import { renderReadSignatures } from "../src/main/agent/exec/signatures.js";
import { countTokens } from "../src/main/agent/context-manager.js";

describe("Exec Signatures Generation", () => {
  it("generates base read signatures with small token footprint (< 220 tokens)", () => {
    const sigs = renderReadSignatures();
    expect(sigs).toContain("declare const tools:");
    expect(sigs).toContain("readFile(path: string");
    expect(sigs).toContain("search(query: string");
    expect(sigs).toContain("listDir(path: string");
    expect(sigs).toContain("declare function text(value: unknown): void;");
    expect(sigs).toContain("declare function escalate(reason: string): never;");

    const tokens = countTokens(sigs);
    expect(tokens).toBeLessThan(750);
    expect(tokens).toBeGreaterThan(100);
  });

  it("conditionally includes specialized tools", () => {
    const full = renderReadSignatures({
      hasInputSources: true,
      hasKnowledgeDocs: true,
      hasRetrievableResults: true,
      hasDocumentProcessing: true,
      allowedPaths: ["src/index.ts", "package.json"],
    });

    expect(full).toContain("readInput(");
    expect(full).toContain("extractDocument(");
    expect(full).toContain("retrieveKnowledge(");
    expect(full).toContain("result(");
    expect(full).toContain("src/index.ts");
  });
});
