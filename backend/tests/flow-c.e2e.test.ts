import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { RunManager } from "../src/main/run/manager.js";
import { createChat } from "../src/main/persistence/chats.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import { RAGService } from "../src/main/rag/rag-service.js";
import { RAGGroundingProvider } from "../src/main/grounding/rag-grounding-provider.js";
import { RAGDatabase } from "../../ai/rag/db.js";
import type { ModelRequest, ModelResponse, RunEvent } from "../src/shared/contracts.js";

let tempDir = "";
let fetchSpy: any;

function createFakeEmbedding(text: string, dims = 384): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < dims; i++) {
    vec[i] = Math.sin(hash + i);
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-flow-c-e2e-"));
  process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
  initDb(path.join(tempDir, "workbench.sqlite"));

  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const urlStr = String(input);
    if (urlStr.includes("/embeddings")) {
      const body = JSON.parse(String(init?.body || "{}"));
      const texts = Array.isArray(body.input) ? body.input : [body.input];
      const data = texts.map((t: string, idx: number) => ({
        index: idx,
        embedding: createFakeEmbedding(String(t)),
      }));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data,
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
      } as Response;
    }
    return { ok: false, status: 404, text: async () => "Not Found" } as Response;
  });
});

afterEach(() => {
  if (fetchSpy) fetchSpy.mockRestore();
  RAGDatabase.close();
  closeDb();
  delete process.env.WORKBENCH_DATA_ROOT;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("Flow C End-to-End: Engineering Drawing Compliance Review", () => {
  it("ingests SVG drawing, dynamically retrieves piping criteria via RAG, evaluates compliance, and emits corrective-action-note.md deliverable", async () => {
    // 1. Initialize RAG Knowledge Base and ingest piping specification
    const ragService = new RAGService(tempDir);
    await ragService.init();

    const specPath = path.resolve(__dirname, "../../demo/flow_c/piping-spec-SOP-220.md");
    const specContent = readFileSync(specPath, "utf-8");
    const localSpecCopy = path.join(tempDir, "piping-spec-SOP-220.md");
    writeFileSync(localSpecCopy, specContent, "utf-8");

    await ragService.ingestDocument(
      {
        doc_id: "SOP-220",
        title: "SOP-220 Piping and Valve Design Review",
        source_path: localSpecCopy,
        doc_type: "spec",
        department: "Piping Engineering",
        effective_date: "2026-01-01",
        indexed_at: new Date().toISOString(),
        page_count: 1,
        ocr_used: false,
      },
      localSpecCopy,
    );

    const groundingProvider = new RAGGroundingProvider(ragService);

    // 2. Set up ModelGateway with reasoning model mock
    let capturedPrompt = "";
    const gateway = new ModelGateway(
      {
        async request(_url, init) {
          const body = JSON.parse(init?.body as string);
          const userMsg = body.messages?.find((m: any) => m.role === "user")?.content || "";
          capturedPrompt = typeof userMsg === "string" ? userMsg : JSON.stringify(userMsg);

          const complianceOutput = {
            text: `# Engineering Compliance Review: P-204 Pump Skid\n\n` +
              `## Drawing Reference\nPID-P204-REV-C (Hydrocarbon service)\n\n` +
              `## Findings & Compliance Assessment\n` +
              `1. **Discharge Isolation Valve (XV-204)**: Observed **Class 150**. Required minimum **Class 300** for hydrocarbon service per [SOP-220 §4.2]. Status: **NON-COMPLIANT**.\n` +
              `2. **Discharge Line Diameter**: Observed **DN80**. Required minimum **DN100** per [SOP-220 §4.3]. Status: **NON-COMPLIANT**.\n\n` +
              `## Disposition\n` +
              `**DRAWING NOT APPROVED**. The pump skid drawing contains 2 safety discrepancies that must be revised before manufacturing sign-off.\n\n` +
              `## Corrective Actions\n` +
              `- Replace valve specification XV-204 from Class 150 to Class 300.\n` +
              `- Upsize discharge line from DN80 to DN100.`,
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
    manager.setGrounding(groundingProvider);

    const chatId = createChat("Flow C Drawing Compliance Review");

    // 3. Stage demo SVG engineering drawing
    const svgPath = path.resolve(__dirname, "../../demo/flow_c/pump-skid-P204.svg");
    const svgBuffer = readFileSync(svgPath);
    const { attachment } = manager.registerAttachment({
      chatId,
      filename: "pump-skid-P204.svg",
      mediaType: "image/svg+xml",
      sizeBytes: svgBuffer.length,
      base64OrBuffer: svgBuffer,
    });

    // 4. Start run with the exact Flow C user prompt
    const { runId } = await manager.start({
      chatId,
      userText: "Check this against our piping spec and tell me if anything's non-compliant.",
      attachmentToken: attachment.attachmentId,
    });

    // Wait for run completion
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const err = runEvents.find((e) => e.type === "error");
        if (err) {
          clearInterval(interval);
          reject(new Error(`Flow C run failed: ${(err as any).message}`));
        }
        if (Date.now() - start > 5000) {
          clearInterval(interval);
          reject(new Error(`Flow C run timed out. Events: ${JSON.stringify(runEvents)}`));
        }
        if (runEvents.some((e) => e.type === "run_state" && e.state === "completed")) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    // 5. Verify Router emitted correct Flow C routing event
    const routingEvt = runEvents.find((e) => e.type === "routing");
    expect(routingEvt).toBeDefined();
    expect(routingEvt?.taskType).toBe("draft");
    expect(routingEvt?.modelId).toBe("draft-qwen3");
    expect((routingEvt as any).reason).toBe("engineering drawing compliance review");

    // 6. Verify Visual Extraction tool execution on SVG drawing
    const inspectTool = runEvents.find((e) => e.type === "tool_result" && e.tool === "inspect_drawing");
    expect(inspectTool).toBeDefined();
    expect((inspectTool as any).summary).toContain("P-204");

    // 7. Verify Dynamic RAG Grounding tool execution and context injection
    const ragTool = runEvents.find((e) => e.type === "tool_result" && e.tool === "retrieve_sop");
    expect(ragTool).toBeDefined();

    const groundingContextEvt = runEvents.find((e) => e.type === "grounding_context" && e.status === "injected");
    expect(groundingContextEvt).toBeDefined();
    expect((groundingContextEvt as any).chunkCount).toBeGreaterThan(0);

    // 8. Verify Prompt fed to reasoning model contains extracted drawing parameters and RAG criteria
    expect(capturedPrompt).toContain("XV-204");
    expect(capturedPrompt).toContain("CLASS 150");
    expect(capturedPrompt).toContain("DN80");
    expect(capturedPrompt).toContain("SOP-220");

    // 9. Verify Markdown Review Deliverable Artifact generated and registered
    const artifactEvt = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifactEvt).toBeDefined();
    const artifact = (artifactEvt as any).artifact;
    expect(artifact.kind).toBe("md");
    expect(artifact.filename).toBe("corrective-action-note.md");

    // Verify artifact written to data/runs/<runId>/output/corrective-action-note.md
    const outputFilePath = path.join(process.env.WORKBENCH_DATA_ROOT!, "runs", runId, "output", "corrective-action-note.md");
    const outputContent = readFileSync(outputFilePath, "utf-8");
    expect(outputContent).toContain("NON-COMPLIANT");
    expect(outputContent).toContain("DRAWING NOT APPROVED");
    expect(outputContent).toContain("[SOP-220 §4.2]");
    expect(outputContent).toContain("[SOP-220 §4.3]");
  });
});
