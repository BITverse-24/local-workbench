import { describe, expect, it } from "vitest";
import type { VisionResult } from "./contract";
import {
  LOCKED_FLOW_A_REQUIRED_FINDINGS,
  validateVisionResult,
} from "../validation";
import successfulOcr from "../mock-responses/successful-ocr.json";
import invalidOcr from "../mock-responses/invalid-ocr-output.json";

const vision = successfulOcr.result as VisionResult;

describe("vision contract (typed-scan extraction)", () => {
  it("accepts the successful OCR mock with the locked required findings", () => {
    const result = validateVisionResult(vision, {
      requiredFindings: LOCKED_FLOW_A_REQUIRED_FINDINGS,
    });
    expect(result.ok).toBe(true);
    expect(vision.sourceText).toContain("E-201");
    expect(vision.findings).toHaveLength(3);
    expect(vision.pageReferences.map((ref) => ref.page)).toEqual([1, 1, 2]);
  });

  it("rejects OCR that references an unknown page", () => {
    expect(validateVisionResult(invalidOcr.result).ok).toBe(false);
  });

  it("rejects an unknown page reference and an unsupported finding claim", () => {
    const invalid = structuredClone(vision);
    invalid.findings[0].pageReferenceIds = ["missing-page"];
    invalid.findings[1].value = "Inspector approved the equipment";
    const result = validateVisionResult(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.path)).toEqual(
        expect.arrayContaining([
          "result.findings[0].pageReferenceIds",
          "result.findings[1].value",
        ]),
      );
    }
  });

  it("rejects an invented claim injected into a finding value", () => {
    const tampered = structuredClone(vision);
    tampered.findings[0].value =
      "Rows 12-15 measured 9.9 mm; inspected on 2099-01-01";
    expect(validateVisionResult(tampered).ok).toBe(false);
  });
});
