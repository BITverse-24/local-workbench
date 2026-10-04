import { describe, expect, it } from "vitest";
import { resolveSemanticIntent, extractReferencedFiles } from "../src/main/router/contextual-router.js";

describe("Contextual Semantic Intent & Routing Engine", () => {
  it("fails explicitly without a gateway instead of guessing a code route", async () => {
    const intent = await resolveSemanticIntent({ userPrompt: "Fix reader.py in this workspace", hasWorkspace: true, workspaceFiles: ["reader.py"] });
    expect(intent.status).toBe("failed");
    expect(intent.isActionable).toBe(false);
    expect(intent.workspaceMutationRequested).toBe(false);
    expect(intent.targetFiles).toEqual([]);
    expect(intent.failureReason).toContain("no deterministic fallback");
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
                driverModel: "primary-model",
                primaryGoal: "Refactor rate limiter to sliding window",
                targetFiles: ["middleware/rateLimiter.js"],
                workspaceMutationRequested: true,
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

    expect(intent.driverModel).toBe("primary-model");
    expect(intent.primaryGoal).toBe("Refactor rate limiter to sliding window");
    expect(intent.targetFiles).toEqual(["middleware/rateLimiter.js"]);
    expect(intent.isActionable).toBe(true);
  });

  it("keeps attached code repair in run output unless the user requests a workspace destination", async () => {
    const mockGateway = {
      async execute() {
        return { ok: true, value: { result: {
          intentType: "code_modification", taskType: "code", driverModel: "primary-model",
          primaryGoal: "Repair the attached parser", targetFiles: ["broken-parser.py"],
          workspaceMutationRequested: true, isActionable: true, validationRequested: true,
          successMarker: "exit 0",
          workspaceOperations: [{ operation: "mutate", targetPath: "broken-parser.py" }],
        } } };
      },
    };
    const attachment = { attachmentId: "parser", filename: "broken-parser.py", mediaType: "text/x-python", sizeBytes: 80, relativePath: "input/broken-parser.py" };
    const standalone = await resolveSemanticIntent({
      userPrompt: "Repair the attached Python parser and run it against the CSV.",
      attachments: [attachment], hasWorkspace: true, workspaceFiles: ["broken-parser.py"],
    }, mockGateway as any);
    expect(standalone.workspaceMutationRequested).toBe(false);
    expect(standalone.targetFiles).toEqual([]);
    expect(standalone.workspaceOperations).toEqual([]);
    expect(standalone.expectedDeliverables[0]?.filename).toBe("fixed-parser.py");
    expect(standalone.successMarker).toBeUndefined();

    const namedOutput = await resolveSemanticIntent({
      userPrompt: "Repair the attached Python parser and save the corrected standalone script as vendor-log-parser.py.",
      attachments: [attachment], hasWorkspace: true, workspaceFiles: ["broken-parser.py"],
    }, mockGateway as any);
    expect(namedOutput.expectedDeliverables[0]?.filename).toBe("vendor-log-parser.py");

    const workspaceEdit = await resolveSemanticIntent({
      userPrompt: "Repair the attached Python parser and write the corrected file into my workspace.",
      attachments: [attachment], hasWorkspace: true, workspaceFiles: ["broken-parser.py"],
    }, mockGateway as any);
    expect(workspaceEdit.workspaceMutationRequested).toBe(true);
    expect(workspaceEdit.targetFiles).toContain("broken-parser.py");
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
              driverModel: "primary-model",
              primaryGoal: "Convert JavaScript codebase to TypeScript",
              targetFiles: ["app.ts"],
              workspaceMutationRequested: true,
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

    expect(intent.driverModel).toBe("primary-model");
    expect(intent.taskType).toBe("code");
    expect(intent.isActionable).toBe(true);
    expect(intent.primaryGoal).toBe("Convert JavaScript codebase to TypeScript");
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
                  driverModel: "primary-model",
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
                  driverModel: "primary-model",
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
                  driverModel: "primary-model",
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
