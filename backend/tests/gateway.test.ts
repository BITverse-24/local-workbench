import { mkdirSync, rmSync, writeFileSync, mkdtempSync, readFileSync } from "node:fs";
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

it("ignores sparse native tool-call slots while preserving the actual call", async () => {
  const gateway = new ModelGateway({
    async request() {
      return { status: 200, async text() { return JSON.stringify({ choices: [{ message: {
        content: null,
        tool_calls: [null, { id: "write", function: { name: "write_file", arguments: JSON.stringify({ path: "module.py", content: "value = 1\n" }) } }],
      } }] }); } };
    },
  }, visionRegistry());
  const response = await gateway.chatWithTools("vision-qwen25vl", [{ role: "user", content: "Write the module." }], []);
  expect(response.ok).toBe(true);
  if (response.ok) expect(response.value.tool_calls).toEqual([
    { id: "write", name: "write_file", arguments: { path: "module.py", content: "value = 1\n" } },
  ]);
});

afterEach(() => {
  delete process.env.WORKBENCH_DATA_ROOT;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("vision attachment payloads", () => {

  it("renders real PDF pages as image parts", async () => {
    const relativePath = `runs/${RUN_ID}/input/report.pdf`;
    const abs = path.join(process.env.WORKBENCH_DATA_ROOT!, relativePath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, readFileSync(path.resolve("tests/fixtures/demo/flow_a/scenario-1/inspection-report-E201.pdf")));
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
      type: "image_url",
      image_url: { url: expect.stringMatching(/^data:image\/(?:jpeg|png);base64,/) },
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

  it("healthDistinct deduplicates multiple roles on same port into a single entry indexed by port with model name display", async () => {
    let probeCount = 0;
    const baseEntry = (id: ModelId, baseUrl: string): ModelRegistryEntry => ({
      id,
      taskTypes: ["code"],
      runtime: "llama-server",
      baseUrl,
      model: "test-model",
      capabilities: ["text"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    });

    const models: Array<[string, ModelRegistryEntry]> = [
      ["vision-qwen25vl", baseEntry("vision-qwen25vl", "http://127.0.0.1:1234/v1")],
      ["code-qwen25coder", baseEntry("code-qwen25coder", "http://127.0.0.1:1234/v1")],
      ["draft-qwen3", baseEntry("draft-qwen3", "http://127.0.0.1:1234/v1")],
      ["embedding", baseEntry("draft-qwen3", "http://127.0.0.1:11434/v1")],
    ];

    const gateway = new ModelGateway(
      {
        async request() {
          probeCount++;
          return { status: 200, async text() { return "ok"; } };
        },
      },
      new Map(models),
    );

    const distinct = await gateway.healthDistinct();
    // 3 roles on port 1234 deduplicate to 1 probe + 1 role on port 11434 = 2 distinct probes
    expect(distinct).toHaveLength(2);
    expect(probeCount).toBe(2);

    const port1234 = distinct.find((h) => h.port === 1234);
    expect(port1234).toBeDefined();
    expect(port1234?.modelId).toBe("test-model");
    expect(port1234?.available).toBe(true);

    const port11434 = distinct.find((h) => h.port === 11434);
    expect(port11434).toBeDefined();
    expect(port11434?.modelId).toBe("test-model");
    expect(port11434?.available).toBe(true);
  });

  it("chat drafting disables structured output and passes raw prompt without forcing JSON", async () => {
    let capturedBody: any;
    const model: ModelRegistryEntry = {
      id: "draft-qwen3",
      taskTypes: ["draft"],
      runtime: "llama-server",
      baseUrl: "https://example.test/v1",
      model: "test-draft",
      capabilities: ["text"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    };
    const gateway = new ModelGateway(
      {
        async request(_url, init) {
          capturedBody = JSON.parse(init.body!);
          return {
            status: 200,
            async text() {
              return JSON.stringify({
                choices: [{ message: { content: "# Engineering Note\n\nDirect markdown output.", role: "assistant" } }],
              });
            },
          };
        },
      },
      new Map([[model.id, model]]),
    );

    const result = await gateway.execute({
      requestId: "req-draft-1",
      runId: RUN_ID,
      taskType: "draft",
      modelId: "draft-qwen3",
      responseFormat: "chat-result",
      systemPrompt: "You are an engineering assistant.",
      userPrompt: "Draft compliance note.",
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value.result as any).text).toBe("# Engineering Note\n\nDirect markdown output.");
    }
    // Verify response_format was NOT forced into a JSON schema or json_object
    expect(capturedBody.response_format).toBeUndefined();
    // Verify system prompt was NOT altered to force JSON
    expect(capturedBody.messages[0].content).toBe("You are an engineering assistant.");
    expect(capturedBody.stream).toBeUndefined();
  });

  it("chat drafting with onChunk enables stream: true and receives streamed chunks", async () => {
    let capturedBody: any;
    const chunks: string[] = [];
    const model: ModelRegistryEntry = {
      id: "draft-qwen3",
      taskTypes: ["draft"],
      runtime: "llama-server",
      baseUrl: "https://example.test/v1",
      model: "test-draft",
      capabilities: ["text"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    };
    const gateway = new ModelGateway(
      {
        async request() {
          throw new Error("should not call request when streamRequest exists");
        },
        async streamRequest(_url, init, _timeout, onChunk) {
          capturedBody = JSON.parse(init.body!);
          onChunk("Hello ");
          onChunk("World");
          const synthetic = JSON.stringify({
            choices: [{ message: { content: "Hello World", role: "assistant" }, finish_reason: "stop" }],
          });
          return {
            status: 200,
            async text() {
              return synthetic;
            },
          };
        },
      },
      new Map([[model.id, model]]),
    );

    const result = await gateway.execute({
      requestId: "req-draft-stream",
      runId: RUN_ID,
      taskType: "draft",
      modelId: "draft-qwen3",
      responseFormat: "chat-result",
      systemPrompt: "You are an assistant.",
      userPrompt: "Hi",
      timeoutMs: 1000,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value.result as any).text).toBe("Hello World");
    }
    expect(capturedBody.stream).toBe(true);
    expect(chunks).toEqual(["Hello ", "World"]);
  });

  it("code-summary disables structured output and streams execution summary", async () => {
    let capturedBody: any;
    const chunks: string[] = [];
    const model: ModelRegistryEntry = {
      id: "code-qwen25coder",
      taskTypes: ["code"],
      runtime: "llama-server",
      baseUrl: "https://example.test/v1",
      model: "test-coder",
      capabilities: ["text"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    };
    const gateway = new ModelGateway(
      {
        async request() {
          throw new Error("should stream");
        },
        async streamRequest(_url, init, _timeout, onChunk) {
          capturedBody = JSON.parse(init.body!);
          onChunk("The script has been ");
          onChunk("repaired and executed.");
          return {
            status: 200,
            async text() {
              return JSON.stringify({
                choices: [
                  {
                    message: { content: "The script has been repaired and executed.", role: "assistant" },
                    finish_reason: "stop",
                  },
                ],
              });
            },
          };
        },
      },
      new Map([[model.id, model]]),
    );

    const result = await gateway.execute({
      requestId: "req-summary-stream",
      runId: RUN_ID,
      taskType: "code",
      modelId: "code-qwen25coder",
      responseFormat: "code-summary",
      phase: "summarize",
      task: "fix script",
      execution: { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, outputFiles: [], durationMs: 100 },
      systemPrompt: "Summarize execution.",
      userPrompt: "Task: fix script",
      timeoutMs: 1000,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value.result as any).summary).toBe("The script has been repaired and executed.");
      expect((result.value.result as any).verified).toBe(true);
    }
    expect(capturedBody.response_format).toBeUndefined();
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.messages[0].content).toBe("Summarize execution.");
    expect(chunks).toEqual(["The script has been ", "repaired and executed."]);
  });

  it("applies json_object and greedy 0.0 temperature for local structured tasks", async () => {
    let capturedBody: any;
    const model: ModelRegistryEntry = {
      id: "vision-qwen25vl",
      taskTypes: ["vision"],
      runtime: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "test-vision",
      capabilities: ["text", "image-input"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    };
    const gateway = new ModelGateway(
      {
        async request(_url, init) {
          capturedBody = JSON.parse(init.body!);
          return {
            status: 200,
            async text() {
              return JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({ findings: [], pageReferences: [] }),
                      role: "assistant",
                    },
                    finish_reason: "stop",
                  },
                ],
              });
            },
          };
        },
      },
      new Map([[model.id, model]]),
    );

    const dataRoot = process.env.WORKBENCH_DATA_ROOT!;
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, "scan.png"), Buffer.from([0, 1, 2, 3]));

    const result = await gateway.execute({
      requestId: "req-local-opt",
      runId: RUN_ID,
      taskType: "vision",
      modelId: "vision-qwen25vl",
      responseFormat: "vision-result",
      attachment: {
        attachmentId: "att-opt",
        filename: "scan.png",
        mediaType: "image/png",
        relativePath: "scan.png",
        sizeBytes: 100,
      },
      inputMode: "typed-scan",
      systemPrompt: "Extract findings.",
      userPrompt: "Find data.",
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    // Verifies GBNF CPU freeze elimination via json_object
    expect(capturedBody.response_format).toEqual({ type: "json_object" });
    // Verifies greedy decoding (0.0) on local extraction tasks
    expect(capturedBody.temperature).toBe(0.0);
  });

  it("retries with json_schema when provider rejects json_object with 'must be json_schema or text'", async () => {
    let callCount = 0;
    let retryBody: any;
    const model: ModelRegistryEntry = {
      id: "vision-qwen25vl",
      taskTypes: ["vision"],
      runtime: "ollama",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen2.5-coder-7b-instruct-mlx",
      capabilities: ["text", "image-input"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    };
    const gateway = new ModelGateway(
      {
        async request(_url, init) {
          callCount++;
          const body = JSON.parse(init.body!);
          if (callCount === 1) {
            expect(body.response_format).toEqual({ type: "json_object" });
            return {
              status: 400,
              async text() {
                return JSON.stringify({ error: "'response_format.type' must be 'json_schema' or 'text'" });
              },
            };
          }
          retryBody = body;
          return {
            status: 200,
            async text() {
              return okEnvelope();
            },
          };
        },
      },
      new Map([[model.id, model]]),
    );

    const dataRoot = process.env.WORKBENCH_DATA_ROOT!;
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, "scan.png"), Buffer.from([0, 1, 2, 3]));

    const result = await gateway.execute({
      requestId: "req-lmstudio-retry",
      runId: RUN_ID,
      taskType: "vision",
      modelId: "vision-qwen25vl",
      responseFormat: "vision-result",
      attachment: {
        attachmentId: "att-opt",
        filename: "scan.png",
        mediaType: "image/png",
        relativePath: "scan.png",
        sizeBytes: 100,
      },
      inputMode: "typed-scan",
      systemPrompt: "Extract findings.",
      userPrompt: "Find data.",
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
    // Verifies retry successfully upgraded to json_schema as requested by LM Studio
    expect(retryBody.response_format.type).toBe("json_schema");
    expect(retryBody.response_format.json_schema.name).toBe("vision_result");
  });

  it("keeps image rejection as a real error without dropping visual evidence", async () => {
    let callCount = 0;
    let fallbackBody: any;
    const model: ModelRegistryEntry = {
      id: "vision-qwen25vl",
      taskTypes: ["vision"],
      runtime: "ollama",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen2.5-coder-7b-instruct-mlx",
      capabilities: ["text", "image-input"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    };
    const gateway = new ModelGateway(
      {
        async request(_url, init) {
          callCount++;
          const body = JSON.parse(init.body!);
          if (callCount === 1) {
            // First call sends multipart vision with image_url
            return {
              status: 400,
              async text() {
                return JSON.stringify({ error: "Model 'qwen2.5-coder-7b-instruct-mlx' does not support image input" });
              },
            };
          }
          fallbackBody = body;
          return {
            status: 200,
            async text() {
              return okEnvelope();
            },
          };
        },
      },
      new Map([[model.id, model]]),
    );

    const dataRoot = process.env.WORKBENCH_DATA_ROOT!;
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, "scan.png"), Buffer.from([0, 1, 2, 3]));

    const result = await gateway.execute({
      requestId: "req-image-fallback",
      runId: RUN_ID,
      taskType: "vision",
      modelId: "vision-qwen25vl",
      responseFormat: "vision-result",
      attachment: {
        attachmentId: "att-opt",
        filename: "scan.png",
        mediaType: "image/png",
        relativePath: "scan.png",
        sizeBytes: 100,
      },
      inputMode: "typed-scan",
      systemPrompt: "Extract findings.",
      userPrompt: "Find data in diagram.",
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(callCount).toBe(1);
    expect(fallbackBody).toBeUndefined();
  });

  it("retries the JSON format but retains image rejection as a real error", async () => {
    let callCount = 0;
    let finalBody: any;
    const model: ModelRegistryEntry = {
      id: "vision-qwen25vl",
      taskTypes: ["vision"],
      runtime: "ollama",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen2.5-coder-7b-instruct-mlx",
      capabilities: ["text", "image-input"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    };
    const gateway = new ModelGateway(
      {
        async request(_url, init) {
          callCount++;
          const body = JSON.parse(init.body!);
          if (callCount === 1) {
            // First call fails with response_format rejection
            return {
              status: 400,
              async text() {
                return JSON.stringify({ error: "'response_format.type' must be 'json_schema' or 'text'" });
              },
            };
          }
          if (callCount === 2) {
            // Second call (with json_schema) fails because model is text-only
            return {
              status: 400,
              async text() {
                return JSON.stringify({ error: "Model 'qwen2.5-coder-7b-instruct-mlx' does not support image input" });
              },
            };
          }
          finalBody = body;
          return {
            status: 200,
            async text() {
              return okEnvelope();
            },
          };
        },
      },
      new Map([[model.id, model]]),
    );

    const dataRoot = process.env.WORKBENCH_DATA_ROOT!;
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, "scan.png"), Buffer.from([0, 1, 2, 3]));

    const result = await gateway.execute({
      requestId: "req-both-retry",
      runId: RUN_ID,
      taskType: "vision",
      modelId: "vision-qwen25vl",
      responseFormat: "vision-result",
      attachment: {
        attachmentId: "att-opt",
        filename: "scan.png",
        mediaType: "image/png",
        relativePath: "scan.png",
        sizeBytes: 100,
      },
      inputMode: "typed-scan",
      systemPrompt: "Extract findings.",
      userPrompt: "Find data.",
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(callCount).toBe(2);
    expect(finalBody).toBeUndefined();
  });
});
