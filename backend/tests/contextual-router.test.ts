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

  it("handles pre-parsed object results from gateway planner without throwing SyntaxError", async () => {
    const mockGateway = {
      async execute(_req: any) {
        return {
          ok: true,
          value: {
            result: {
              intentType: "code_modification",
              taskType: "code",
              driverModel: "code-qwen25coder",
              primaryGoal: "Convert JavaScript codebase to TypeScript",
              targetFiles: ["app.ts"],
              isActionable: true,
              reason: "User requested converting JS to TS",
            },
          },
        };
      },
    };

    const intent = await resolveSemanticIntent(
      {
        userPrompt: "Convert this codebase to typescript",
        hasWorkspace: true,
        workspaceFiles: ["app.js", "package.json"],
      },
      mockGateway as any,
    );

    expect(intent.driverModel).toBe("code-qwen25coder");
    expect(intent.taskType).toBe("code");
    expect(intent.isActionable).toBe(true);
    expect(intent.primaryGoal).toBe("Convert JavaScript codebase to TypeScript");
  });

  it("routes conversational greeting in an active workspace to draft-qwen3 as pure_chat without requiring disk action", async () => {
    const intent = await resolveSemanticIntent({
      userPrompt: "hello",
      hasWorkspace: true,
      workspaceFiles: ["app.js", "package.json"],
    });

    expect(intent.driverModel).toBe("draft-qwen3");
    expect(intent.taskType).toBe("draft");
    expect(intent.isActionable).toBe(false);
    expect(intent.intentType).toBe("pure_chat");
  });

  it("routes questions and explanations in an active workspace with isActionable false", async () => {
    const intent = await resolveSemanticIntent({
      userPrompt: "How does the authentication flow work in this project?",
      hasWorkspace: true,
      workspaceFiles: ["app.js", "auth/jwt.js", "package.json"],
    });

    expect(intent.driverModel).toBe("code-qwen25coder");
    expect(intent.taskType).toBe("code");
    expect(intent.isActionable).toBe(false);
    expect(intent.intentType).toBe("general_qa");
  });

  it("routes drawing compliance review in chat to vision-qwen25vl as file_inspection without forcing document_drafting", async () => {
    const svgAttachment: AttachmentReference = {
      attachmentId: "att_svg",
      filename: "pump-skid-P204.svg",
      mediaType: "image/svg+xml",
      sizeBytes: 2048,
      relativePath: "runs/1/input/pump-skid-P204.svg",
    };

    const intent = await resolveSemanticIntent({
      userPrompt: "Check if the skid follows our piping spec and review the design against SOP-220",
      attachments: [svgAttachment],
      hasWorkspace: false,
    });

    expect(intent.driverModel).toBe("vision-qwen25vl");
    expect(intent.taskType).toBe("vision");
    expect(intent.intentType).toBe("file_inspection");
    expect(intent.isActionable).toBe(false);
  });

  it("routes inspection report review in chat without export request to file_inspection", async () => {
    const pdfAttachment: AttachmentReference = {
      attachmentId: "att_pdf",
      filename: "inspection-report-E201.pdf",
      mediaType: "application/pdf",
      sizeBytes: 4096,
      relativePath: "runs/1/input/inspection-report-E201.pdf",
    };

    const intent = await resolveSemanticIntent({
      userPrompt: "Review the inspection report findings and check if it complies with SOP-114",
      attachments: [pdfAttachment],
      hasWorkspace: false,
    });

    expect(intent.driverModel).toBe("vision-qwen25vl");
    expect(intent.taskType).toBe("vision");
    expect(intent.intentType).toBe("file_inspection");
    expect(intent.isActionable).toBe(false);
  });

  describe("Natural Language Intention Detection & Semantic Constraints", () => {
    it("separates workspace operations from deliverables and extracts negative constraints", async () => {
      const mockGateway = {
        async execute() {
          return {
            ok: true,
            value: {
              result: {
                text: JSON.stringify({
                  status: "resolved",
                  driverModel: "code-qwen25coder",
                  taskType: "code",
                  primaryGoal: "Update notes.md while protecting other workspace files",
                  isActionable: true,
                  chatResponseOnly: false,
                  workspaceMutationRequested: true,
                  targetFiles: ["notes.md"],
                  protectedPaths: ["config.json", "unrelated.md"],
                  restrictMutationsToTargets: true,
                  expectedDeliverables: [],
                  intentType: "code_modification",
                  reason: "User requested modifying notes.md with explicit negative constraints on config.json and unrelated.md",
                }),
              },
            },
          };
        },
      };

      const intent = await resolveSemanticIntent(
        {
          userPrompt: "Update notes.md. Do not modify config.json, unrelated.md, or any other existing file.",
          hasWorkspace: true,
          workspaceFiles: ["notes.md", "config.json", "unrelated.md", "package.json"],
        },
        mockGateway as any,
      );

      expect(intent.status).toBe("resolved");
      expect(intent.workspaceMutationRequested).toBe(true);
      expect(intent.targetFiles).toEqual(["notes.md"]);
      expect(intent.expectedDeliverables).toEqual([]);
      expect(intent.protectedPaths).toContain("config.json");
      expect(intent.protectedPaths).toContain("unrelated.md");
      expect(intent.restrictMutationsToTargets).toBe(true);
      expect(intent.chatResponseOnly).toBe(false);

      // Verify derived output expectation
      expect(intent.outputExpectation?.chatResponse).toBe(true);
      expect(intent.outputExpectation?.expectedFiles).toEqual([]);
      expect(intent.outputExpectation?.workspaceMutationRequested).toBe(true);
      expect(intent.outputExpectation?.targetFiles).toEqual(["notes.md"]);
      expect(intent.outputExpectation?.expectedDeliverables).toEqual([]);
    });

    it("resolves conflicts by prioritizing protectedPaths over targetFiles and sets ambiguous if no targets remain", async () => {
      const mockGateway = {
        async execute() {
          return {
            ok: true,
            value: {
              result: {
                text: JSON.stringify({
                  status: "resolved",
                  driverModel: "code-qwen25coder",
                  taskType: "code",
                  primaryGoal: "Conflicting file modification",
                  isActionable: true,
                  chatResponseOnly: false,
                  workspaceMutationRequested: true,
                  targetFiles: ["config.json"],
                  protectedPaths: ["config.json"],
                  restrictMutationsToTargets: true,
                  expectedDeliverables: [],
                  intentType: "code_modification",
                  reason: "Conflicting prompt asking to edit and protect config.json",
                }),
              },
            },
          };
        },
      };

      const intent = await resolveSemanticIntent(
        {
          userPrompt: "Modify config.json but do not touch config.json",
          hasWorkspace: true,
          workspaceFiles: ["config.json"],
        },
        mockGateway as any,
      );

      // Protected path wins conflict: targetFiles is purged
      expect(intent.targetFiles).not.toContain("config.json");
      expect(intent.protectedPaths).toContain("config.json");
      // Because actionable mutation has no remaining valid targets, status becomes ambiguous
      expect(intent.status).toBe("ambiguous");
    });

    it("performs 1-turn bounded JSON repair when initial LLM response is malformed", async () => {
      let callCount = 0;
      const mockGateway = {
        async execute(req: any) {
          callCount++;
          if (callCount === 1) {
            // Malformed JSON (unclosed quote / brace)
            return {
              ok: true,
              value: {
                result: {
                  text: '```json\n{"status": "resolved", "primaryGoal": "Refactor app.js", "targetFiles": ["app.js"',
                },
              },
            };
          }
          // Repair call successfully outputs valid JSON
          return {
            ok: true,
            value: {
              result: {
                text: JSON.stringify({
                  status: "resolved",
                  driverModel: "code-qwen25coder",
                  taskType: "code",
                  primaryGoal: "Refactor app.js",
                  isActionable: true,
                  chatResponseOnly: false,
                  workspaceMutationRequested: true,
                  targetFiles: ["app.js"],
                  protectedPaths: [],
                  restrictMutationsToTargets: false,
                  expectedDeliverables: [],
                  intentType: "code_modification",
                  reason: "Repaired valid JSON",
                }),
              },
            },
          };
        },
      };

      const intent = await resolveSemanticIntent(
        {
          userPrompt: "Refactor app.js to use express router",
          hasWorkspace: true,
          workspaceFiles: ["app.js"],
        },
        mockGateway as any,
      );

      expect(callCount).toBe(2);
      expect(intent.status).toBe("resolved");
      expect(intent.targetFiles).toEqual(["app.js"]);
      expect(intent.primaryGoal).toBe("Refactor app.js");
    });

    it("returns status: failed when JSON remains unrepairable after bounded repair", async () => {
      const mockGateway = {
        async execute() {
          return {
            ok: true,
            value: {
              result: {
                text: "Here is what I think you want: not valid json at all",
              },
            },
          };
        },
      };

      const intent = await resolveSemanticIntent(
        {
          userPrompt: "Do something completely unrecognized",
          hasWorkspace: false,
        },
        mockGateway as any,
      );

      expect(intent.status).toBe("failed");
      expect(intent.failureReason).toBeDefined();
    });
  });
});


