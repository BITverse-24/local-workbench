import { describe, expect, it } from "vitest";
import { pickDriverModel } from "../src/main/router/driver-router.js";
import { composeTools } from "../src/main/router/tool-compositor.js";
import type { AttachmentReference } from "../src/shared/contracts.js";

describe("Driver Router & Tool Surface Compositor", () => {
  it("routes code repair tasks to code-qwen25coder", () => {
    const pyAttachment: AttachmentReference = {
      attachmentId: "1",
      filename: "broken.py",
      mediaType: "text/x-python",
      sizeBytes: 100,
      relativePath: "runs/1/input/broken.py",
    };

    const decision = pickDriverModel("Fix this bug crashing in parser", [pyAttachment], false);
    expect(decision.modelId).toBe("code-qwen25coder");
    expect(decision.taskType).toBe("code");
  });

  it("routes workspace routes and middleware tasks to code-qwen25coder", () => {
    const decision = pickDriverModel(
      "In the current workspace directory, add some more basic routes and a rate limiter middleware",
      [],
      true,
    );
    expect(decision.modelId).toBe("code-qwen25coder");
    expect(decision.taskType).toBe("code");
  });

  it("routes document analysis / drafting to draft-qwen3", () => {
    const pdfAttachment: AttachmentReference = {
      attachmentId: "2",
      filename: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 200,
      relativePath: "runs/1/input/report.pdf",
    };

    const decision = pickDriverModel("Read report and draft approval note", [pdfAttachment], false);
    expect(decision.modelId).toBe("draft-qwen3");
    expect(decision.taskType).toBe("draft");
  });

  it("defaults pure chat to draft-qwen3", () => {
    const decision = pickDriverModel("What is a heat exchanger?", [], false);
    expect(decision.modelId).toBe("draft-qwen3");
    expect(decision.taskType).toBe("draft");
  });

  it("composes tools based strictly on environment state", () => {
    // 1. Minimal environment (no workspace, no attachments, no KB)
    const minTools = composeTools(
      { hasWorkspace: false, hasAttachments: false, hasKnowledgeBaseDocs: false },
      "draft-qwen3",
    );
    const minNames = minTools.map((t) => t.name);
    expect(minNames).toContain("execute_python");
    expect(minNames).toContain("generate_deliverable");
    expect(minNames).toContain("generate_code"); // Specialist tool because draft is driver
    expect(minNames).not.toContain("generate_text"); // Excluded because draft IS the driver
    expect(minNames).not.toContain("extract_document"); // No attachments
    expect(minNames).not.toContain("retrieve_knowledge"); // No KB docs

    // 2. Full environment with attachments and KB
    const fullTools = composeTools(
      { hasWorkspace: true, hasAttachments: true, hasKnowledgeBaseDocs: true },
      "code-qwen25coder",
    );
    const fullNames = fullTools.map((t) => t.name);
    expect(fullNames).toContain("extract_document");
    expect(fullNames).toContain("retrieve_knowledge");
    expect(fullNames).toContain("generate_text"); // Code model driving can delegate to draft model
    expect(fullNames).not.toContain("generate_code"); // Code model doesn't need generate_code tool
    expect(fullNames).toContain("list_dir");
    expect(fullNames).toContain("write_file");
  });
});
