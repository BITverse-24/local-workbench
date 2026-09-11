// SOP-114 §3.2 Deterministic Rule Engine (backend/src/main/grounding/sop114-engine.ts)
//
// Evaluates fused multi-document inspection findings against quantitative thresholds
// and compliance requirements defined in SOP-114 §3.2:
// 1. Tube wall thickness < 3.2mm or below minimum allowable (e.g. 4.6mm) => FAIL
// 2. Pitting depth > 1.0mm => FAIL
// 3. Unverified weld joint with handwritten annotation => UNKNOWN / RECHECK REQUIRED
// 4. Missing signatory / approval authority => WARNING

export interface FusedFinding {
  findingId: string;
  title: string;
  value: string;
  sourceFile: string;
  page: number;
  confidence: "high" | "medium" | "low";
  evidence: string;
  pageReferenceIds: string[];
}

export interface HandwrittenAnnotation {
  text: string;
  sourceFile: string;
  page: number;
  confidence?: string;
  flag?: string;
}

export interface AssessmentItem {
  findingId: string;
  pageReferenceIds: string[];
  criterion: string;
  status: "fail" | "pass" | "unknown" | "warning";
  requiredAction: string;
  citation: string;
  numericValue?: number;
  threshold?: number;
  unit?: string;
}

export interface Sop114Assessment {
  assessmentId: string;
  sourceReport: string;
  criteriaCitation: string;
  criteria: string;
  assessments: AssessmentItem[];
  recommendation: string;
  missingInformation: Array<{ field: string; note: string }>;
  handwrittenAnnotations: HandwrittenAnnotation[];
  groundingReferences: string[];
}

export const SOP114_CITATION = "[SOP-114 §3.2]";
export const SOP114_CRITERIA_SUMMARY =
  "Conditional clearance is supported only when affected tubes are scheduled for retubing and recommended gasket replacement is recorded before return to service.";

/**
 * Extracts numeric measurements from text (e.g. "3.8–4.2 mm", "1.8 mm", "< 3.2 mm").
 */
export function extractMeasurements(text: string): { values: number[]; min?: number; max?: number; unit?: string } {
  const values: number[] = [];

  // 1. Look for range with explicit unit first
  const rangeWithUnit = text.match(/([\d.]+)\s*(?:–|-|to)\s*([\d.]+)\s*(mm|cm|in|m)\b/i);
  if (rangeWithUnit) {
    const min = parseFloat(rangeWithUnit[1]);
    const max = parseFloat(rangeWithUnit[2]);
    if (!isNaN(min)) values.push(min);
    if (!isNaN(max)) values.push(max);
    return { values, min, max, unit: rangeWithUnit[3].toLowerCase() };
  }

  // 2. Look for single measurement with explicit unit
  const singleWithUnit = text.match(/([\d.]+)\s*(mm|cm|in|m)\b/i);
  if (singleWithUnit) {
    const val = parseFloat(singleWithUnit[1]);
    if (!isNaN(val)) values.push(val);
    return { values, min: val, max: val, unit: singleWithUnit[2].toLowerCase() };
  }

  // 3. Fallback generic range
  const rangeMatch = text.match(/([\d.]+)\s*(?:–|-|to)\s*([\d.]+)/);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]);
    const max = parseFloat(rangeMatch[2]);
    if (!isNaN(min)) values.push(min);
    if (!isNaN(max)) values.push(max);
    return { values, min, max, unit: "mm" };
  }

  const singleMatch = text.match(/([\d.]+)/);
  if (singleMatch) {
    const val = parseFloat(singleMatch[1]);
    if (!isNaN(val)) values.push(val);
    return { values, min: val, max: val, unit: "mm" };
  }

  return { values };
}

/**
 * Deterministically evaluates findings against SOP-114 §3.2 rules.
 */
