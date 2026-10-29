import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvas } from "canvas";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createRun } from "../src/main/run/store.js";
import { persistRunContract } from "../src/main/run/contract.js";
import { createRunDirectories, dataRoot, setDataDir, writeRunFile } from "../src/main/run/filesystem.js";
import { bindAgentTaskRun } from "../src/main/run/agent-task-store.js";
import { bindAgentExecutionLedger, consumeAgentModelCall, getExecutionLedger, initializeExecutionLedger } from "../src/main/run/execution-ledger.js";
import { withRuntimeScope, type RuntimeScope } from "../src/main/run/runtime-scope.js";
import { countLocalAgentRequest } from "../src/main/gateway/local-token-counter.js";
import * as serverCounter from "../src/main/gateway/lmstudio-token-counter.js";
import { loadAgentCountingVerification, saveAgentCountingVerification, verifyLocalAgentCounter } from "../src/main/gateway/agent-admission.js";
import { ModelGateway, type GatewayTransport } from "../src/main/gateway/model-gateway.js";
import type { AgentToolDefinition, ModelRegistryEntry } from "../src/shared/contracts.js";

let root: string, previousRoot: string, runId: string, scope: RuntimeScope;
let prepared: Record<string, any>[], dispatched: Record<string, any>[];
const template = "{% for m in messages %}{{ m.role }} {{ m.content }} EOS {% endfor %}{% if tools %}TOOLS {{ tools | tojson }} {% endif %}assistant";
const model: ModelRegistryEntry = { id: "driver", runtime: "mlx-lm", baseUrl: "http://127.0.0.1:1234/v1", model: "test-driver", capabilities: ["text"], requestTimeoutMs: 1000, healthPath: "/models", enabled: true, contextLength: 8192 };
const tools: AgentToolDefinition[] = [{ type: "function", function: { name: "read_file", description: "Read source", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "agent-gateway-")); previousRoot = dataRoot(); setDataDir(root); initDb(path.join(root, "db.sqlite"));
  writeFileSync(path.join(root, "tokenizer.json"), JSON.stringify({ version: "1.0", added_tokens: [], normalizer: null, decoder: null, post_processor: null, pre_tokenizer: { type: "WhitespaceSplit" },
    model: { type: "WordPiece", unk_token: "UNK", vocab: { UNK: 0, user: 1, assistant: 2, EOS: 3, Setup: 4 }, continuing_subword_prefix: "##", max_input_chars_per_word: 100000 } }));
  writeFileSync(path.join(root, "tokenizer_config.json"), JSON.stringify({ chat_template: template }));
  const chatId = createChat(), messageId = addMessage({ chat_id: chatId, role: "user", content: "Inspect and repair source" }).id;
  runId = createRun(chatId, "Inspect and repair source");
  getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3','/project')").run(runId);
  const binding = bindAgentTaskRun({ runId, chatId, messageId, workspace: { root: "/project", registeredAt: "first" }, disposition: "continue" });
  const contract = persistRunContract({ schemaVersion: 1, runId, createdAt: new Date().toISOString(), objective: "Inspect and repair source", resolution: { status: "resolved" }, routing: { intentType: "code_modification", taskType: "code", driverModel: model.id, actionable: true }, response: { required: true, chatOnly: false }, workspace: { requested: true, operations: [] }, deliverables: [], constraints: { protectedPaths: [], restrictMutationsToTargets: false, userConstraints: [] }, acceptance: { validateWrittenCode: true, validatedPythonDeliverables: [], artifactChecks: [] } });
  initializeExecutionLedger(contract); bindAgentExecutionLedger(binding);
  scope = { runId, mode: "agent", signal: new AbortController().signal, agentCountingProfiles: [], assertAuthority: vi.fn() };
  for (const transport of ["native", "json"] as const) {
    const probePayload = { model: model.model, messages: [{ role: "user", content: "Setup" }], max_tokens: 8 };
    const verification = await verifyLocalAgentCounter({ binding: { endpoint: model.baseUrl, modelIdentity: "loaded-instance", providerModel: model.model, transport, contextLimit: 8192, templateDigest: createHash("sha256").update(template).digest("hex") },
      assetsDir: root, activeTemplate: template, probes: (["plain", "tools", "tool_result", "unicode"] as const).map(name => ({ name, payload: probePayload })), providerProbe: async () => ({ inputTokens: 4 }) });
    saveAgentCountingVerification(verification);
    scope.agentCountingProfiles!.push({ assetsDir: root, activeTemplate: template, verification });
  }
  prepared = []; dispatched = [];
  vi.spyOn(serverCounter, "countLMStudioPreparedRequest").mockImplementation(async options => {
    prepared.push(structuredClone(options.payload));
    const local = await countLocalAgentRequest({ assetsDir: root, activeTemplate: template, payload: options.payload });
    return { inputTokens: local.inputTokens, renderedDigest: local.renderedDigest, instanceReference: "loaded-instance", modelPath: "local/model", contextLimit: 8192, counterIdentity: "lmstudio-sdk-1.5.0" };
  });
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); setDataDir(previousRoot); rmSync(root, { recursive: true, force: true }); });

