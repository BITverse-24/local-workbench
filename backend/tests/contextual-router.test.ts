import { describe, expect, it } from "vitest";
import { resolveSemanticIntent, extractReferencedFiles } from "../src/main/router/contextual-router.js";
import type { AttachmentReference } from "../src/shared/contracts.js";

describe("Contextual Semantic Intent & Routing Engine", () => {
  it("short-circuits pure visual document inspection when image/PDF is attached without workspace", async () => {
    const pdfAttachment: AttachmentReference = {
      attachmentId: "att_1",
      filename: "inspection_report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      relativePath: "runs/1/input/inspection_report.pdf",
    };

    const intent = await resolveSemanticIntent({
      userPrompt: "Extract findings from this inspection document",
      attachments: [pdfAttachment],
      hasWorkspace: false,
    });

    expect(intent.driverModel).toBe("vision-qwen25vl");
    expect(intent.taskType).toBe("vision");
    expect(intent.intentType).toBe("file_inspection");
  });

  it("extracts referenced files across text, @ mentions, and multi-turn history", () => {
    const history = [
      { role: "user", content: "Can you look at app.js and check the routes?" },
      { role: "assistant", content: "I've reviewed app.js." },
    ];
    const workspaceFiles = ["app.js", "middleware/rateLimiter.js", "routes/index.js", "package.json"];

    // User refers to @middleware/rateLimiter.js
    const files = extractReferencedFiles(
      "Make @middleware/rateLimiter.js variable time window based",
      history,
      workspaceFiles,
    );

    expect(files).toContain("middleware/rateLimiter.js");
    expect(files).toContain("app.js");
  });

  it("contextually routes conversational follow-ups in an active workspace to code-qwen25coder", async () => {
    const history = [
      { role: "user", content: "Make @middleware/rateLimiter.js variable time window based" },
      { role: "assistant", content: "I have updated the rate limiter." },
    ];
    const workspaceFiles = ["app.js", "middleware/rateLimiter.js", "package.json"];

    // Follow-up 1: "I think it still uses a fixed 15 min window for 100 requests" (zero generic code words)
    const intent1 = await resolveSemanticIntent({
      userPrompt: "I think it still uses a fixed 15 min window for 100 requests",
      hasWorkspace: true,
      workspaceFiles,
      history,
    });

    expect(intent1.driverModel).toBe("code-qwen25coder");
    expect(intent1.taskType).toBe("code");
    expect(intent1.isActionable).toBe(true);
    expect(intent1.targetFiles).toContain("middleware/rateLimiter.js");

    // Follow-up 2: Colloquial correction ("bruh")
    const intent2 = await resolveSemanticIntent({
      userPrompt: "U instead made it into 10 requests per minute bruh",
      hasWorkspace: true,
      workspaceFiles,
      history,
    });

    expect(intent2.driverModel).toBe("code-qwen25coder");
    expect(intent2.taskType).toBe("code");
    expect(intent2.isActionable).toBe(true);
    expect(intent2.targetFiles).toContain("middleware/rateLimiter.js");
  });

  it("routes explicit formal document drafting in workspace to draft-qwen3", async () => {
    const intent = await resolveSemanticIntent({
      userPrompt: "Draft an approval note memo for this release to be signed by the lead engineer",
      hasWorkspace: true,
      workspaceFiles: ["app.js", "package.json"],
    });

    expect(intent.driverModel).toBe("draft-qwen3");
    expect(intent.taskType).toBe("draft");
    expect(intent.intentType).toBe("document_drafting");
  });

  it("uses LLM semantic classification when gateway is provided with model response", async () => {
    const mockGateway = {
      async execute(req: any) {
        return {
          ok: true,
          value: {
            result: {
              text: JSON.stringify({
                intentType: "code_modification",
                taskType: "code",
                driverModel: "code-qwen25coder",
                primaryGoal: "Refactor rate limiter to sliding window",
                targetFiles: ["middleware/rateLimiter.js"],
                isActionable: true,
                reason: "User requested sliding window refactor on existing middleware",
              }),
            },
          },
        };
      },
    };

    const intent = await resolveSemanticIntent(
      {
        userPrompt: "Make it a sliding window with Redis or in-memory map",
        hasWorkspace: true,
        workspaceFiles: ["middleware/rateLimiter.js"],
      },
      mockGateway as any,
    );

    expect(intent.driverModel).toBe("code-qwen25coder");
    expect(intent.primaryGoal).toBe("Refactor rate limiter to sliding window");
    expect(intent.targetFiles).toEqual(["middleware/rateLimiter.js"]);
    expect(intent.isActionable).toBe(true);
  });
});
