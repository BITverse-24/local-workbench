import { describe, expect, it } from "vitest";
import { analyzePdf, assertUploadableSize, prepareImage, rankPagesByVisualDensity } from "../src/main/run/images.js";
import { validateVision, validationMessage } from "../src/main/validators/responses.js";

describe("image upload prep", () => {
  it("passes small images through untouched", async () => {
    const buf = Buffer.from("tiny-png");
    const out = await prepareImage(buf, "image/png");
    expect(out.buffer).toBe(buf);
    expect(out.mediaType).toBe("image/png");
    expect(out.resized).toBe(false);
    expect(out.finalBytes).toBe(buf.length);
  });
  it("passes non-images and vector/animated formats through", async () => {
    for (const mediaType of ["application/pdf", "image/svg+xml", "image/gif"]) {
      const buf = Buffer.alloc(2 * 1024 * 1024, 7);
      const out = await prepareImage(buf, mediaType);
      expect(out.buffer).toBe(buf);
      expect(out.resized).toBe(false);
    }
  });
  it("falls back to the original when Electron is unavailable (e.g. tests)", async () => {
    const buf = Buffer.alloc(2 * 1024 * 1024, 7);
    const out = await prepareImage(buf, "image/jpeg");
    expect(out.buffer).toBe(buf);
    expect(out.resized).toBe(false);
    expect(out.originalBytes).toBe(buf.length);
  });
  it("rejects uploads still over the cap with an actionable message", () => {
    expect(() => assertUploadableSize(6 * 1024 * 1024)).toThrow(/too large to send.*smaller file/);
    expect(() => assertUploadableSize(1024)).not.toThrow();
  });
});

describe("validation error surfacing", () => {
  it("names the failing field instead of a bare zod message", () => {
    const result = validateVision({ sourceText: 123 as unknown as string, findings: [], pageReferences: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = validationMessage("vision result", result.error);
      expect(message).toContain("vision result");
      expect(message).toContain("sourceText");
      expect(message).not.toBe("String must contain at least 1 character(s)");
    }
  });
  it("allows empty sourceText with warnings (non-inspection images)", () => {
    const result = validateVision({ sourceText: "", findings: [], pageReferences: [], warnings: ["no inspection data"] });
    expect(result.ok).toBe(true);
  });
});

describe("PDF tier analysis & selective visual slicing", () => {
  const syntheticPdf = `%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>> endobj
4 0 obj <</Length 160>>
stream
BT
/F1 12 Tf
(Standard operating procedures and high-pressure steam boiler maintenance checklist for facility units.) Tj
ET
endstream
endobj
5 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 1191 842] /Contents 6 0 R>> endobj
6 0 obj <</Length 180>>
stream
BT
/F1 12 Tf
(P&ID SCHEMATIC: PUMP P-101 SUCTION PIPING LAYOUT WITH CHECK VALVE CV-401 AND BYPASS LINE.) Tj
ET
endstream
endobj
7 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R>> endobj
8 0 obj <</Length 100>>
stream
BT
/F1 12 Tf
(Appendix: Calibration schedule and vendor contact information.) Tj
ET
endstream
endobj
xref
0 9
trailer <</Root 1 0 R>>
%%EOF`;

  it("classifies clean digital document as Tier 1 text when no visual intent in prompt", () => {
    const res = analyzePdf(Buffer.from(syntheticPdf), "Summarize the steam boiler maintenance checklist");
    expect(res.tier).toBe("text");
    expect(res.extractedText).toContain("steam boiler maintenance checklist");
    expect(res.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it("forces Tier 2 Vision when prompt contains visual keywords like P&ID or drawing", () => {
    const res = analyzePdf(Buffer.from(syntheticPdf), "Inspect the P&ID drawing for pump P-101");
    expect(res.tier).toBe("vision");
    expect(res.reason).toContain("visual / drawing keyword detected");
  });

  it("ranks pages by visual score and prioritizes landscape/CAD drawings over plain text", async () => {
    const ranking = await rankPagesByVisualDensity(
      Buffer.from(syntheticPdf),
      "Inspect P&ID schematic for pump P-101 and valve CV-401",
      1,
    );

    expect(ranking.totalDocPages).toBe(3);
    expect(ranking.selectedPages).toEqual([2]); // Page 2 is landscape + P&ID keyword match
    expect(ranking.unselectedPages).toEqual([1, 3]);
    expect(ranking.unselectedText).toContain("[Page 1]:");
    expect(ranking.unselectedText).toContain("[Page 3]:");
    expect(ranking.unselectedText).toContain("steam boiler maintenance checklist");
    expect(ranking.estimatedTokensSaved).toBeGreaterThan(1000);
  });
});
