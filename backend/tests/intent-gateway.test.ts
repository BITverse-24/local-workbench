import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelRegistryEntry } from "../src/shared/contracts.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { resolveSemanticIntent, validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";

const registry: ModelRegistryEntry[] = [{ id: "primary-model", taskTypes: ["draft"], runtime: "ollama", baseUrl: "http://127.0.0.1:1234/v1", model: "fixture-reasoning-model", capabilities: ["text", "structured-output"], requestTimeoutMs: 180000, healthPath: "/models", enabled: true }];
const artifactIntent = { intentType: "code_modification", taskType: "code", driverModel: "primary-model", primaryGoal: "Repair attached reader", isActionable: true, chatResponseOnly: false, workspaceMutationRequested: false, targetFiles: [], protectedPaths: [], restrictMutationsToTargets: false, expectedDeliverables: [{ filename: "fixed-reader.py", type: "file" }] };

describe("Production intent classifier request and failure boundaries", () => {
  let tempDir: string;
  let previousDataRoot: string | undefined;
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "intent-wire-"));
    previousDataRoot = process.env.WORKBENCH_DATA_ROOT;
    process.env.WORKBENCH_DATA_ROOT = tempDir;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (previousDataRoot === undefined) delete process.env.WORKBENCH_DATA_ROOT;
    else process.env.WORKBENCH_DATA_ROOT = previousDataRoot;
    rmSync(tempDir, { recursive: true, force: true });
  });
  it("sends non-reasoning JSON-constrained classification with its own deadline", async () => {
    const transport = { request: vi.fn(async (_url: string, init: any, timeoutMs: number) => {
      const payload = JSON.parse(init.body);
      expect(payload.reasoning_effort).toBe("none");
      expect(payload.response_format.type).toBe("json_schema");
      expect(payload.response_format.json_schema.schema.type).toBe('object');
      expect(payload.response_format.json_schema.schema.properties).toHaveProperty('requestedAction');
      expect(timeoutMs).toBe(60000);
      expect(payload.max_tokens).toBe(768);
      return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(artifactIntent), reasoning_content: "" }, finish_reason: "stop" }] }) };
    }) };
    const intent = await resolveSemanticIntent({ userPrompt: "Repair the attached reader and return it as a file.", hasWorkspace: true }, new ModelGateway(transport, registry));
    expect(intent.status).toBe("resolved");
    expect(intent.workspaceMutationRequested).toBe(false);
    expect(intent.expectedDeliverables[0].filename).toBe("fixed-reader.py");
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it("reports reasoning-only truncation without an empty repair call or inferred intent", async () => {
    const transport = { request: vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "Analyze the request before writing the JSON." }, finish_reason: "length" }], usage: { completion_tokens: 383, completion_tokens_details: { reasoning_tokens: 383 } } }) })) };
    const intent = await resolveSemanticIntent({ userPrompt: "Fix this code.", hasWorkspace: true }, new ModelGateway(transport, registry));
    expect(intent.status).toBe("failed");
    expect(intent.failureReason).toContain("exhausted its output budget");
    expect(intent.isActionable).toBe(false);
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it("rejects empty final content even when reasoning contains an apparent intent", async () => {
    const transport = { request: vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "", reasoning_content: JSON.stringify(artifactIntent) }, finish_reason: "stop" }] }) })) };
    const intent = await resolveSemanticIntent({ userPrompt: "Fix this code." }, new ModelGateway(transport, registry));
    expect(intent.status).toBe("failed");
    expect(intent.failureReason).toContain("no final JSON");
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it("does not silently downgrade unsupported classification schemas to free text", async () => {
    const transport = { request: vi.fn(async () => ({ status: 400, text: async () => "response_format json_schema is unsupported" })) };
    const intent = await resolveSemanticIntent({ userPrompt: "Fix this code." }, new ModelGateway(transport, registry));
    expect(intent.status).toBe("failed");
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it("keeps an artifact when a non-mutating classification repeats its name in targets", () => {
    const intent = validateAndNormalizeIntent({ ...artifactIntent, targetFiles: ["fixed-reader.py"] }, { userPrompt: "Repair attachment", hasWorkspace: true, workspaceFiles: ["fixed-reader.py"] });
    expect(intent.targetFiles).toEqual([]);
    expect(intent.expectedDeliverables[0].filename).toBe("fixed-reader.py");
  });
  it("keeps the classification deadline active after response headers arrive", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("classification body aborted")), { once: true });
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = resolveSemanticIntent({ userPrompt: "Fix this code." }, new ModelGateway(undefined, registry));
    await vi.advanceTimersByTimeAsync(60000);
    const intent = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(intent.status).toBe("failed");
    expect(intent.failureReason).toContain("classification body aborted");
  });
  it("treats explicit null ambiguity as a resolved chat request", () => {
    const intent = validateAndNormalizeIntent({ ...artifactIntent, intentType: "general_qa", isActionable: false, chatResponseOnly: true, expectedDeliverables: [], ambiguityDetails: null }, { userPrompt: "Explain CSV rows", hasWorkspace: true, workspaceFiles: [] });
    expect(intent.status).toBe("resolved");
    expect(intent.ambiguityDetails).toBeUndefined();
  });
});
