import { describe, expect, it } from "vitest";
import {
  buildDraftUserPrompt,
  buildVisionRepairPrompt,
  CODE_SYSTEM_PROMPT,
  DRAFT_SYSTEM_PROMPT,
  VISION_SYSTEM_PROMPT,
  VISION_USER_PROMPT,
} from "../src/main/run/prompts.js";

// These prompts are verbatim copies of ai/*.md. The tests pin the lockstep
// markers so a future edit can't silently revert to a placeholder one-liner.
describe("ai/ prompt wiring", () => {
  it("vision prompts match ai/ocr-vision-prompt.md", () => {
    expect(VISION_SYSTEM_PROMPT).toContain("Return only one valid JSON object matching this exact shape:");
    expect(VISION_SYSTEM_PROMPT).toContain("pageReferenceIds");
    expect(VISION_SYSTEM_PROMPT).toContain("Do not add fields, omit required fields, use null, or return prose outside the JSON object.");
    expect(VISION_USER_PROMPT).toContain("Extract the inspection report in the attached clean typed scan.");
  });
  it("draft prompts match ai/approval-note-drafting-prompt.md", () => {
    expect(DRAFT_SYSTEM_PROMPT).toContain("grounding-references");
    expect(DRAFT_SYSTEM_PROMPT).toContain("Use inlineText like [SOP-114 §3.2].");
    const user = buildDraftUserPrompt(
      "Heat Exchanger E-201 Report IR-E201-2026-08-20",
      [{ findingId: "f1", title: "t", value: "v", pageReferenceIds: ["p1"], confidence: "high", evidence: "e" }],
      [{ id: "p1", page: 1, text: "excerpt" }],
      [{ documentId: "SOP-114", sectionId: "3.2", label: "SOP-114 §3.2", chunkId: "c1", documentTitle: "SOP", excerpt: "x" }],
      ["equipment-header"],
    );
    expect(user).toContain('"findingId":"f1"');
    expect(user).toContain('"sectionId":"3.2"');
    expect(user).toContain('"equipment-header"');
    expect(user).toContain("Heat Exchanger E-201");
    expect(user).not.toContain("<FINDINGS_JSON>");
    expect(user).not.toContain("<RETRIEVED_CHUNKS_JSON>");
    expect(user).not.toContain("<TEMPLATE_REQUIREMENTS_JSON>");
    expect(user).not.toContain("<SOURCE_TEXT>");
  });
  it("code prompt matches ai/coding-prompt.md", () => {
    expect(CODE_SYSTEM_PROMPT).toContain("reactor-temperature-log.csv");
    expect(CODE_SYSTEM_PROMPT).toContain("OUT_OF_RANGE 7/240 (high=5, low=2)");
    expect(CODE_SYSTEM_PROMPT).toContain('allowedImports must contain only "csv" and "datetime".');
  });
  it("vision repair prompt keeps the ai/ contract and quotes the failure", () => {
    const repaired = buildVisionRepairPrompt("vision result failed validation at 'sourceText': boom");
    expect(repaired).toContain("You extract evidence from clean typed inspection-report scans.");
    expect(repaired).toContain("vision result failed validation at 'sourceText': boom");
    expect(repaired).toContain("never an empty string");
    expect(repaired).toMatch(/json/i);
  });
});
