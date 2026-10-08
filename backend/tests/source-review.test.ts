import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { enforceSourceConditionalPreconditions, findingsTableAlignmentGaps, linkRecommendationsToSubjects, preserveExtractedAnnotations, preserveExtractedFindings, preserveMissingSubjectSections, reviewAttachedPython, reviewProposedPython } from "../src/main/agent/source-review.js";
import { runRoot } from "../src/main/run/filesystem.js";
import type { ModelGateway } from "../src/main/gateway/model-gateway.js";
import type { ModelId } from "../src/shared/contracts.js";

function reviewGateway(content: string) {
  return { chatWithTools: vi.fn(async () => ({ ok: true, value: { content, finishReason: "stop" } })) } as unknown as ModelGateway;
}

async function reviewAttachedCode(content: string) {
  const runId = randomUUID();
  try {
    return await reviewAttachedPython({
      gateway: reviewGateway(content), modelId: "primary-model" as ModelId, runId,
      request: "Repair the attached source while preserving its interface.",
      sourceEvidence: "def summarize(path):\n    return read_rows(path)",
      sourceChecklist: JSON.stringify({ checks: ["Preserve the callable interface.", "Return the rows read from the input."] }),
      currentSource: "def summarize(path):\n    return read_rows(path)",
      executionOutput: "[]",
    });
  } finally {
    rmSync(runRoot(runId), { recursive: true, force: true });
  }
}

const twoSatisfiedChecks = JSON.stringify([
  { index: 0, check: "The callable interface is retained", status: "satisfied", issue: "The callable name and parameter are retained.", sourceEvidence: "def summarize(path):", implementationEvidence: "def summarize(path):" },
  { index: 1, check: "The input rows are returned", status: "satisfied", issue: "The function returns the rows read from the supplied path.", sourceEvidence: "return read_rows(path)", implementationEvidence: "return read_rows(path)" },
]);

describe("code review evidence contract", () => {
  it("rejects a bare satisfied label without an explanation", async () => {
    const checks = JSON.parse(twoSatisfiedChecks);
    checks[0].issue = "";
    await expect(reviewAttachedCode(JSON.stringify(checks))).rejects.toThrow("did not assess every source-derived check");
  });
});

