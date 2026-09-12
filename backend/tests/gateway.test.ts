import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import type { ModelId, ModelRegistryEntry, VisionModelRequest } from "../src/shared/contracts.js";

let dir = "";
const RUN_ID = "00000000-0000-4000-8000-000000000002";

function visionRegistry(): Map<ModelId, ModelRegistryEntry> {
  const model: ModelRegistryEntry = {
    id: "vision-qwen25vl",
    taskTypes: ["vision"],
    runtime: "llama-server",
    baseUrl: "https://example.test/v1",
    model: "test-vision",
    capabilities: ["text", "image-input", "structured-output"],
    requestTimeoutMs: 1000,
    healthPath: "/models",
    enabled: true,
  };
  return new Map([[model.id, model]]);
}

function visionRequest(relativePath: string, filename: string, mediaType: string): VisionModelRequest {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    runId: RUN_ID,
    taskType: "vision",
    modelId: "vision-qwen25vl",
    responseFormat: "vision-result",
    systemPrompt: "s",
    userPrompt: "u",
    timeoutMs: 1000,
    attachment: { attachmentId: "a1", filename, mediaType, sizeBytes: 3, relativePath },
    inputMode: "typed-scan",
  };
}

function okEnvelope() {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ sourceText: "t", findings: [], pageReferences: [] }) } }],
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "workbench-gateway-"));
  process.env.WORKBENCH_DATA_ROOT = path.join(dir, "data");
});

afterEach(() => {
  delete process.env.WORKBENCH_DATA_ROOT;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("vision attachment payloads (OpenRouter)", () => {
  it("sends PDFs as file parts, not image_url", async () => {
    const relativePath = `runs/${RUN_ID}/input/report.pdf`;
    const abs = path.join(process.env.WORKBENCH_DATA_ROOT!, relativePath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from("%PDF"));
    let sent: unknown[] = [];
    const gateway = new ModelGateway(
      {
        async request(_url, init) {
          const parsed = JSON.parse(init.body!) as { messages: Array<{ content: unknown[]; role: string }>; max_tokens: number };
          expect(parsed.messages[0]!.content).toMatch(/json/i);
          expect(parsed.max_tokens).toBe(2048);
          sent = parsed.messages[1]!.content;
          return { status: 200, async text() { return okEnvelope(); } };
        },
      },
      visionRegistry(),
    );
    const result = await gateway.execute(visionRequest(relativePath, "report.pdf", "application/pdf"));
    expect(result.ok).toBe(true);
    expect(sent[1]).toEqual({
      type: "file",
      file: { filename: "report.pdf", file_data: expect.stringMatching(/^data:application\/pdf;base64,/) },
    });
  });

  it("keeps images as image_url parts", async () => {
    const relativePath = `runs/${RUN_ID}/input/scan.png`;
    const abs = path.join(process.env.WORKBENCH_DATA_ROOT!, relativePath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e]));
    let sent: unknown[] = [];
    const gateway = new ModelGateway(
      {
        async request(_url, init) {
          const parsed = JSON.parse(init.body!) as { messages: Array<{ content: unknown[]; role: string }>; max_tokens: number };
          expect(parsed.messages[0]!.content).toMatch(/json/i);
          expect(parsed.max_tokens).toBe(2048);
          sent = parsed.messages[1]!.content;
          return { status: 200, async text() { return okEnvelope(); } };
        },
      },
      visionRegistry(),
    );
    const result = await gateway.execute(visionRequest(relativePath, "scan.png", "image/png"));
    expect(result.ok).toBe(true);
    expect(sent[1]).toEqual({
      type: "image_url",
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    });
  });
});

describe("model gateway health checks", () => {
  it("runs health checks concurrently across all models with Promise.all", async () => {
    const activeRequests: string[] = [];
    let maxConcurrent = 0;

    const models: [ModelId, ModelRegistryEntry][] = [
      [
        "code-qwen25coder",
        {
          id: "code-qwen25coder",
          taskTypes: ["code"],
          runtime: "llama-server",
          baseUrl: "https://model-a.test/v1",
          model: "test-code",
          capabilities: ["text", "code-generation"],
          requestTimeoutMs: 1000,
          healthPath: "/models",
          enabled: true,
        },
      ],
      [
        "draft-qwen3",
        {
          id: "draft-qwen3",
          taskTypes: ["draft"],
          runtime: "llama-server",
          baseUrl: "https://model-b.test/v1",
          model: "test-draft",
          capabilities: ["text", "structured-output"],
          requestTimeoutMs: 1000,
          healthPath: "/models",
          enabled: true,
        },
      ],
    ];

    const gateway = new ModelGateway(
      {
        async request(url) {
          activeRequests.push(url);
          maxConcurrent = Math.max(maxConcurrent, activeRequests.length);
          await new Promise((r) => setTimeout(r, 20));
          activeRequests.splice(activeRequests.indexOf(url), 1);
          return { status: 200, async text() { return "ok"; } };
        },
      },
      new Map(models),
    );

    const results = await gateway.health();
    expect(results).toHaveLength(2);
    expect(results[0]?.modelId).toBe("code-qwen25coder");
    expect(results[0]?.available).toBe(true);
    expect(results[1]?.modelId).toBe("draft-qwen3");
    expect(results[1]?.available).toBe(true);
    // Verified concurrent execution
    expect(maxConcurrent).toBe(2);
  });

  it("probes a single model when modelId is passed", async () => {
    const gateway = new ModelGateway(
      {
        async request() {
          return { status: 200, async text() { return "ok"; } };
        },
      },
      visionRegistry(),
    );

    const result = await gateway.health("vision-qwen25vl");
    expect(result.modelId).toBe("vision-qwen25vl");
    expect(result.available).toBe(true);
  });
});