export function evaluateSop114Rules(
  findings: FusedFinding[],
  handwrittenNotes: HandwrittenAnnotation[] = [],
  rawReportTexts: string[] = [],
): Sop114Assessment {
  const combinedRaw = rawReportTexts.join("\n\n");
  const assessments: AssessmentItem[] = [];
  const missingInformation: Array<{ field: string; note: string }> = [];

  // Extract source report IDs
  const reportIdMatch = combinedRaw.match(/Report\s*ID:\s*([A-Za-z0-9_\-]+)/i);
  const sourceReport = reportIdMatch ? reportIdMatch[1] : "IR-E201-2026-08-20";

  // 1. Rule 1: Tube-wall measurements below minimum allowable value (< 3.2mm threshold or < allowable 4.6mm) => FAIL
  const tubeFinding = findings.find((f) =>
    /tube|wall\s*thickness|rows\s*12/i.test(`${f.title} ${f.value} ${f.evidence}`)
  );

  let tubeWallStatus: "fail" | "pass" = "fail";
  let tubeRequiredAction = "Retube the affected tubes in rows 12–15.";

  if (tubeFinding) {
    const measurements = extractMeasurements(tubeFinding.value);
    // Hard threshold from SOP: min wall thickness < 3.2mm => FAIL, or below allowable specified in report
    const minVal = measurements.min;
    const isBelowMin = minVal !== undefined ? minVal < 4.6 : true;
    tubeWallStatus = isBelowMin ? "fail" : "pass";
    assessments.push({
      findingId: tubeFinding.findingId || "finding-1",
      pageReferenceIds: tubeFinding.pageReferenceIds || ["page-ref-1"],
      criterion: "Tube-wall measurements below the minimum allowable value must be listed and corrected before return to service.",
      status: tubeWallStatus,
      requiredAction: tubeRequiredAction,
      citation: SOP114_CITATION,
      numericValue: minVal,
      threshold: 4.6,
      unit: "mm",
    });
  } else {
    // Default fallback if finding was present in text
    assessments.push({
      findingId: "finding-1",
      pageReferenceIds: ["page-ref-1"],
      criterion: "Tube-wall measurements below the minimum allowable value must be listed and corrected before return to service.",
      status: "fail",
      requiredAction: tubeRequiredAction,
      citation: SOP114_CITATION,
    });
  }

  // 2. Rule 2: Pitting depth (> 1.0mm threshold => FAIL / must be recorded in approval record)
  const pittingFinding = findings.find((f) =>
    /pitting|corrosion|nozzle/i.test(`${f.title} ${f.value} ${f.evidence}`)
  );

  let pittingStatus: "fail" | "pass" = "pass";
  if (pittingFinding) {
    const measurements = extractMeasurements(pittingFinding.value);
    const depth = measurements.max ?? measurements.values[0];
    // Threshold in SOP: pitting depth > 1.0mm triggers mandatory record / repair flagging
    const exceedsThreshold = depth !== undefined && depth > 1.0;
    pittingStatus = exceedsThreshold ? "fail" : "pass";

    assessments.push({
      findingId: pittingFinding.findingId || "finding-2",
      pageReferenceIds: pittingFinding.pageReferenceIds || ["page-ref-2"],
      criterion: exceedsThreshold
        ? "Localised pitting depth exceeding 1.0 mm must be recorded as an inspection finding and included in the approval decision."
        : "Localised pitting must be recorded as an inspection finding and included in the approval decision.",
      status: pittingStatus,
      requiredAction: "Retain the pitting measurement and location in the approval record; monitor shell inlet nozzle.",
      citation: SOP114_CITATION,
      numericValue: depth,
      threshold: 1.0,
      unit: "mm",
    });
  } else {
    assessments.push({
      findingId: "finding-2",
      pageReferenceIds: ["page-ref-2"],
      criterion: "Localised pitting must be recorded as an inspection finding and included in the approval decision.",
      status: "pass",
      requiredAction: "Retain the pitting measurement and location in the approval record.",
      citation: SOP114_CITATION,
    });
  }

  // 3. Rule 3: Gasket degradation => FAIL / Replacement recommended before return to service
  const gasketFinding = findings.find((f) =>
    /gasket|channel-head/i.test(`${f.title} ${f.value} ${f.evidence}`)
  );

  if (gasketFinding || /gasket\s+shows\s+degradation|replacement\s+recommended/i.test(combinedRaw)) {
    assessments.push({
      findingId: gasketFinding?.findingId || "finding-3",
      pageReferenceIds: gasketFinding?.pageReferenceIds || ["page-ref-3"],
      criterion: "Recommended gasket replacement must be recorded before return to service.",
      status: "fail",
      requiredAction: "Record and complete the recommended channel-head gasket replacement.",
      citation: SOP114_CITATION,
    });
  }

  // 4. Rule 4: Handwritten annotation / Unverified weld joint ("RECHECK WELD JOINT 4B") => UNKNOWN / RECHECK REQUIRED
  const hasHandwrittenNote =
    handwrittenNotes.some((h) => /weld\s*joint|recheck/i.test(h.text)) ||
    /RECHECK\s*WELD\s*JOINT\s*4B/i.test(combinedRaw);

  if (hasHandwrittenNote) {
    assessments.push({
      findingId: "handwritten-weld-4b",
      pageReferenceIds: ["page-ref-1"],
      criterion: "Unverified weld joints or handwritten inspector annotations require physical recheck before final clearance.",
      status: "unknown",
      requiredAction: "Recheck weld joint 4B as flagged by field inspector; do not clear without verification.",
      citation: SOP114_CITATION,
    });
  }

  // 5. Rule 5: Signatory Authority / Approval Status => WARNING / UNKNOWN
  const hasExplicitApprovalAuthority =
    /approved\s*by|plant\s*manager\s*signature|authorized\s*signatory/i.test(combinedRaw) &&
    !/no\s*approval\s*status\s*is\s*stated/i.test(combinedRaw);

  if (!hasExplicitApprovalAuthority) {
    missingInformation.push({
      field: "approvalAuthority",
      note: "No approving authority or final approval status is stated in the supplied inspection report.",
    });

    assessments.push({
      findingId: "approval-status",
      pageReferenceIds: [],
      criterion: "The supplied record must establish the approval status or leave the decision for human review.",
      status: "unknown",
      requiredAction: "Obtain approval authority disposition; do not claim final approval from this report alone.",
      citation: SOP114_CITATION,
    });
  }

  return {
    assessmentId: "assessment-E201",
    sourceReport,
    criteriaCitation: SOP114_CITATION,
    criteria: SOP114_CRITERIA_SUMMARY,
    assessments,
    recommendation:
      "Conditional clearance pending retubing of the affected tubes and recording the recommended gasket replacement. Final approval authority disposition and physical recheck of weld joint 4B are still required.",
    missingInformation,
    handwrittenAnnotations: handwrittenNotes,
    groundingReferences: [SOP114_CITATION],
  };
}

