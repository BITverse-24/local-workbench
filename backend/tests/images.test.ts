import { describe, expect, it } from "vitest";
import { assertUploadableSize, prepareImage } from "../src/main/run/images.js";
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
