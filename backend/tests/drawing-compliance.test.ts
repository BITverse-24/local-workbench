import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { RunManager } from "../src/main/run/manager.js";
import { modeGateway, fixtureIntent } from './helpers/mode-gateway.js';
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
    const svgPath = path.resolve(__dirname, "../../demo/flow_c/scenario-1/pump-skid-P204.svg");
    const svgBuffer = readFileSync(svgPath);

    const extraction = extractDrawingAttributes({
      filename: "pump-skid-P204.svg",
      mediaType: "image/svg+xml",
      rawBuffer: svgBuffer,
    });

    expect(extraction.drawingId).toBe("PID-P204-REV-C");
    expect(extraction.service).toBe("Hydrocarbon service");

    const valveComp = extraction.observedComponents.find((c) => c.attributeName === "rating");
    expect(valveComp).toBeDefined();
    expect(valveComp?.tag).toBe("XV-204");
    expect(valveComp?.observedValue).toMatch(/Class 150/i);
    expect(valveComp?.numericValue).toBe(150);

    const lineComp = extraction.observedComponents.find(
      (c) => c.attributeName === "nominal size" && c.location === "discharge",
    );
    expect(lineComp).toBeDefined();
    expect(lineComp?.observedValue).toMatch(/DN80/i);
    expect(lineComp?.numericValue).toBe(80);
  });

  it("dynamically ingests governing spec into RAG and retrieves exact clause citations", async () => {
    const specPath = path.resolve(__dirname, "../../demo/flow_c/scenario-1/piping-spec-SOP-220.md");
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

  const note='# P-204 Design Review\n\nDRAWING NOT APPROVED.\nReplace XV-204 from Class 150 to Class 300 [SOP-220 §4.2].\nRevise discharge line DN80 to DN100 [SOP-220 §4.3].';
  async function inspectDrawing(work:boolean){
    const fixture=modeGateway(fixtureIntent('Review drawing',work?[{type:'md',filename:'corrective-action-note.md'}]:[]),()=>note);
    const events:RunEvent[]=[];const manager=new RunManager(fixture.gateway,event=>events.push(event));manager.setRAGService(ragService);manager.setGrounding(new RAGGroundingProvider(ragService));
    const chatId=createChat('Drawing review');const bytes=readFileSync(path.resolve('demo/flow_c/scenario-1/pump-skid-P204.svg'));
    const {attachment}=manager.registerAttachment({chatId,filename:'drawing.svg',mediaType:'image/svg+xml',sizeBytes:bytes.length,base64OrBuffer:bytes});
    const {runId}=await manager.start({chatId,mode:work?'work':'chat',groundingEnabled:true,userText:work?'Check this against the piping spec and create corrective-action-note.md':'Check this against the piping spec and describe required corrections',attachmentToken:attachment.attachmentId});
    await vi.waitFor(()=>expect(events.some(e=>e.runId===runId&&e.type==='run_state'&&e.state==='completed'),JSON.stringify(events.filter(e=>e.type==='error'))).toBe(true),{timeout:5000});
    return {fixture,events,runId};
  }
  it('executes grounded Work review with the real source reader and a saved Markdown output',async()=>{
    const {fixture,events,runId}=await inspectDrawing(true);
    expect(events.some(e=>e.type==='routing'&&e.modelId==='primary-model'&&e.taskType==='draft')).toBe(true);
    expect(events.some(e=>e.type==='tool_result'&&e.tool==='retrieve_knowledge'&&e.ok)).toBe(true);
    const prompts=JSON.stringify(fixture.turns);expect(prompts).toContain('XV-204');expect(prompts).toContain('CLASS 150');expect(prompts).toContain('DN80');expect(prompts).toContain('SOP-220');
    const artifact=events.find(e=>e.type==='artifact_ready');expect(artifact?.type==='artifact_ready'&&artifact.artifact.filename).toBe('corrective-action-note.md');
    const output=readFileSync(path.join(process.env.WORKBENCH_DATA_ROOT!,'runs',runId,'output/corrective-action-note.md'),'utf8');expect(output).toContain('DRAWING NOT APPROVED');expect(output).toContain('[SOP-220 §4.2]');expect(output).toContain('[SOP-220 §4.3]');
  });
  it('returns grounded Chat findings without an unrequested deliverable',async()=>{
    const {fixture,events}=await inspectDrawing(false);expect(fixture.execute).not.toHaveBeenCalled();expect(fixture.chat).toHaveBeenCalledTimes(1);expect(events.some(e=>e.type==='tool_result'&&e.tool==='retrieve_knowledge'&&e.ok)).toBe(true);expect(events.some(e=>e.type==='assistant_message'&&e.text.includes('NOT APPROVED'))).toBe(true);expect(events.some(e=>e.type==='artifact_ready')).toBe(false);
  });
});