describe("grounded findings table alignment", () => {
  it("flags an assessment placed in the requirement column", () => {
    const candidate = [
      "| Identifier | Observation | Requirement | Assessment | Action | Evidence |",
      "|---|---|---|---|---|---|",
      "| Item A | Observed value | Compliant | None | None | Source §2 |",
    ].join("\n");

    expect(findingsTableAlignmentGaps(candidate)).toEqual([
      "Findings row for Item A: a status is in Requirement. Put the applicable source criterion in Requirement and the status in Assessment.",
    ]);
  });

  it("accepts a row with a criterion and an assessment in their matching columns", () => {
    const candidate = [
      "| Identifier | Observation | Requirement | Assessment | Action | Evidence |",
      "|---|---|---|---|---|---|",
      "| Item A | Observed value | Applicable minimum | Non-compliant | Correct the item | Source §2 |",
    ].join("\n");

    expect(findingsTableAlignmentGaps(candidate)).toEqual([]);
  });

  it("keeps a recommendation linked to its existing subject heading", () => {
    const candidate = [
      "## Report ID: REF-2026-01",
      "### Equipment: Unit Alpha",
      "**Action Required:**",
      "- Retest after repair. [Standard §2]",
    ].join("\n");

    expect(linkRecommendationsToSubjects(candidate)).toContain("- Retest after repair. [Standard §2]");
    expect(linkRecommendationsToSubjects(candidate)).toContain("**Action Required:**");
  });

  it("links inline recommendation text to the subject heading", () => {
    const candidate = [
      "## Report ID: REF-2026-01",
      "### Equipment: Unit Alpha",
      "**Recommendation:** Conditional release after the supported repair. [Standard §2]",
      "**Grounding References:**",
      "- Standard §2",
    ].join("\n");

    const linked = linkRecommendationsToSubjects(candidate);
    expect(linked).toContain("Recommendation for Unit Alpha: Conditional release after the supported repair. [Standard §2]");
    expect(linked).not.toContain("For Unit Alpha: **Grounding References:**");
  });

  it("links a separate approval decision to the subject heading", () => {
    const candidate = "## Report ID: REF-1\n### Asset: Unit Alpha\n**Approval decision:** Pending the required evidence.";
    expect(linkRecommendationsToSubjects(candidate)).toContain("Approval decision for Unit Alpha: Pending the required evidence.");
  });

  it("preserves previously covered subject sections when a correction omits them", () => {
    const previous = "## Report ID: R-1\n### Equipment: Unit Alpha\nFinding: inspect seal";
    const corrected = "# Report\n\n## Report ID: R-2\n### Equipment: Unit Beta\nFinding: replace gasket\n\n## Source documents\n- report.pdf";
    const merged = preserveMissingSubjectSections(previous, corrected);
    expect(merged.indexOf("Unit Alpha")).toBeGreaterThanOrEqual(0);
    expect(merged.indexOf("Unit Beta")).toBeGreaterThanOrEqual(0);
    expect(merged.indexOf("Unit Beta")).toBeLessThan(merged.indexOf("Source documents"));
    expect(merged.indexOf("Unit Alpha")).toBeLessThan(merged.indexOf("Source documents"));
  });

  it("does not duplicate a subject already covered by a corrected section", () => {
    const previous = "## Report ID: R-1\n### Equipment: Unit Alpha\nFinding: retain this";
    const corrected = "## Report ID: R-1\n### Equipment: Unit Alpha\nFinding: corrected";
    expect(preserveMissingSubjectSections(previous, corrected).match(/Finding:/g)).toHaveLength(1);
  });

  it("preserves exact extracted annotations under the matching subject", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf (application/pdf, 2 pages) ---",
      "Report ID: R-1\nEquipment: Unit Alpha",
      'Source annotations preceding reviewer/inspector attribution (verbatim evidence): [{"page":2,"text":"Inspect the joint again."}]',
      "--- END ATTACHED FILE: report.pdf ---",
    ].join("\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\nFindings complete.\n\n## Source documents\n- report.pdf";
    const preserved = preserveExtractedAnnotations(evidence, candidate);
    expect(preserved).toContain("**Source annotation for R-1:** Inspect the joint again. (report.pdf, p. 2)");
  });

  it("restores annotation records supplied as structured extraction data", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf ---\nReport ID: R-1\nEquipment: Unit Alpha\n--- END ATTACHED FILE: report.pdf ---",
      'EXTRACTED SOURCE ANNOTATIONS JSON:\n[{"text":"Check the repaired item.","sourceFile":"report.pdf","page":2}]',
    ].join("\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\nFindings.\n\n## Source documents\n- report.pdf";
    expect(preserveExtractedAnnotations(evidence, candidate)).toContain("Check the repaired item.");
  });

  it("restores omitted structured findings with their source and subject", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf (application/pdf, 2 pages) ---",
      "Report ID: R-1\nEquipment: Unit Alpha",
      "--- END ATTACHED FILE: report.pdf ---",
      'EXTRACTED DOCUMENT FINDINGS JSON:\n[{"title":"Surface condition","value":"Localized wear was observed.","evidence":"page record","sourceFile":"report.pdf","page":2}]',
      "EXTRACTED SOURCE ANNOTATIONS JSON:\n[]",
    ].join("\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\nInitial finding.\n\n## Source documents\n- report.pdf";
    const preserved = preserveExtractedFindings(evidence, candidate);
    expect(preserved).toContain("**Surface condition:** Localized wear was observed.");
    expect(preserved).toContain("report.pdf, p. 2");
  });

  it("keeps a conditional decision pending when its retrieved prerequisite is not in the source", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf ---\nReport ID: R-1\nEquipment: Unit Alpha\nObserved condition recorded.\n--- END ATTACHED FILE: report.pdf ---",
      "RETRIEVED CRITERIA:\nConditional release may be recorded only when the sample set is approved.",
    ].join("\n\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\n**Approval decision:** Conditional release.\n\n## Source documents\n- report.pdf";
    expect(enforceSourceConditionalPreconditions("Draft an approval note.", evidence, candidate))
      .toContain("Approval decision for Unit Alpha: Pending until the source shows that the sample set is approved.");
  });

  it("does not add a pending status when the subject source shows the prerequisite", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf ---\nReport ID: R-1\nEquipment: Unit Alpha\nThe sample set is approved.\n--- END ATTACHED FILE: report.pdf ---",
      "RETRIEVED CRITERIA:\nConditional release may be recorded only when the sample set is approved.",
    ].join("\n\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\n**Approval decision:** Conditional release.\n\n## Source documents\n- report.pdf";
    expect(enforceSourceConditionalPreconditions("Draft an approval note.", evidence, candidate))
      .not.toContain("Pending until the source shows");
  });
});

