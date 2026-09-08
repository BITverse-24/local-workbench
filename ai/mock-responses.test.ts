import { describe, expect, it } from "vitest";
import type { RetrievedKnowledgeChunk, VisionResult } from "./contracts";
import {
  LOCKED_FLOW_A_REQUIRED_FINDINGS,
  LOCKED_FLOW_B_CODE_RULES,
  validateCodeDraftResult,
  validateDraftResult,
  validateVisionResult,
} from "./validation";
import successfulOcr from "./mock-responses/successful-ocr.json";
import invalidOcr from "./mock-responses/invalid-ocr-output.json";
import successfulDraft from "./mock-responses/successful-drafting.json";
import unsupportedCitationDraft from "./mock-responses/unsupported-citation-draft.json";
import missingSectionsDraft from "./mock-responses/missing-sections-draft.json";
import successfulCode from "./mock-responses/successful-code-generation.json";
import malformedCode from "./mock-responses/malformed-code-response.json";
import noSourceDraft from "./mock-responses/no-matching-knowledge-source.json";

const retrievedChunk: RetrievedKnowledgeChunk = {
  chunkId: "sop-114-3.2",
  documentId: "SOP-114",
  sectionId: "3.2",
  label: "SOP-114 §3.2",
  documentTitle: "SOP-114 — Pressure Equipment Inspection and Approval",
  excerpt: successfulDraft.result.citations[0].supportingExcerpt,
  score: 0.99,
};

const vision = successfulOcr.result as VisionResult;

describe("offline AI mock responses", () => {
  it("accepts successful OCR and rejects invalid OCR", () => {
    expect(validateVisionResult(vision, { requiredFindings: LOCKED_FLOW_A_REQUIRED_FINDINGS }).ok).toBe(true);
    expect(validateVisionResult(invalidOcr.result, { requiredFindings: LOCKED_FLOW_A_REQUIRED_FINDINGS }).ok).toBe(false);
  });

  it("accepts successful drafting and rejects unsupported or incomplete drafts", () => {
    const context = {
      retrievedChunks: [retrievedChunk],
      sourceText: vision.sourceText,
      findings: vision.findings,
      pageReferences: vision.pageReferences,
      requiredCitations: [{ documentId: "SOP-114", sectionId: "3.2" }],
    };
    expect(validateDraftResult(successfulDraft.result, context).ok).toBe(true);
    expect(validateDraftResult(unsupportedCitationDraft.result, { ...context, requiredCitations: [] }).ok).toBe(false);
    expect(validateDraftResult(missingSectionsDraft.result, { ...context, requiredCitations: [] }).ok).toBe(false);
  });

  it("accepts the safe code response and rejects malformed code", () => {
    expect(validateCodeDraftResult(successfulCode.result, LOCKED_FLOW_B_CODE_RULES).ok).toBe(true);
    expect(validateCodeDraftResult(malformedCode.result, LOCKED_FLOW_B_CODE_RULES).ok).toBe(false);
  });

  it("accepts an explicit no-source draft without citations", () => {
    expect(validateDraftResult(noSourceDraft.result, { retrievedChunks: [] }).ok).toBe(true);
  });
});
