import { describe, it, expect } from "vitest";
import {
  evaluateSop114Rules,
  formatSop114AssessmentForDraftPrompt,
  extractMeasurements,
  SOP114_CITATION,
  type FusedFinding,
  type HandwrittenAnnotation,
} from "../src/main/grounding/sop114-engine.js";

describe("SOP-114 Deterministic Rule Engine", () => {
  it("extracts numeric measurements and ranges correctly", () => {
    expect(extractMeasurements("Rows 12–15 measured 3.8–4.2 mm")).toEqual({
      values: [3.8, 4.2],
      min: 3.8,
      max: 4.2,
      unit: "mm",
    });
    expect(extractMeasurements("Maximum pitting depth: 1.8 mm")).toEqual({
      values: [1.8],
      min: 1.8,
      max: 1.8,
      unit: "mm",
    });
    expect(extractMeasurements("minimum allowable: 4.6mm")).toEqual({
      values: [4.6],
      min: 4.6,
      max: 4.6,
      unit: "mm",
    });
  });

  it("evaluates tube-wall thickness below threshold as FAIL with required action and citation", () => {
    const findings: FusedFinding[] = [
      {
        findingId: "finding-1",
        title: "Tube wall thickness below minimum allowable",
        value: "Rows 12–15 measured 3.8–4.2 mm; minimum allowable is 4.6 mm",
        sourceFile: "inspection-report-E201-annotated.pdf",
        page: 1,
        confidence: "high",
        evidence: "The report states the measured range and minimum allowable value.",
        pageReferenceIds: ["page-ref-1"],
      },
    ];

    const assessment = evaluateSop114Rules(findings, [], []);
    const tubeCheck = assessment.assessments.find((a) => a.findingId === "finding-1");
    expect(tubeCheck).toBeDefined();
    expect(tubeCheck?.status).toBe("fail");
    expect(tubeCheck?.citation).toBe(SOP114_CITATION);
    expect(tubeCheck?.requiredAction).toContain("Retube the affected tubes");
  });

  it("evaluates pitting depth > 1.0mm as FAIL/recorded with required action and citation", () => {
    const findings: FusedFinding[] = [
      {
        findingId: "finding-2",
        title: "Localised pitting corrosion at shell inlet nozzle",
        value: "Maximum depth 1.8 mm",
        sourceFile: "inspection-report-E202-followup.pdf",
        page: 1,
        confidence: "high",
        evidence: "Maximum pitting depth: 1.8 mm",
        pageReferenceIds: ["page-ref-2"],
      },
    ];

    const assessment = evaluateSop114Rules(findings, [], []);
    const pittingCheck = assessment.assessments.find((a) => a.findingId === "finding-2");
    expect(pittingCheck).toBeDefined();
    expect(pittingCheck?.citation).toBe(SOP114_CITATION);
    expect(pittingCheck?.numericValue).toBe(1.8);
    expect(pittingCheck?.threshold).toBe(1.0);
  });

  it("flags handwritten annotation as UNKNOWN / RECHECK REQUIRED", () => {
    const handwritten: HandwrittenAnnotation[] = [
      {
        text: "RECHECK WELD JOINT 4B - field inspector",
        sourceFile: "inspection-report-E201-annotated.pdf",
        page: 1,
        confidence: "medium",
        flag: "manual verification recommended",
      },
    ];

    const assessment = evaluateSop114Rules([], handwritten, []);
    const weldCheck = assessment.assessments.find((a) => a.findingId === "handwritten-weld-4b");
    expect(weldCheck).toBeDefined();
    expect(weldCheck?.status).toBe("unknown");
    expect(weldCheck?.citation).toBe(SOP114_CITATION);
    expect(weldCheck?.requiredAction).toContain("Recheck weld joint 4B");
  });

  it("flags missing signatory authority as WARNING and UNKNOWN status", () => {
    const rawReport = "No approval status is stated in this report.";
    const assessment = evaluateSop114Rules([], [], [rawReport]);

    expect(assessment.missingInformation.some((m) => m.field === "approvalAuthority")).toBe(true);
    const approvalCheck = assessment.assessments.find((a) => a.findingId === "approval-status");
    expect(approvalCheck).toBeDefined();
    expect(approvalCheck?.status).toBe("unknown");
    expect(approvalCheck?.citation).toBe(SOP114_CITATION);
  });

  it("fuses findings across multiple reports and formats grounded prompt block", () => {
    const findings: FusedFinding[] = [
      {
        findingId: "finding-1",
        title: "Tube wall thickness below minimum allowable",
        value: "Rows 12–15 measured 3.8–4.2 mm; minimum allowable is 4.6 mm",
        sourceFile: "inspection-report-E201-annotated.pdf",
        page: 1,
        confidence: "high",
        evidence: "The report states the measured range and minimum allowable value.",
        pageReferenceIds: ["page-ref-1"],
      },
      {
        findingId: "finding-2",
        title: "Localised pitting corrosion at shell inlet nozzle",
        value: "Maximum depth 1.8 mm",
        sourceFile: "inspection-report-E202-followup.pdf",
        page: 1,
        confidence: "high",
        evidence: "Maximum pitting depth: 1.8 mm",
        pageReferenceIds: ["page-ref-2"],
      },
      {
        findingId: "finding-3",
        title: "Channel-head gasket degradation",
        value: "Replacement recommended",
        sourceFile: "inspection-report-E201-annotated.pdf",
        page: 2,
        confidence: "high",
        evidence: "Channel-head gasket shows degradation; replacement recommended.",
        pageReferenceIds: ["page-ref-3"],
      },
    ];

    const handwritten: HandwrittenAnnotation[] = [
      {
        text: "RECHECK WELD JOINT 4B - field inspector",
        sourceFile: "inspection-report-E201-annotated.pdf",
        page: 1,
      },
    ];

    const rawReport = "Report ID: IR-E201-2026-08-20\nNo approval status is stated in this report.";
    const assessment = evaluateSop114Rules(findings, handwritten, [rawReport]);

    expect(assessment.criteriaCitation).toBe("[SOP-114 §3.2]");
    expect(assessment.sourceReport).toBe("IR-E201-2026-08-20");
    expect(assessment.recommendation).toContain("Conditional clearance");

    const promptText = formatSop114AssessmentForDraftPrompt(assessment);
    expect(promptText).toContain("[SOP-114 §3.2 DETERMINISTIC RULE EVALUATION — GROUNDED EVIDENCE]");
    expect(promptText).toContain("[SOP-114 §3.2]");
    expect(promptText).toContain("FAIL [❌]");
    expect(promptText).toContain("RECHECK WELD JOINT 4B");
    expect(promptText).toContain("approvalAuthority");
  });
});
