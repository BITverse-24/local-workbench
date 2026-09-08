import { describe, expect, it } from "vitest";
import type { DraftResult, RetrievedKnowledgeChunk, VisionResult } from "./contracts";
import {
  LOCKED_FLOW_A_REQUIRED_FINDINGS,
  validateCodeDraftResult,
  validateDraftResult,
  validateVisionResult,
} from "./validation";

const vision: VisionResult = {
  sourceText: "Heat Exchanger E-201. Rows 12-15 measured 3.8-4.2 mm; minimum allowable is 4.6 mm. Localised pitting corrosion maximum depth 1.8 mm. Channel-head gasket degradation; replacement recommended.",
  findings: [
    { findingId: "finding-1", title: "Tube wall thickness below minimum allowable", value: "Rows 12-15 measured 3.8-4.2 mm; minimum allowable is 4.6 mm", pageReferenceIds: ["page-ref-1"], confidence: "high", evidence: "The report states the measured range and minimum allowable value." },
    { findingId: "finding-2", title: "Localised pitting corrosion at shell inlet nozzle", value: "Maximum depth 1.8 mm", pageReferenceIds: ["page-ref-2"], confidence: "high", evidence: "The report identifies the location and maximum pitting depth." },
    { findingId: "finding-3", title: "Channel-head gasket degradation", value: "Replacement recommended", pageReferenceIds: ["page-ref-3"], confidence: "high", evidence: "The report states the gasket condition and recommendation." },
  ],
  pageReferences: [
    { id: "page-ref-1", page: 1, text: "Rows 12-15 measured 3.8-4.2 mm; minimum allowable is 4.6 mm" },
    { id: "page-ref-2", page: 1, text: "Localised pitting corrosion maximum depth 1.8 mm" },
    { id: "page-ref-3", page: 2, text: "Channel-head gasket degradation; replacement recommended" },
  ],
  warnings: [],
};

const chunk: RetrievedKnowledgeChunk = {
  chunkId: "chunk-1", documentId: "SOP-114", sectionId: "3.2", label: "SOP-114 §3.2",
  documentTitle: "Pressure Equipment Inspection and Approval", excerpt: "Conditional clearance pending retubing of affected tubes.",
};

const draft: DraftResult = {
  title: "Approval Note — Heat Exchanger E-201",
  body: "Conditional clearance pending retubing of affected tubes. [SOP-114 §3.2]",
  sections: [
    { id: "equipment-header", heading: "Equipment", body: "Heat Exchanger E-201" },
    { id: "findings-summary", heading: "Findings", body: "Tube wall thickness 3.8-4.2 mm; pitting corrosion maximum depth 1.8 mm; gasket replacement recommended." },
    { id: "recommendation", heading: "Recommendation", body: "Conditional clearance pending retubing of affected tubes. [SOP-114 §3.2]" },
    { id: "grounding-references", heading: "Grounding references", body: "[SOP-114 §3.2]" },
  ],
  citations: [{ documentId: "SOP-114", sectionId: "3.2", label: "SOP-114 §3.2", inlineText: "[SOP-114 §3.2]", supportingExcerpt: chunk.excerpt }],
  missingInformation: [{ field: "inspectionDate", note: "Not present in the supplied OCR findings." }],
};

describe("pure AI response validators", () => {
  it("accepts supported OCR and enforces locked required findings", () => {
    expect(validateVisionResult(vision, { requiredFindings: LOCKED_FLOW_A_REQUIRED_FINDINGS }).ok).toBe(true);
  });

  it("rejects an unknown page reference and unsupported finding claim", () => {
    const invalid = structuredClone(vision);
    invalid.findings[0].pageReferenceIds = ["missing-page"];
    invalid.findings[1].value = "Inspector approved the equipment";
    const result = validateVisionResult(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.path)).toEqual(expect.arrayContaining(["result.findings[0].pageReferenceIds", "result.findings[1].value"]));
  });

  it("requires fixed draft sections and retrieved citation membership", () => {
    expect(validateDraftResult(draft, { retrievedChunks: [chunk], sourceText: vision.sourceText, findings: vision.findings, pageReferences: vision.pageReferences, requiredCitations: [{ documentId: "SOP-114", sectionId: "3.2" }] }).ok).toBe(true);
    const invalid = structuredClone(draft);
    invalid.sections = invalid.sections.slice(1);
    invalid.citations[0].documentId = "NOT-RETRIEVED";
    const result = validateDraftResult(invalid, { retrievedChunks: [chunk], findings: vision.findings, pageReferences: vision.pageReferences });
    expect(result.ok).toBe(false);
  });

  it("requires an explicit no-source outcome", () => {
    const noSource = structuredClone(draft);
    noSource.citations = [];
    noSource.body = "No suitable knowledge source was retrieved.";
    noSource.sections[2].body = "Recommendation unavailable because no source was retrieved.";
    noSource.sections[3].body = "No grounding references retrieved.";
    noSource.missingInformation = [{ field: "knowledgeSources", note: "No suitable source was retrieved." }];
    expect(validateDraftResult(noSource, { retrievedChunks: [] }).ok).toBe(true);
  });

  it("rejects unsafe code, path names, extra fields, and hard-coded counts", () => {
    const invalid = {
      filename: "run.sh", source: "import subprocess\nprint('OUT_OF_RANGE 7/240 (high=5, low=2)')", expectedResult: "OUT_OF_RANGE 7/240 (high=5, low=2)",
      inputFiles: ["../reactor-temperature-log.csv"], outputFiles: ["out-of-range-rows.csv"], allowedImports: ["subprocess"], extra: true,
    };
    expect(validateCodeDraftResult(invalid).ok).toBe(false);
  });
});
