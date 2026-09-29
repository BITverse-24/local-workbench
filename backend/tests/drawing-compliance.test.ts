import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { RunManager } from "../src/main/run/manager.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { RAGService } from "../src/main/rag/rag-service.js";
import { RAGGroundingProvider } from "../src/main/grounding/rag-grounding-provider.js";
import {
  extractDrawingAttributes,
  ensureGoverningSpecIndexed,
  retrieveGoverningSpecChunks,
  evaluateDrawingComplianceWithModel,
  generateComplianceNoteArtifact,
} from "../src/main/grounding/spec-compliance.js";
import type { RunEvent } from "../src/shared/contracts.js";

describe("Dynamic Spec Compliance via RAG & Reasoning", () => {
  let tempRoot: string;
  let tempRAGDir: string;
  let ragService: RAGService;

  beforeEach(async () => {
    tempRoot = path.join(
      os.tmpdir(),
      `wb-spec-comp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tempRoot, { recursive: true });
    process.env.WORKBENCH_DATA_ROOT = path.join(tempRoot, "data");
    initDb(path.join(tempRoot, "workbench.sqlite"));

    tempRAGDir = path.join(tempRoot, "data", "rag");
    ragService = new RAGService(path.join(tempRoot, "data"));
    await ragService.init();
  });

  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("extracts component tags, ratings, and diameters from SVG engineering drawing", () => {
    const svgPath = path.resolve(__dirname, "../../demo/flow_c/pump-skid-P204.svg");
    const svgBuffer = readFileSync(svgPath);

    const extraction = extractDrawingAttributes({
      filename: "pump-skid-P204.svg",
      mediaType: "image/svg+xml",
      rawBuffer: svgBuffer,
    });

    expect(extraction.drawingId).toBe("PID-P204-REV-C");
    expect(extraction.service).toBe("Hydrocarbon service");

    const valveComp = extraction.observedComponents.find((c) => c.attributeName === "valve rating");
    expect(valveComp).toBeDefined();
    expect(valveComp?.tag).toBe("XV-204");
    expect(valveComp?.observedValue).toMatch(/Class 150/i);
    expect(valveComp?.numericValue).toBe(150);

    const lineComp = extraction.observedComponents.find(
      (c) => c.attributeName === "nominal diameter" && c.location === "discharge line",
    );
    expect(lineComp).toBeDefined();
    expect(lineComp?.observedValue).toMatch(/DN80/i);
    expect(lineComp?.numericValue).toBe(80);
  });

  it("dynamically ingests governing spec into RAG and retrieves exact clause citations", async () => {
    const specPath = path.resolve(__dirname, "../../demo/flow_c/piping-spec-SOP-220.md");
    const specBuffer = readFileSync(specPath, "utf8");

    const specInfo = await ensureGoverningSpecIndexed(ragService, {
      attachedSpecFile: { filename: "piping-spec-SOP-220.md", relativePath: specPath },
      promptText: "Check this against our piping spec and tell me if anything's non-compliant",
    });

    expect(specInfo.docId).toBeDefined();
    expect(specInfo.specContent).toContain("SOP-220");

    const chunks = await retrieveGoverningSpecChunks(
      ragService,
      specBuffer,
      "SOP-220",
      "isolation valve rating discharge line diameter Class 150 DN80",
    );

    expect(chunks.length).toBeGreaterThan(0);
    const citations = chunks.map((c) => c.citation);
    expect(citations).toContain("[SOP-220 §4.2]");
    expect(citations).toContain("[SOP-220 §4.3]");
  });

  it("dynamically evaluates compliance against custom specification without hardcoded functions", async () => {
    // Custom spec with different rules:
    // Section 10.1 requires bypass valve rating >= Class 600
    // Section 10.2 requires header diameter >= DN150
    const customSpecContent = `# SPEC-990 - High Pressure Bypass Spec\n\n` +
      `## [section:10.1] Bypass valve rating\n` +
      `For high pressure service, bypass isolation valves must be rated at least Class 600. A Class 300 valve is non-compliant.\n\n` +
      `## [section:10.2] Header line diameter\n` +
      `The header line must be DN150 or larger. A DN100 line is non-compliant.`;

    const customSpecFile = path.join(tempRoot, "spec-990.md");
    writeFileSync(customSpecFile, customSpecContent, "utf8");

    await ragService.ingestDocument(
      {
        doc_id: "SPEC-990",
        title: "High Pressure Bypass Spec",
        source_path: customSpecFile,
        doc_type: "sop",
        department: "Engineering",
        effective_date: "2024-01-01",
        page_count: 1,
        ocr_used: false,
        indexed_at: new Date().toISOString(),
      },
      customSpecFile,
    );

    const customDrawing = {
      drawingId: "DWG-HP-990",
      title: "High Pressure Bypass Diagram",
      service: "High pressure service",
      notes: [],
      observedComponents: [
        {
          tag: "XV-901",
          componentType: "isolation valve",
          attributeName: "valve rating",
          observedValue: "Class 300",
          numericValue: 300,
          unit: "class",
          location: "discharge line",
          fullDescription: "XV-901 Class 300",
        },
        {
          componentType: "discharge line",
          attributeName: "nominal diameter",
          observedValue: "DN100 discharge line",
          numericValue: 100,
          unit: "DN",
          location: "discharge line",
          fullDescription: "DN100 discharge line",
        },
      ],
      rawText: "XV-901 Class 300 DN100 discharge line",
    };

    const chunks = await retrieveGoverningSpecChunks(
      ragService,
      customSpecContent,
      "SPEC-990",
      "bypass valve rating header line diameter Class 300 DN100",
    );

    // Evaluate using mock gateway (model reasoning)
    const mockGateway = new ModelGateway(
      {
        async request() {
          return {
            status: 200,
            async text() {
              return JSON.stringify({
                id: "chatcmpl-test",
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        drawingId: "DWG-HP-990",
                        approved: false,
                        checks: [
                          {
                            component: "XV-901 Class 300",
                            observed: "Class 300",
                            required: "Class 600 minimum",
                            status: "non_compliant",
                            citation: "[SPEC-990 §10.1]",
                            reasoning: "300 is below the required minimum rating of 600.",
                          },
                          {
                            component: "DN100 discharge line",
                            observed: "DN100",
                            required: "DN150 minimum",
                            status: "non_compliant",
                            citation: "[SPEC-990 §10.2]",
                            reasoning: "100 is below the required minimum nominal diameter of 150.",
                          },
                        ],
                        correctiveAction: "Replace XV-901 with Class 600 valve and upsize line to DN150.",
                        noApprovalClaim: true,
                        markdownNote: "# High Pressure Review - Corrective Action\n\nDrawing `DWG-HP-990` is NOT APPROVED.\n\n1. Replace XV-901 with Class 600 per [SPEC-990 §10.1].\n2. Upsize to DN150 per [SPEC-990 §10.2].",
                      }),
                    },
                  },
                ],
              });
            },
          };
        },
      },
      new Map([
        [
          "draft-qwen3",
          {
            id: "draft-qwen3",
            taskTypes: ["draft"],
            runtime: "llama-server",
            baseUrl: "http://localhost:8000/v1",
            model: "draft-model",
            capabilities: ["text", "structured-output"],
            requestTimeoutMs: 10000,
            healthPath: "/models",
            enabled: true,
          },
        ],
      ] as any),
    );

    const assessment = await evaluateDrawingComplianceWithModel({
      gateway: mockGateway,
      runId: "test-run-spec-990",
      drawing: customDrawing,
      specChunks: chunks,
      docId: "SPEC-990",
    });

    expect(assessment.approved).toBe(false);
    expect(assessment.checks.length).toBe(2);
    expect(assessment.checks[0].status).toBe("non_compliant");
    expect(assessment.checks[0].citation).toBe("[SPEC-990 §10.1]");
    expect(assessment.checks[1].status).toBe("non_compliant");
    expect(assessment.checks[1].citation).toBe("[SPEC-990 §10.2]");
  });

  it("executes complete drawing compliance review flow via RunManager", async () => {
    let capturedPrompt = "";
    const mockGateway = new ModelGateway(
      {
        async request(_url, init) {
          const body = JSON.parse(init.body || "{}");
          const userMsg = body.messages?.[body.messages.length - 1]?.content ?? "";
          capturedPrompt = typeof userMsg === "string" ? userMsg : JSON.stringify(userMsg);

          return {
            status: 200,
            async text() {
              return JSON.stringify({
                id: "chatcmpl-flow-c",
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        drawingId: "PID-P204-REV-C",
                        approved: false,
                        checks: [
                          {
                            component: "XV-204 Class 150",
                            observed: "XV-204 Class 150",
                            required: "Class 300 minimum",
                            status: "non_compliant",
                            citation: "[SOP-220 §4.2]",
                            reasoning: "150 is below the required minimum rating of 300.",
                          },
                          {
                            component: "DN80 discharge line",
                            observed: "DN80 discharge line",
                            required: "DN100 minimum",
                            status: "non_compliant",
                            citation: "[SOP-220 §4.3]",
                            reasoning: "80 is below the required minimum nominal diameter of 100.",
                          },
                        ],
                        correctiveAction:
                          "Replace XV-204 with a Class 300 valve and revise the discharge line to DN100 or larger before sign-off.",
                        noApprovalClaim: true,
                        markdownNote:
                          "# P-204 Design Review - Corrective Action\n\nDrawing `PID-P204-REV-C` is not ready for sign-off (DRAWING NOT APPROVED).\n\n1. Replace isolation valve `XV-204`, shown as Class 150, with a minimum Class 300 valve per `[SOP-220 §4.2]`.\n2. Revise the pump discharge line from DN80 to DN100 or larger per `[SOP-220 §4.3]`.\n\nThe note is a review finding, not an approval. A new drawing revision must be checked before release.",
                      }),
                    },
                  },
                ],
              });
            },
          };
        },
      },
      new Map([
        [
          "draft-qwen3",
          {
            id: "draft-qwen3",
            taskTypes: ["draft"],
            runtime: "llama-server",
            baseUrl: "http://localhost:8000/v1",
            model: "draft-model",
            capabilities: ["text", "structured-output"],
            requestTimeoutMs: 10000,
            healthPath: "/models",
            enabled: true,
          },
        ],
      ] as any),
    );

    const runEvents: RunEvent[] = [];
    const manager = new RunManager(mockGateway, (evt) => runEvents.push(evt));
    manager.setRAGService(ragService);
    manager.setGrounding(new RAGGroundingProvider(ragService));

    const chatId = createChat("Drawing Compliance Run");
    const svgPath = path.resolve(__dirname, "../../demo/flow_c/pump-skid-P204.svg");
    const svgBuffer = readFileSync(svgPath);

    const { attachment } = manager.registerAttachment({
      chatId,
      filename: "pump-skid-P204.svg",
      mediaType: "image/svg+xml",
      sizeBytes: svgBuffer.length,
      base64OrBuffer: svgBuffer,
    });

    const { runId } = await manager.start({
      chatId,
      userText: "Check this against our piping spec / standard / SOP and draft a corrective action note if anything is non-compliant",
      attachmentToken: attachment.attachmentId,
    });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const err = runEvents.find((e) => e.type === "error");
        if (err) {
          clearInterval(interval);
          reject(new Error(`Run failed: ${(err as any).message}`));
        }
        if (Date.now() - start > 5000) {
          clearInterval(interval);
          reject(new Error(`Timed out waiting for run completion. Events: ${JSON.stringify(runEvents)}`));
        }
        if (runEvents.some((e) => e.type === "run_state" && e.state === "completed")) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    // 1. Check routing event
    const routingEvt = runEvents.find((e) => e.type === "routing");
    expect(routingEvt).toBeDefined();
    expect(routingEvt?.taskType).toBe("draft");
    expect(routingEvt?.modelId).toBe("draft-qwen3");

    // 2. Check tool execution events
    const inspectTool = runEvents.find((e) => e.type === "tool_result" && e.tool === "inspect_drawing");
    expect(inspectTool).toBeDefined();

    const ragTool = runEvents.find((e) => e.type === "tool_result" && e.tool === "retrieve_sop");
    expect(ragTool).toBeDefined();

    const draftTool = runEvents.find((e) => e.type === "tool_result" && e.tool === "draft_note");
    expect(draftTool).toBeDefined();

    // 3. Check prompt content
    expect(capturedPrompt).toContain("XV-204");
    expect(capturedPrompt).toContain("CLASS 150");
    expect(capturedPrompt).toContain("DN80");
    expect(capturedPrompt).toContain("SOP-220");

    // 4. Check deliverable artifact
    const artifactEvt = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifactEvt).toBeDefined();
    expect((artifactEvt as any).artifact.filename).toBe("corrective-action-note.md");

    const outputPath = path.join(process.env.WORKBENCH_DATA_ROOT!, "runs", runId, "output", "corrective-action-note.md");
    const outputContent = readFileSync(outputPath, "utf8");
    expect(outputContent).toContain("DRAWING NOT APPROVED");
    expect(outputContent).toContain("[SOP-220 §4.2]");
    expect(outputContent).toContain("[SOP-220 §4.3]");
  });

  it("does not generate deliverable artifact when user only asks for in-chat compliance check", async () => {
    let capturedPrompt = "";
    const gateway = new ModelGateway(
      {
        async request(_url, init) {
          const body = JSON.parse(init.body || "{}");
          const userMsg = body.messages?.[body.messages.length - 1]?.content ?? "";
          capturedPrompt = typeof userMsg === "string" ? userMsg : JSON.stringify(userMsg);

          const complianceOutput = {
            text: `### Drawing Compliance Evaluation\n\n| Parameter | Observed | Required | Status |\n|---|---|---|---|\n| XV-204 | Class 150 | Class 300 | NON-COMPLIANT |\n\nStatus: NOT APPROVED. Revisions required.`,
          };

          return {
            status: 200,
            async text() {
              return JSON.stringify({
                id: "chatcmpl-mock",
                choices: [{ message: { content: JSON.stringify(complianceOutput) } }],
              });
            },
          };
        },
      },
      new Map([
        [
          "draft-qwen3",
          {
            id: "draft-qwen3",
            taskTypes: ["draft"],
            runtime: "llama-server",
            baseUrl: "http://localhost:8000/v1",
            model: "draft-model",
            capabilities: ["text", "structured-output"],
            requestTimeoutMs: 10000,
            healthPath: "/models",
            enabled: true,
          },
        ],
      ] as any),
    );

    const runEvents: RunEvent[] = [];
    const manager = new RunManager(gateway, (evt) => runEvents.push(evt));
    manager.setRAGService(ragService);
    manager.setGrounding(new RAGGroundingProvider(ragService));

    const chatId = createChat("Drawing In-Chat Only Check");
    const svgPath = path.resolve(__dirname, "../../demo/flow_c/pump-skid-P204.svg");
    const svgBuffer = readFileSync(svgPath);
    const { attachment } = manager.registerAttachment({
      chatId,
      filename: "pump-skid-P204.svg",
      mediaType: "image/svg+xml",
      sizeBytes: svgBuffer.length,
      base64OrBuffer: svgBuffer,
    });

    const { runId } = await manager.start({
      chatId,
      userText: "Check this against our piping spec and tell me if anything's non-compliant",
      attachmentToken: attachment.attachmentId,
    });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const err = runEvents.find((e) => e.type === "error");
        if (err) {
          clearInterval(interval);
          reject(new Error(`Run failed: ${(err as any).message}`));
        }
        if (Date.now() - start > 5000) {
          clearInterval(interval);
          reject(new Error("Timed out"));
        }
        if (runEvents.some((e) => e.type === "run_state" && e.state === "completed")) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    // Verify routing and tool events occurred
    expect(runEvents.some((e) => e.type === "tool_result" && e.tool === "inspect_drawing")).toBe(true);
    expect(runEvents.some((e) => e.type === "tool_result" && e.tool === "retrieve_sop")).toBe(true);

    // Verify NO artifact_ready was emitted because user didn't ask for a report or deliverable
    const artifactEvt = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifactEvt).toBeUndefined();
  });
});
