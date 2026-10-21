import type { RunVerificationReport, VerificationCheck, VerificationStatus } from "../../../backend/src/shared/contracts.js";

export type CheckCategory =
  | "defect"
  | "boundary"
  | "interface"
  | "cli"
  | "flow"
  | "coverage"
  | "requirement";

export interface FormattedVerificationCheck {
  criterionId: string;
  requirement: string;
  reason: string;
  status: VerificationStatus;
  mandatory: boolean;
  category: CheckCategory;
  typeLabel: string;
}

export interface VerificationCategoryCount {
  category: CheckCategory;
  label: string;
  total: number;
  passed: number;
}

export interface VerificationSummary {
  status: VerificationStatus;
  headline: string;
  total: number;
  passed: number;
  failed: number;
  unverified: number;
  skipped: number;
  categories: VerificationCategoryCount[];
  attentionChecks: FormattedVerificationCheck[];
  passedChecks: FormattedVerificationCheck[];
  allChecks: FormattedVerificationCheck[];
  terminationDetail?: string;
}

const CATEGORY_LABELS: Record<CheckCategory, string> = {
  defect: "Edge Case & Defect",
  boundary: "Boundary",
  interface: "Interface",
  cli: "CLI & Input",
  flow: "Control Flow",
  coverage: "Source Coverage",
  requirement: "Requirement",
};

function cleanRequirementText(text: string): string {
  return text.replace(/^Correct this original-source defect in behavior:\s*/i, "").trim();
}

function classifyCheck(check: VerificationCheck): { category: CheckCategory; typeLabel: string } {
  const { criterionId } = check;
  const text = check.requirement;

  if (criterionId.startsWith("source:coverage:") || criterionId === "source:review") {
    return { category: "coverage", typeLabel: "Source Coverage" };
  }
  if (
    /\b(?:control-flow|preserve successful|preserve existing|count|summarize|calculate|aggregate)\b/i.test(
      text,
    )
  ) {
    return { category: "flow", typeLabel: "Control Flow" };
  }
  if (
    /\b(?:boundary|inclusive|exclusive|equality|threshold|limit|at or above|at or below|greater than|less than|>=|<=)\b/i.test(
      text,
    )
  ) {
    return { category: "boundary", typeLabel: "Boundary Check" };
  }
  if (
    /\b(?:defect|bug\s*\d*|fixme|malformed|missing|empty|invalid|exception|typeerror|valueerror|keyerror|error|crash|skip)\b/i.test(
      text,
    )
  ) {
    return { category: "defect", typeLabel: "Defect & Edge Case" };
  }
  if (/\b(?:command-line|cli|argv|argument|stdin|stdout)\b/i.test(text)) {
    return { category: "cli", typeLabel: "CLI & Execution" };
  }
  if (
    /\b(?:public interface|return contract|return type|signature|callable|function)\b/i.test(text)
  ) {
    return { category: "interface", typeLabel: "Interface & Contract" };
  }
  return { category: "requirement", typeLabel: "Requirement" };
}

/** Deterministic, zero-compute formatting of the assessed review checks in a RunVerificationReport. */
export function summarizeVerificationReport(report: RunVerificationReport | null | undefined): VerificationSummary | null {
  if (!report || !Array.isArray(report.checks) || report.checks.length === 0) return null;

  const behaviorChecks = report.checks.filter(
    check => check.criterionId.startsWith("behavior:") && check.status !== "not_applicable",
  );

  let selected: VerificationCheck[];
  if (behaviorChecks.length > 0) {
    selected = behaviorChecks;
  } else {
    const hasGranularContentChecks = report.checks.some(
      c => c.criterionId.startsWith("content:") && c.criterionId !== "content:complete_request",
    );
    selected = report.checks.filter(check => {
      if (check.status === "not_applicable") return false;
      if (check.criterionId === "content:complete_request" && hasGranularContentChecks) {
        return false;
      }
      return (
        check.criterionId.startsWith("content:") ||
        check.criterionId.startsWith("source:coverage:") ||
        check.criterionId === "source:review"
      );
    });
  }

  if (selected.length === 0) return null;

  const allChecks: FormattedVerificationCheck[] = selected.map(check => {
    const { category, typeLabel } = classifyCheck(check);
    return {
      criterionId: check.criterionId,
      requirement: cleanRequirementText(check.requirement),
      reason: check.reason,
      status: check.status,
      mandatory: check.mandatory,
      category,
      typeLabel,
    };
  });

  const passedChecks = allChecks.filter(c => c.status === "passed");
  const attentionChecks = allChecks.filter(c => c.status !== "passed");
  const passed = passedChecks.length;
  const failed = allChecks.filter(c => c.status === "failed").length;
  const unverified = allChecks.filter(c => c.status === "unverified").length;
  const skipped = allChecks.filter(c => c.status === "skipped").length;
  const total = allChecks.length;

  const categoryOrder: CheckCategory[] = [
    "defect",
    "boundary",
    "interface",
    "cli",
    "flow",
    "coverage",
    "requirement",
  ];
  const categories: VerificationCategoryCount[] = [];
  for (const cat of categoryOrder) {
    const matching = allChecks.filter(c => c.category === cat);
    if (matching.length > 0) {
      categories.push({
        category: cat,
        label: CATEGORY_LABELS[cat],
        total: matching.length,
        passed: matching.filter(c => c.status === "passed").length,
      });
    }
  }

  let headline = `${passed} of ${total} checks passed`;
  if (failed > 0 && unverified > 0) {
    headline = `${passed} of ${total} passed · ${failed} failed, ${unverified} unverified`;
  } else if (failed > 0) {
    headline = `${passed} of ${total} passed · ${failed} failed`;
  } else if (unverified > 0) {
    headline = `${passed} of ${total} passed · ${unverified} unverified`;
  } else if (skipped > 0) {
    headline = `${passed} of ${total} passed · ${skipped} skipped`;
  }

  return {
    status: report.status,
    headline,
    total,
    passed,
    failed,
    unverified,
    skipped,
    categories,
    attentionChecks,
    passedChecks,
    allChecks,
    terminationDetail: report.termination?.detail,
  };
}
