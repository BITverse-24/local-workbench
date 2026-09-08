import { describe, expect, it } from "vitest";
import type { RetrievedKnowledgeChunk, VisionResult } from "./contracts";
import { LOCKED_FLOW_A_REQUIRED_FINDINGS, LOCKED_FLOW_B_CODE_RULES, validateCodeDraftResult, validateDraftResult, validateVisionResult } from "./validation";
import successfulOcr from "./mock-responses/successful-ocr.json";
import successfulDraft from "./mock-responses/successful-drafting.json";
import successfulCode from "./mock-responses/successful-code-generation.json";
import invalidOcr from "./mock-responses/invalid-ocr-output.json";
import unsupportedCitation from "./mock-responses/unsupported-citation-draft.json";
import missingSections from "./mock-responses/missing-sections-draft.json";
import malformedCode from "./mock-responses/malformed-code-response.json";
import noSourceDraft from "./mock-responses/no-matching-knowledge-source.json";
import expectedOcr from "../demo-fixtures/flow-a/expected-ocr.json";
import expectedRetrieval from "../demo-fixtures/flow-a/expected-retrieval.json";
import expectedApprovalNote from "../demo-fixtures/flow-a/expected-approval-note.json";
import expectedSummary from "../demo-fixtures/flow-b/expected-out-of-range-summary.json";
import expectedExecution from "../demo-fixtures/flow-b/expected-python-execution.json";
import { readFileSync } from "node:fs";
import path from "node:path";

const ocrResult = successfulOcr.result as unknown as VisionResult;
const visionFromOracle = expectedOcr as unknown as VisionResult;
const retrievalChunks = (expectedRetrieval as { chunks: RetrievedKnowledgeChunk[] }).chunks;
const draftOracleRetrievedChunks: RetrievedKnowledgeChunk[] = retrievalChunks;