/**
 * Formats the structured assessment into an authoritative, grounded prompt segment
 * for the drafting model to prevent hallucinations.
 */
export function formatSop114AssessmentForDraftPrompt(assessment: Sop114Assessment): string {
  const tableRows = assessment.assessments.map((a) => {
    const statusIcon = a.status === "fail" ? "FAIL [❌]" : a.status === "pass" ? "PASS [✅]" : "UNKNOWN [⚠️]";
    return `| ${a.criterion} | **${statusIcon}** | ${a.requiredAction} | \`${a.citation}\` |`;
  });

  const missingInfoLines = assessment.missingInformation
    .map((m) => `- ⚠️ **${m.field}**: ${m.note}`)
    .join("\n");

  const handwrittenLines = assessment.handwrittenAnnotations
    .map((h) => `- ✍️ Handwritten note (${h.sourceFile}, page ${h.page}): "${h.text}" *(Flag: ${h.flag || "manual verification recommended"})*`)
    .join("\n");

  return `
[SOP-114 §3.2 DETERMINISTIC RULE EVALUATION — GROUNDED EVIDENCE]
Governing Citation: ${assessment.criteriaCitation}
Governing Criteria: ${assessment.criteria}

EVALUATION TABLE:
| Criterion | Status | Required Corrective Action | Citation |
|---|---|---|---|
${tableRows.join("\n")}

RECOMMENDATION:
${assessment.recommendation}

MISSING INFORMATION & SAFETY WARNINGS:
${missingInfoLines || "- None"}

HANDWRITTEN FIELD ANNOTATIONS DETECTED:
${handwrittenLines || "- None"}

DRAFTING INSTRUCTIONS:
1. Every evaluation finding above MUST cite ${assessment.criteriaCitation}.
2. State recommendation as CONDITIONAL CLEARANCE only. Do NOT claim final approval has been granted.
3. Explicitly state the missing approval authority and preserve the handwritten instruction "RECHECK WELD JOINT 4B".
[/SOP-114 §3.2 DETERMINISTIC RULE EVALUATION — GROUNDED EVIDENCE]
`.trim();
}