describe("attached code behavior review", () => {
  it("binds same-count review results to the ordered checks when labels are paraphrased", async () => {
    await expect(reviewAttachedCode(twoSatisfiedChecks)).resolves.toEqual([]);
  });

  it("does not let an ungrounded reviewer claim steer a repair", async () => {
    const ungroundedGap = JSON.stringify([
      { index: 0, check: "Preserve the callable interface.", status: "gap", issue: "Change the interface.", sourceEvidence: "unsupported source quote", implementationEvidence: "missing implementation quote" },
      { index: 1, check: "Return the rows read from the input.", status: "satisfied", issue: "The function returns the rows read from the supplied path.", sourceEvidence: "return read_rows(path)", implementationEvidence: "return read_rows(path)" },
    ]);
    await expect(reviewAttachedCode(ungroundedGap)).resolves.toEqual([]);
  });

  it("returns only pre-execution gaps grounded in both source and proposed code", async () => {
    const gateway = reviewGateway(JSON.stringify({ gaps: [{
      check: "Preserve input conversion behavior.", issue: "Empty input reaches conversion.",
      sourceEvidence: "An empty value is supported by the input contract.",
      implementationEvidence: "float(row.get('value', 0))",
    }] }));
    const findings = await reviewProposedPython({
      gateway, modelId: "primary-model" as ModelId, runId: randomUUID(),
      request: "Repair the attached parser.", sourceEvidence: "An empty value is supported by the input contract.",
      sourceChecklist: JSON.stringify({ checks: ["Handle empty values supported by input."] }),
      proposedSource: "temperature = float(row.get('value', 0))",
    });
    expect(findings).toEqual([{ issue: "Empty input reaches conversion. (check: Preserve input conversion behavior.)", evidence: "An empty value is supported by the input contract." }]);
  });

  it("catches a missing return for a source-declared function contract before execution", async () => {
    const findings = await reviewProposedPython({
      gateway: reviewGateway(JSON.stringify({ gaps: [] })), modelId: "primary-model" as ModelId, runId: randomUUID(),
      request: "Repair the attached source.",
      sourceEvidence: "--- ATTACHED FILE: source.py ---\ndef summarize(path: str) -> dict[str, int]:\n    return {}\n--- END ATTACHED FILE: source.py ---",
      sourceChecklist: JSON.stringify({ checks: ["Preserve the callable return contract."] }),
      proposedSource: "def summarize(path: str) -> dict[str, int]:\n    counts = {}\n",
    });
    expect(findings).toEqual([{
      issue: "Function summarize has no explicit return, but its source declares a non-None return type.",
      evidence: "def summarize(path: str) -> dict[str, int]:",
    }]);
  });

  it("accepts a grounded model finding about an excluded boundary", async () => {
    const runId = randomUUID();
    try {
      const findings = await reviewAttachedPython({
        gateway: reviewGateway(JSON.stringify([{
          index: 0, status: "gap", issue: "The comparison excludes equality.", sourceEvidence: "The inclusive 42.0 upper limit is documented.",
          implementationEvidence: "if reading > 42.0:",
        }])), modelId: "primary-model" as ModelId, runId,
        request: "Repair the attached parser.",
        sourceEvidence: "The inclusive 42.0 upper limit is documented.\nif reading > 42.0:",
        sourceChecklist: JSON.stringify({ checks: ["Ensure readings greater than or equal to 42.0 are included."] }),
        currentSource: "if reading > 42.0:\n    count += 1",
        executionOutput: "count=1",
      });
      expect(findings).toEqual([{
        issue: "The comparison excludes equality. (check: Ensure readings greater than or equal to 42.0 are included.)",
        evidence: "The inclusive 42.0 upper limit is documented.",
      }]);
    } finally {
      rmSync(runRoot(runId), { recursive: true, force: true });
    }
  });
});