function response(content = "Done", tokens?: number) {
  return JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: tokens, completion_tokens: 1 } });
}
function transport(replies?: (payload: Record<string, any>, index: number) => Promise<{ status: number; body: string }>): GatewayTransport {
  return { async request(_url, init) {
    const payload = JSON.parse(init.body!); dispatched.push(payload);
    const reply = replies ? await replies(payload, dispatched.length) : { status: 200, body: response("Done", (await countLocalAgentRequest({ assetsDir: root, activeTemplate: template, payload })).inputTokens) };
    return { status: reply.status, text: async () => reply.body };
  } };
}
function call(gateway: ModelGateway, extra = {}) { return withRuntimeScope(scope, () => gateway.chatWithTools(model.id, [{ role: "user", content: "Inspect source" }], tools, { runId, maxTokens: 2048, ...extra })); }

describe("Agent v3 gateway dispatch boundary", () => {
  it("keeps no-tool phases free of action-envelope instructions", async () => {
    const gateway = new ModelGateway(transport(), [{ ...model, toolCallingFormat: "json" }]);
    const messages = [{ role: "system", content: "Review coverage. Return coverage JSON." }, { role: "user", content: "Saved task and evidence" }];
    const result = await withRuntimeScope(scope, () => gateway.chatWithTools(model.id, messages, [], { runId, maxTokens: 512 }));
    expect(result.ok).toBe(true); expect(dispatched[0].messages).toEqual(messages);
    expect(prepared).toEqual(dispatched);
  });
  it("counts the actual streamed native payload and saves usage evidence before returning an action", async () => {
    const raw = transport();
    raw.streamRequest = async (url, init, timeout, chunk) => { chunk("draft"); return raw.request(url, init, timeout); };
    const result = await call(new ModelGateway(raw, [model]), { onChunk: vi.fn() });
    expect(result.ok).toBe(true);
    expect(prepared[0].stream).toBe(true);
    expect(prepared[0].tools).toEqual(tools);
    expect(prepared[0]).toEqual(dispatched[0]);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(1);
    expect(getExecutionLedger(runId)?.agentAdmissions[0]).toMatchObject({ countingMethod: "exact", status: "usage_verified", transport: "native", inputTokens: result.ok ? result.value.usage?.inputTokens : -1 });
  });

  it("recounts native-to-JSON fallback and consumes both dispatches", async () => {
    const raw = transport(async (payload, index) => index === 1 ? { status: 400, body: "Unsupported tools parameter" } : { status: 200, body: response('{"tool_calls":[],"content":"Done"}', (await countLocalAgentRequest({ assetsDir: root, activeTemplate: template, payload })).inputTokens) });
    const result = await call(new ModelGateway(raw, [model]));
    expect(result.ok).toBe(true);
    expect(dispatched).toHaveLength(2);
    expect(prepared).toEqual(dispatched);
    expect(dispatched[1].tools).toBeUndefined();
    expect(dispatched[1].messages[0].content).toContain("AVAILABLE TOOLS");
    expect(dispatched[1].response_format).toMatchObject({ type: "json_schema", json_schema: { schema: { properties: { tool_calls: { maxItems: 1 } } } } });
    expect(getExecutionLedger(runId)?.agentAdmissions.map(item => [item.transport, item.status])).toEqual([["native", "provider_error"], ["json", "usage_verified"]]);
  });

  it("recounts JSON format fallback and includes each attempt in the persisted limit", async () => {
    const raw = transport(async (payload, index) => index === 1 ? { status: 400, body: "response_format type must be supported" } : { status: 200, body: response('{"tool_calls":[],"content":"Done"}', (await countLocalAgentRequest({ assetsDir: root, activeTemplate: template, payload })).inputTokens) });
    expect((await call(new ModelGateway(raw, [{ ...model, toolCallingFormat: "json" }]))).ok).toBe(true);
    expect(prepared).toEqual(dispatched);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(2);
    expect(getExecutionLedger(runId)?.agentAdmissions[0].requestDigest).not.toBe(getExecutionLedger(runId)?.agentAdmissions[1].requestDigest);
  });

  it("blocks missing setup and never downgrades a counting failure to JSON", async () => {
    scope.agentCountingProfiles = [];
    const result = await call(new ModelGateway(transport(), [model]));
    expect(result).toMatchObject({ ok: false, error: { code: "agent_admission_failed", retryable: false } });
    expect(dispatched).toHaveLength(0);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(0);
  });

  it("invalidates a changed server binding before dispatch", async () => {
    vi.mocked(serverCounter.countLMStudioPreparedRequest).mockResolvedValue({ inputTokens: 4, renderedDigest: "0".repeat(64), instanceReference: "reloaded", modelPath: "local/model", contextLimit: 8192, counterIdentity: "lmstudio-sdk-1.5.0" });
    const result = await call(new ModelGateway(transport(), [model]));
    expect(result).toMatchObject({ ok: false, error: { code: "agent_admission_failed" } });
    expect(dispatched).toHaveLength(0);
    expect(loadAgentCountingVerification(scope.agentCountingProfiles![0].verification.binding)).toBeUndefined();
  });

  it("withholds an action when usage mismatches and blocks later calls with the expired profile", async () => {
    const gateway = new ModelGateway(transport(async () => ({ status: 200, body: response('{"tool_calls":[{"name":"write_file","arguments":{"path":"app.js","content":"bad"}}]}', 999) })), [model]);
    expect(await call(gateway)).toMatchObject({ ok: false, error: { code: "agent_admission_failed", retryable: false } });
    expect(getExecutionLedger(runId)?.agentAdmissions[0].status).toBe("mismatch");
    expect(await call(gateway)).toMatchObject({ ok: false, error: { code: "agent_admission_failed" } });
    expect(dispatched).toHaveLength(1);
  });

  it("rejects missing provider usage rather than returning an unverified action", async () => {
    const gateway = new ModelGateway(transport(async () => ({ status: 200, body: response("Proposed action") })), [model]);
    expect(await call(gateway)).toMatchObject({ ok: false, error: { code: "agent_admission_failed" } });
    expect(getExecutionLedger(runId)?.agentAdmissions[0].status).toBe("mismatch");
  });

  it("checks authority again after counting and before dispatch", async () => {
    const counter = vi.mocked(serverCounter.countLMStudioPreparedRequest).getMockImplementation()!;
    vi.mocked(serverCounter.countLMStudioPreparedRequest).mockImplementation(async options => {
      const value = await counter(options);
      scope.assertAuthority = () => { throw new Error("Workspace authority changed"); };
      return value;
    });
    expect(await call(new ModelGateway(transport(), [model]))).toMatchObject({ ok: false, error: { code: "agent_admission_failed" } });
    expect(dispatched).toHaveLength(0);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(0);
  });

  it("uses a labelled vision estimate only for the host's prepared vision request", async () => {
    scope.agentCountingProfiles = [];
    createRunDirectories(runId);
    const image = createCanvas(2, 2).toBuffer("image/png");
    const relativePath = writeRunFile(runId, "input", "probe.png", image);
    const raw = transport(async () => ({ status: 200, body: response(JSON.stringify({ sourceText: "text", findings: [], pageReferences: [] }), 123) }));
    const gateway = new ModelGateway(raw, [{ ...model, capabilities: ["text", "image-input", "structured-output"] }]);
    const result = await withRuntimeScope(scope, () => gateway.execute({ requestId: "11111111-1111-4111-8111-111111111111", runId, taskType: "vision", modelId: model.id, responseFormat: "vision-result", systemPrompt: "Inspect image", userPrompt: "Read source", timeoutMs: 1000, maxTokens: 128, inputMode: "typed-scan",
      attachment: { attachmentId: "22222222-2222-4222-8222-222222222222", filename: "probe.png", relativePath, mediaType: "image/png", sizeBytes: image.length } }));
    expect(result.ok).toBe(true);
    expect(prepared).toHaveLength(0);
    expect(getExecutionLedger(runId)?.agentAdmissions[0]).toMatchObject({ countingMethod: "vision_estimate", counterIdentity: "file-extension-estimate-v1", transport: "vision", status: "estimate_used", providerInputTokens: 123 });
    expect(getExecutionLedger(runId)?.agentAdmissions[0].templateDigest).toBeUndefined();
  });

  it("blocks oversized packets without invalidating valid setup", async () => {
    const gateway = new ModelGateway(transport(), [model]);
    const result = await withRuntimeScope(scope, () => gateway.chatWithTools(model.id, [{ role: "user", content: "word ".repeat(7000) }], tools, { runId, maxTokens: 2048 }));
    expect(result).toMatchObject({ ok: false, error: { code: "agent_admission_failed" } });
    expect(dispatched).toHaveLength(0);
    expect(loadAgentCountingVerification(scope.agentCountingProfiles![0].verification.binding)).toBeDefined();
  });

  it("keeps the 40-call limit at the transport boundary", async () => {
    for (let i = 0; i < 40; i++) consumeAgentModelCall(runId);
    expect((await call(new ModelGateway(transport(), [model]))).ok).toBe(false);
    expect(dispatched).toHaveLength(0);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(40);
  });

  it("leaves Chat and Work generation independent of Agent counting setup", async () => {
    for (const mode of ["chat", "work"] as const) {
      scope.mode = mode;
      const gateway = new ModelGateway(transport(async () => ({ status: 200, body: response() })), [model]);
      expect((await call(gateway)).ok).toBe(true);
    }
    expect(prepared).toHaveLength(0);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(0);
  });
});