describe("prompt regression (Task 10)", () => {
  it("OCR: input fixture exists and required output fields are present", () => {
    expect(ocrResult.sourceText).toBeTruthy();
    expect(Array.isArray(ocrResult.findings)).toBe(true);
    expect(Array.isArray(ocrResult.pageReferences)).toBe(true);
    expect(Array.isArray(ocrResult.warnings)).toBe(true);
  });
  it("OCR must find the known inspection issue (3 findings, locked values)", () => {
    const ok = validateVisionResult(ocrResult, { requiredFindings: LOCKED_FLOW_A_REQUIRED_FINDINGS });
    expect(ok.ok).toBe(true);
    expect(ocrResult.sourceText).toContain("IR-E201-2026-08-20");
    expect(ocrResult.sourceText).toContain("E-201");
  });
  it("OCR oracle itself satisfies locked findings", () => {
    expect(validateVisionResult(visionFromOracle, { requiredFindings: LOCKED_FLOW_A_REQUIRED_FINDINGS }).ok).toBe(true);
  });
  it("OCR must not invent an inspection date / must be grounded", () => {
    // Corrupt a finding value to an unsupported claim and expect grounding failure.
    const tampered = structuredClone(ocrResult) as VisionResult;
    tampered.findings[0].value = "Rows 12-15 measured 9.9 mm; inspected on 2099-01-01";
    const res = validateVisionResult(tampered);
    expect(res.ok).toBe(false);
  });
  it("OCR failure: invalid fixture is rejected", () => {
    expect(validateVisionResult((invalidOcr as { result: unknown }).result).ok).toBe(false);
  });
  it("Draft must cite SOP-114 section 3.2", () => {
    const ctx = { retrievedChunks: draftOracleRetrievedChunks, sourceText: ocrResult.sourceText, findings: ocrResult.findings, pageReferences: ocrResult.pageReferences, requiredCitations: [{ documentId: "SOP-114", sectionId: "3.2" }] };
    const res = validateDraftResult(successfulDraft.result, ctx);
    expect(res.ok).toBe(true);
    // expected-approval-note.json is the committed oracle for DOCX generation; check its structure
    // directly (its phrasing uses connective words like \"against\" / \"pending\" that are not
    // part of the strict lexical grounding check, so it is not validated via validateDraftResult).
    const oracle = expectedApprovalNote as unknown as { title: string; body: string; sections: { id: string; body: string }[]; citations: { documentId: string; sectionId: string; label: string; inlineText: string }[]; missingInformation: unknown[] };
    expect(oracle.sections).toHaveLength(4);
    expect(oracle.sections.map(s => s.id)).toEqual(["equipment-header", "findings-summary", "recommendation", "grounding-references"]);
    expect(oracle.citations[0].documentId).toBe("SOP-114");
    expect(oracle.citations[0].sectionId).toBe("3.2");
    expect(oracle.citations[0].inlineText).toBe("[SOP-114 \u00A73.2]");
    expect(oracle.body).toContain("[SOP-114 \u00A73.2]");
  });
  it("Draft must not invent an inspection date (grounding check)", () => {
    const ctx = { retrievedChunks: draftOracleRetrievedChunks, sourceText: ocrResult.sourceText, findings: ocrResult.findings, pageReferences: ocrResult.pageReferences };
    const tampered = structuredClone(successfulDraft.result) as unknown as Record<string, unknown>;
    // Inject an invented date claim into the body
    (tampered as { body: string }).body += " Inspection date was 2099-01-01.";
    const res = validateDraftResult(tampered, ctx);
    expect(res.ok).toBe(false);
  });
  it("Draft failure: unsupported citation and missing sections are rejected", () => {
    const ctx = { retrievedChunks: draftOracleRetrievedChunks, sourceText: ocrResult.sourceText, findings: ocrResult.findings, pageReferences: ocrResult.pageReferences };
    expect(validateDraftResult((unsupportedCitation as { result: unknown }).result, ctx).ok).toBe(false);
    expect(validateDraftResult((missingSections as { result: unknown }).result, ctx).ok).toBe(false);
  });
  it("Draft no-source: no citations and explicit notice", () => {
    expect(validateDraftResult((noSourceDraft as { result: unknown }).result, { retrievedChunks: [] }).ok).toBe(true);
  });
  it("Code must flag the known out-of-range CSV rows", () => {
    const res = validateCodeDraftResult(successfulCode.result, LOCKED_FLOW_B_CODE_RULES);
    expect(res.ok).toBe(true);
    expect((successfulCode.result as { expectedResult: string }).expectedResult).toContain("OUT_OF_RANGE 7/240 (high=5, low=2)");
    expect(expectedSummary.summary.outOfRange).toBe(7);
    expect(expectedSummary.summary.high).toBe(5);
    expect(expectedSummary.summary.low).toBe(2);
    expect(expectedSummary.rows).toHaveLength(7);
  });
  it("Code must return the expected summary and execution oracle", () => {
    expect(expectedExecution.exitCode).toBe(0);
    expect(expectedExecution.stdout).toContain("OUT_OF_RANGE 7/240 (high=5, low=2)");
    expect(expectedExecution.timedOut).toBe(false);
    // The mock code must not hard-code counts in source
    expect((successfulCode.result as { source: string }).source).not.toMatch(/OUT_OF_RANGE\s+7\/240/);
  });
  it("Code failure: malformed code is rejected", () => {
    expect(validateCodeDraftResult((malformedCode as { result: unknown }).result, LOCKED_FLOW_B_CODE_RULES).ok).toBe(false);
  });
  it("Golden Python file is the safe reference and matches mock source shape", () => {
    const golden = readFileSync(path.resolve("demo-fixtures/flow-b/expected-task.py"), "utf8");
    expect(golden).toContain("reactor-temperature-log.csv");
    expect(golden).toContain("out-of-range-rows.csv");
    expect(golden).not.toMatch(/subprocess|socket|requests|os\.system/);
  });
});
