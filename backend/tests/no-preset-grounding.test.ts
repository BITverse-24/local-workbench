import { describe, it, expect } from "vitest";
import { evaluateDrawingComplianceWithModel, ensureGoverningSpecIndexed, extractDrawingAttributes } from "../src/main/grounding/spec-compliance.js";

const drawing = { drawingId: "drawing-new", title: "New design", notes: [], observedComponents: [], rawText: "Actual source" };

describe("Source-driven compliance failure boundaries", () => {
  it("does not load a demo standard when no standard was supplied", async () => {
    expect(await ensureGoverningSpecIndexed(undefined, { promptText: "Review this drawing" })).toEqual({ docId: "" });
  });
  it("does not substitute a preset valve tag or rating", () => {
    const extracted = extractDrawingAttributes({ filename: "drawing.svg", mediaType: 'image/svg+xml', rawBuffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>Class 600</text></svg>') });
    expect(JSON.stringify(extracted)).toContain("Class 600");
    expect(JSON.stringify(extracted)).not.toContain("XV-204");
    expect(JSON.stringify(extracted)).not.toContain("Class 150");
  });
  it("surfaces a real model failure without substitute findings", async () => {
    const gateway = { execute: async () => ({ ok: false, error: { message: "Endpoint offline" } }) } as any;
    await expect(evaluateDrawingComplianceWithModel({ gateway, runId: "grounding-failure", drawing, specChunks: [], docId: "source-standard" }))
      .rejects.toThrow("Endpoint offline");
  });
  it("rejects an unstructured assessment instead of inventing typed findings", async () => {
    const gateway = { execute: async () => ({ ok: true, value: { result: { text: "# A prose response without checks" } } }) } as any;
    await expect(evaluateDrawingComplianceWithModel({ gateway, runId: "grounding-invalid", drawing, specChunks: [], docId: "source-standard" }))
      .rejects.toThrow("no valid structured assessment");
  });
});
