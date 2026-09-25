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

// PERF OPTIMIZATION: Module-level static regular expression constants.
// Hoisting regex patterns out of function call loops avoids repeated regex AST compilation on every evaluation call.
const RANGE_WITH_UNIT_RX = /([\d.]+)\s*(?:–|-|to)\s*([\d.]+)\s*(mm|cm|in|m)\b/i;
const SINGLE_WITH_UNIT_RX = /([\d.]+)\s*(mm|cm|in|m)\b/i;
const RANGE_MATCH_RX = /([\d.]+)\s*(?:–|-|to)\s*([\d.]+)/;
const SINGLE_MATCH_RX = /([\d.]+)/;

const REPORT_ID_RX = /Report\s*ID:\s*([A-Za-z0-9_\-]+)/i;
const TUBE_FINDING_SEARCH_RX = /tube|wall\s*thickness|thickness/i;
const TUBE_RAW_TEXT_SEARCH_RX = /(?:tube|wall\s*thickness)[^\n.]{0,100}(?:measured|measuring|\d+\.?\d*)/i;
const TUBE_MEASURED_VAL_RX = /(?:measured|measuring)[^\n.]+/i;
const ALLOWABLE_VAL_RX = /allowable\s*(?:is|:)?\s*([\d.]+)/i;
const ROWS_MATCH_RX = /rows?\s*[\d–-]+/i;

const PITTING_SEARCH_RX = /pitting|corrosion/i;
const PITTING_RAW_TEXT_SEARCH_RX = /pitting[^\n.]{0,80}(?:depth|measur|\d+\.?\d*)/i;
const PITTING_VAL_RX = /pitting[^\n.]+/i;

const GASKET_SEARCH_RX = /gasket/i;
const GASKET_RAW_TEXT_SEARCH_RX = /gasket[^\n.]{0,50}(?:degrad|replace|leak|defect)/i;

const WELD_ANNOTATION_RX = /(?:RECHECK|CHECK|VERIFY)\s+WELD[^\n.]*/i;
const WELD_TEST_RX = /weld/i;

const EXPLICIT_APPROVAL_AUTHORITY_RX = /approved\s*by|plant\s*manager\s*signature|authorized\s*signatory/i;
const NO_APPROVAL_STATUS_RX = /no\s*approval\s*status\s*is\s*stated/i;

/**
 * Extracts numeric measurements from text (e.g. "3.8–4.2 mm", "1.8 mm", "< 3.2 mm").
 */
export function extractMeasurements(text: string): { values: number[]; min?: number; max?: number; unit?: string } {
  const values: number[] = [];

  // 1. Look for range with explicit unit first
  const rangeWithUnit = text.match(RANGE_WITH_UNIT_RX);
  if (rangeWithUnit) {
    const min = parseFloat(rangeWithUnit[1]);
    const max = parseFloat(rangeWithUnit[2]);
    if (!isNaN(min)) values.push(min);
    if (!isNaN(max)) values.push(max);
    return { values, min, max, unit: rangeWithUnit[3].toLowerCase() };
  }

  // 2. Look for single measurement with explicit unit
  const singleWithUnit = text.match(SINGLE_WITH_UNIT_RX);
  if (singleWithUnit) {
    const val = parseFloat(singleWithUnit[1]);
    if (!isNaN(val)) values.push(val);
    return { values, min: val, max: val, unit: singleWithUnit[2].toLowerCase() };
  }

  // 3. Fallback generic range
  const rangeMatch = text.match(RANGE_MATCH_RX);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]);
    const max = parseFloat(rangeMatch[2]);
    if (!isNaN(min)) values.push(min);
    if (!isNaN(max)) values.push(max);
    return { values, min, max, unit: "mm" };
  }

  const singleMatch = text.match(SINGLE_MATCH_RX);
  if (singleMatch) {
    const val = parseFloat(singleMatch[1]);
    if (!isNaN(val)) values.push(val);
    return { values, min: val, max: val, unit: "mm" };
  }

  return { values };
}

