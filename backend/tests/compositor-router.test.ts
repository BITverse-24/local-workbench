import { describe, expect, it } from "vitest";
import { pickDriverModel } from "../src/main/router/driver-router.js";
import { composeTools } from "../src/main/router/tool-compositor.js";
import type { AttachmentReference } from "../src/shared/contracts.js";

describe("Driver Router & Tool Surface Compositor", () => {
  it("classifies code repair semantics without selecting a specialized model", () => {
    const pyAttachment: AttachmentReference = {
      attachmentId: "1",
      filename: "broken.py",
      mediaType: "text/x-python",
      sizeBytes: 100,
      relativePath: "runs/1/input/broken.py",
    };

    const decision = pickDriverModel("Fix this bug crashing in parser", [pyAttachment], false);
    expect(decision.modelId).toBe("primary-model");
    expect(decision.taskType).toBe("code");
  });

  it("keeps the primary model for workspace code tasks", () => {
    const decision = pickDriverModel(
      "In the current workspace directory, add some more basic routes and a rate limiter middleware",
      [],
      true,
    );
    expect(decision.modelId).toBe("primary-model");
    expect(decision.taskType).toBe("code");
  });

  it("keeps one model for active workspace follow-ups", () => {
    const turn1 = pickDriverModel("I think it still uses a fixed 15 min window for 100 requests", [], true);
    expect(turn1.modelId).toBe("primary-model");
    expect(turn1.taskType).toBe("code");

    const turn2 = pickDriverModel("U instead made it into 10 requests per minute bruh", [], true);
    expect(turn2.modelId).toBe("primary-model");
    expect(turn2.taskType).toBe("code");
  });

  it("classifies document drafting without selecting another model", () => {
    const decision = pickDriverModel("Draft an approval note for this project", [], true);
    expect(decision.modelId).toBe("primary-model");
    expect(decision.taskType).toBe("draft");
  });

  it("uses the primary model for document analysis and drafting", () => {
    const pdfAttachment: AttachmentReference = {
      attachmentId: "2",
      filename: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 200,
      relativePath: "runs/1/input/report.pdf",
    };

    const decision = pickDriverModel("Read report and draft approval note", [pdfAttachment], false);
    expect(decision.modelId).toBe("primary-model");
    expect(decision.taskType).toBe("draft");
  });

  it("uses the primary model for pure chat", () => {
    const decision = pickDriverModel("What is a heat exchanger?", [], false);
    expect(decision.modelId).toBe("primary-model");
    expect(decision.taskType).toBe("draft");
  });

  it("composes tools based strictly on environment state", () => {
    // 1. Minimal environment (no workspace, no attachments, no KB)
    const minTools = composeTools(
      { hasWorkspace: false, hasAttachments: false, hasKnowledgeBaseDocs: false },
      "primary-model",
    );
    const minNames = minTools.map((t) => t.name);
    expect(minNames).toContain("execute_python");
    expect(minNames).toContain("generate_deliverable");
    expect(minNames).not.toContain("generate_code");
    expect(minNames).not.toContain("generate_text");
    expect(minNames).not.toContain("extract_document"); // No attachments
    expect(minNames).not.toContain("retrieve_knowledge"); // No KB docs

    // 2. Full environment with attachments and KB
    const fullTools = composeTools(
      { hasWorkspace: true, hasAttachments: true, hasKnowledgeBaseDocs: true },
      "primary-model",
    );
    const fullNames = fullTools.map((t) => t.name);
    expect(fullNames).toContain("extract_document");
    expect(fullNames).toContain("retrieve_knowledge");
    expect(fullNames).not.toContain("generate_text");
    expect(fullNames).not.toContain("generate_code");
    expect(fullNames).toContain("list_dir");
    expect(fullNames).toContain("write_file");
  });
});