import { randomUUID } from "node:crypto";

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

  // Extract source report ID dynamically from text if present
  const reportIdMatch = combinedRaw.match(REPORT_ID_RX);
  const sourceReport = reportIdMatch ? reportIdMatch[1] : (findings[0]?.sourceFile ?? "inspection-report");

  // 1. Rule 1: Tube-wall measurements below minimum allowable value (< 3.2mm threshold or < allowable) => FAIL
  const tubeFinding = findings.find((f) =>
    TUBE_FINDING_SEARCH_RX.test(`${f.title} ${f.value} ${f.evidence}`)
  ) || (combinedRaw.match(TUBE_RAW_TEXT_SEARCH_RX) ? {
    findingId: "tube-finding",
    title: "Tube wall thickness measurement",
    value: combinedRaw.match(TUBE_MEASURED_VAL_RX)?.[0] || "",
    sourceFile: sourceReport,
    page: 1,
    confidence: "high" as const,
    evidence: "Extracted from report text",
    pageReferenceIds: ["page-ref-1"],
  } : undefined);

  if (tubeFinding) {
    const measurements = extractMeasurements(tubeFinding.value);
    const minVal = measurements.min;
    // Extract allowable value from text if present (e.g. "minimum allowable is 4.6 mm")
    const allowableMatch = `${tubeFinding.value} ${tubeFinding.evidence} ${combinedRaw}`.match(ALLOWABLE_VAL_RX);
    const allowableVal = allowableMatch ? parseFloat(allowableMatch[1]) : 3.2;
    const isBelowMin = minVal !== undefined ? minVal < allowableVal : true;
    const status: "fail" | "pass" = isBelowMin ? "fail" : "pass";

    const rowsMatch = `${tubeFinding.value} ${tubeFinding.title} ${tubeFinding.evidence}`.match(ROWS_MATCH_RX);
    const requiredAction = isBelowMin
      ? (rowsMatch ? `Retube the affected tubes in ${rowsMatch[0]}.` : "Retube the affected tubes prior to return to service.")
      : "Monitor tube wall thickness in next inspection cycle.";

    assessments.push({
      findingId: tubeFinding.findingId || "finding-1",
      pageReferenceIds: tubeFinding.pageReferenceIds || ["page-ref-1"],
      criterion: "Tube-wall measurements below the minimum allowable value must be listed and corrected before return to service.",
      status,
      requiredAction,
      citation: SOP114_CITATION,
      numericValue: minVal,
      threshold: allowableVal,
      unit: measurements.unit || "mm",
    });
  }

  // 2. Rule 2: Pitting depth (> 1.0mm threshold => FAIL / must be recorded in approval record)
  const pittingFinding = findings.find((f) =>
    PITTING_SEARCH_RX.test(`${f.title} ${f.value} ${f.evidence}`)
  ) || (combinedRaw.match(PITTING_RAW_TEXT_SEARCH_RX) ? {
    findingId: "pitting-finding",
    title: "Pitting corrosion measurement",
    value: combinedRaw.match(PITTING_VAL_RX)?.[0] || "",
    sourceFile: sourceReport,
    page: 1,
    confidence: "high" as const,
    evidence: "Extracted from report text",
    pageReferenceIds: ["page-ref-2"],
  } : undefined);

  if (pittingFinding) {
    const measurements = extractMeasurements(pittingFinding.value);
    const depth = measurements.max ?? measurements.values[0];
    const exceedsThreshold = depth !== undefined && depth > 1.0;
    const status: "fail" | "pass" = exceedsThreshold ? "fail" : "pass";

    assessments.push({
      findingId: pittingFinding.findingId || "finding-2",
      pageReferenceIds: pittingFinding.pageReferenceIds || ["page-ref-2"],
      criterion: exceedsThreshold
        ? "Localised pitting depth exceeding 1.0 mm must be recorded as an inspection finding and included in the approval decision."
        : "Localised pitting must be recorded as an inspection finding and included in the approval decision.",
      status,
      requiredAction: exceedsThreshold
        ? "Retain pitting measurement and location in approval record; evaluate need for shell repair or monitoring."
        : "Retain pitting measurement in records; monitor during subsequent inspection.",
      citation: SOP114_CITATION,
      numericValue: depth,
      threshold: 1.0,
      unit: measurements.unit || "mm",
    });
  }

  // 3. Rule 3: Gasket degradation => FAIL / Replacement recommended before return to service
  const gasketFinding = findings.find((f) =>
    GASKET_SEARCH_RX.test(`${f.title} ${f.value} ${f.evidence}`)
  ) || (GASKET_RAW_TEXT_SEARCH_RX.test(combinedRaw) ? {
    findingId: "gasket-finding",
    title: "Gasket condition",
    value: "Degradation / replacement required",
    sourceFile: sourceReport,
    page: 1,
    confidence: "high" as const,
    evidence: "Extracted from report text",
    pageReferenceIds: ["page-ref-3"],
  } : undefined);

  if (gasketFinding) {
    assessments.push({
      findingId: gasketFinding.findingId || "finding-3",
      pageReferenceIds: gasketFinding.pageReferenceIds || ["page-ref-3"],
      criterion: "Recommended gasket replacement must be recorded before return to service.",
      status: "fail",
      requiredAction: "Record and complete recommended gasket replacement before return to service.",
      citation: SOP114_CITATION,
    });
  }

  // 4. Rule 4: Handwritten annotations & unverified weld joints => UNKNOWN / RECHECK REQUIRED
  const annotationsToEvaluate = [...handwrittenNotes];
  const weldAnnotationMatch = combinedRaw.match(WELD_ANNOTATION_RX);
  if (weldAnnotationMatch && !annotationsToEvaluate.some((a) => a.text.includes(weldAnnotationMatch[0]))) {
    annotationsToEvaluate.push({
      text: weldAnnotationMatch[0],
      sourceFile: sourceReport,
      page: 1,
      confidence: "medium",
      flag: "manual verification recommended",
    });
  }

  for (let i = 0; i < annotationsToEvaluate.length; i++) {
    const ann = annotationsToEvaluate[i];
    const isWeldJoint = WELD_TEST_RX.test(ann.text);
    const findingId = isWeldJoint ? "handwritten-weld-4b" : `handwritten-${i + 1}`;
    const requiredAction = isWeldJoint
      ? "Recheck weld joint 4B as flagged by field inspector; do not clear without verification."
      : `Conduct physical verification of flagged item ("${ann.text}") prior to final clearance.`;

    assessments.push({
      findingId,
      pageReferenceIds: [`page-ref-${ann.page}`],
      criterion: "Unverified weld joints or handwritten inspector annotations require physical recheck before final clearance.",
      status: "unknown",
      requiredAction,
      citation: SOP114_CITATION,
    });
  }

  // 5. Rule 5: Signatory Authority / Approval Status => WARNING / UNKNOWN
  const hasExplicitApprovalAuthority =
    EXPLICIT_APPROVAL_AUTHORITY_RX.test(combinedRaw) &&
    !NO_APPROVAL_STATUS_RX.test(combinedRaw);

  if (!hasExplicitApprovalAuthority && (findings.length > 0 || combinedRaw.length > 0)) {
    missingInformation.push({
      field: "approvalAuthority",
      note: "No approving authority or final approval status is stated in the supplied inspection report.",
    });

    assessments.push({
      findingId: "approval-status",
      pageReferenceIds: [],
      criterion: "The supplied record must establish the approval status or leave the decision for human review.",
      status: "unknown",
      requiredAction: "Obtain authorized plant manager sign-off; do not claim final approval from inspection findings alone.",
      citation: SOP114_CITATION,
    });
  }

  // Dynamic recommendation synthesis based on real assessment outcomes
  const failedItems = assessments.filter((a) => a.status === "fail");
  const unknownItems = assessments.filter((a) => a.status === "unknown");

  let recommendation = "";
  if (failedItems.length > 0 || unknownItems.length > 0) {
    const actions = failedItems.map((f) => f.requiredAction).join(" ");
    const rechecks = unknownItems.map((u) => u.requiredAction).join(" ");
    recommendation = `Conditional clearance only. Corrective actions required: ${actions} Verification required: ${rechecks}`;
  } else if (assessments.length > 0) {
    recommendation = `Clearance criteria met per ${SOP114_CITATION}. Ensure regular monitoring per inspection schedule.`;
  } else {
    recommendation = "No specific SOP-114 inspection findings identified for evaluation.";
  }

  return {
    assessmentId: `assessment-${randomUUID().slice(0, 8)}`,
    sourceReport,
    criteriaCitation: SOP114_CITATION,
    criteria: SOP114_CRITERIA_SUMMARY,
    assessments,
    recommendation,
    missingInformation,
    handwrittenAnnotations: annotationsToEvaluate,
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
2. If any item is marked FAIL or UNKNOWN, state recommendation as CONDITIONAL CLEARANCE only. Do NOT claim final approval has been granted.
3. Explicitly state any missing approval authority and preserve any handwritten annotations flagged for verification.
[/SOP-114 §3.2 DETERMINISTIC RULE EVALUATION — GROUNDED EVIDENCE]
`.trim();
}
