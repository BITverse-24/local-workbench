import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countLMStudioPreparedRequest, lmStudioCountingInput } from "../src/main/gateway/lmstudio-token-counter.js";
import { countLocalAgentRequest } from "../src/main/gateway/local-token-counter.js";
import { formatMessagesForFallback } from "../src/main/gateway/model-gateway.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createRun } from "../src/main/run/store.js";
import { persistRunContract } from "../src/main/run/contract.js";
import { dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import { bindAgentTaskRun } from "../src/main/run/agent-task-store.js";
import { bindAgentExecutionLedger, getExecutionLedger, initializeExecutionLedger } from "../src/main/run/execution-ledger.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";
import { preparedRequestDigest, saveAgentCountingVerification, type AgentCountingVerification } from "../src/main/gateway/agent-admission.js";

describe("LM Studio prepared request conversion", () => {
  it("preserves tool arguments and result call IDs", () => {
    const input = lmStudioCountingInput({ messages: [
      { role: "user", content: "Read source" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"src/app.js"}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "source bytes" },
    ] });
    expect(input.chat.messages[1]).toEqual({ role: "assistant", content: [{ type: "toolCallRequest", toolCallRequest: { type: "function", id: "call-1", name: "read_file", arguments: { path: "src/app.js" } } }] });
    expect(input.chat.messages[2]).toEqual({ role: "tool", content: [{ type: "toolCallResult", toolCallId: "call-1", content: "source bytes" }] });
  });
  it("rejects unsupported input instead of silently dropping prompt content", async () => {
    expect(() => lmStudioCountingInput({ messages: [{ role: "user", content: [{ type: "image_url" }] }] })).toThrow();
    expect(() => lmStudioCountingInput({ messages: [{ role: "tool", content: "result" }] })).toThrow("call ID");
    expect(() => lmStudioCountingInput({ messages: [{ role: "user", content: "hello" }], chat_template_kwargs: {} })).toThrow("prompt option");
    await expect(countLMStudioPreparedRequest({ endpoint: "https://example.com", payload: {} })).rejects.toThrow("local or private");
  });
});

const endpoint = process.env.WORKBENCH_LMSTUDIO_PROBE_ENDPOINT;
describe.skipIf(!endpoint)("Live LM Studio tokenizer comparison (explicit opt-in)", () => {
  it("compares four JSON setup probes and admits a real gateway request", async () => {
    const model = process.env.WORKBENCH_LMSTUDIO_PROBE_MODEL ?? "qwen2.5-coder-7b-instruct-mlx";
    const assetsDir = process.env.WORKBENCH_LMSTUDIO_PROBE_ASSETS ?? path.join(homedir(), ".lmstudio/models/lmstudio-community/Qwen2.5-Coder-7B-Instruct-MLX-4bit");
    const toolInstruction = '\nAvailable tools: read_file. Arguments: {"path":"string"}. Return one JSON action.';
    const source = [
      { name: "plain", messages: [{ role: "system", content: "Return only OK." }, { role: "user", content: "Counting setup probe." }], addition: "" },
      { name: "tools", messages: [{ role: "system", content: "Return only OK." }, { role: "user", content: "Select read_file." }], addition: toolInstruction },
      { name: "tool_result", messages: [{ role: "system", content: "Return only OK." }, { role: "user", content: "Read source." },
        { role: "assistant", content: "", tool_calls: [{ id: "probe-1", type: "function", function: { name: "read_file", arguments: '{"path":"src/app.js"}' } }] },
        { role: "tool", content: "export const ready = true;", tool_call_id: "probe-1" }], addition: toolInstruction },
      { name: "unicode", messages: [{ role: "system", content: "Return only OK." }, { role: "user", content: "检查修复 🛠️ café हिन्दी\n\tconst π = 3.14;" }], addition: "" },
    ];
    const evidence: Record<string, unknown>[] = [];
    for (const probe of source) {
      const payload = { model, messages: formatMessagesForFallback(probe.messages, probe.addition), temperature: 0, max_tokens: 8, stream: false };
      const server = await countLMStudioPreparedRequest({ endpoint: endpoint!, payload });
      const local = await countLocalAgentRequest({ assetsDir, payload });
      const response = await fetch(`${endpoint!.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000), redirect: "error",
      });
      const result = await response.json() as { usage?: { prompt_tokens?: number }; error?: unknown };
      evidence.push({ probe: probe.name, requestDigest: preparedRequestDigest(payload), status: response.status, providerInputTokens: result.usage?.prompt_tokens, server, local });
      console.log(JSON.stringify(evidence.at(-1)));
      expect(response.ok).toBe(true);
      expect(server.contextLimit).toBe(8192);
      expect(local.renderedDigest).toBe(server.renderedDigest);
      expect(local.inputTokens).toBe(server.inputTokens);
      expect(result.usage?.prompt_tokens).toBe(server.inputTokens);
    }
    const root = mkdtempSync(path.join(tmpdir(), "agent-live-admission-")), previousRoot = dataRoot();
    let admissions: unknown;
    try {
      initDb(path.join(root, "db.sqlite")); setDataDir(root);
      const chatId = createChat(), text = "Reply with exactly OK.", messageId = addMessage({ chat_id: chatId, role: "user", content: text }).id;
      const runId = createRun(chatId, text), baseUrl = `${endpoint!.replace(/\/$/, "").replace(/\/v1$/, "")}/v1`;
      getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(runId, root);
      const bound = bindAgentTaskRun({ runId, chatId, messageId, workspace: { root, registeredAt: new Date().toISOString() }, disposition: "continue" });
      initializeExecutionLedger(persistRunContract({ schemaVersion: 1, runId, createdAt: new Date().toISOString(), objective: text, resolution: { status: "resolved" }, routing: { intentType: "file_inspection", taskType: "code", driverModel: "live-driver", actionable: true }, response: { required: true, chatOnly: false }, workspace: { requested: false, operations: [] }, deliverables: [], constraints: { protectedPaths: [], restrictMutationsToTargets: false, userConstraints: [] }, acceptance: { validateWrittenCode: false, validatedPythonDeliverables: [], artifactChecks: [] } }));
      bindAgentExecutionLedger(bound);
      const first = evidence[0] as { server: { instanceReference: string; contextLimit: number }; local: { templateDigest: string; counterIdentity: AgentCountingVerification["counterIdentity"]; assetDigests: Record<string, string> } };
      const verification: AgentCountingVerification = { schemaVersion: 1, binding: { endpoint: baseUrl, modelIdentity: first.server.instanceReference, providerModel: model, transport: "json", templateDigest: first.local.templateDigest, contextLimit: first.server.contextLimit }, counterIdentity: first.local.counterIdentity, assetDigests: first.local.assetDigests, verifiedAt: new Date().toISOString(),
        probes: evidence.map(item => ({ name: item.probe as AgentCountingVerification["probes"][number]["name"], requestDigest: item.requestDigest as string, inputTokens: item.providerInputTokens as number })) };
      saveAgentCountingVerification(verification);
      const activeTemplate = JSON.parse(readFileSync(path.join(assetsDir, "tokenizer_config.json"), "utf8")).chat_template as string;
      const gateway = new ModelGateway(undefined, [{ id: "live-driver", runtime: "mlx-lm", baseUrl, model, toolCallingFormat: "json", capabilities: ["text"], requestTimeoutMs: 60000, healthPath: "/models", enabled: true, contextLength: 8192 }]);
      const result = await withRuntimeScope({ runId, mode: "agent", signal: new AbortController().signal, agentCountingProfiles: [{ assetsDir, activeTemplate, verification }] }, () => gateway.chatWithTools("live-driver", [{ role: "system", content: "Reply only with a JSON object containing tool_calls as an empty array and content as OK." }, { role: "user", content: text }], [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }], { runId, maxTokens: 64 }));
      admissions = getExecutionLedger(runId)?.agentAdmissions;
      expect(result.ok).toBe(true);
      expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(1);
      expect(getExecutionLedger(runId)?.agentAdmissions[0]).toMatchObject({ status: "usage_verified", countingMethod: "exact", transport: "json" });
      console.log(JSON.stringify({ gatewayAdmissions: admissions }));
    } finally { closeDb(); setDataDir(previousRoot); rmSync(root, { recursive: true, force: true }); }
    if (process.env.WORKBENCH_AGENT_PROBE_REPORT) writeFileSync(process.env.WORKBENCH_AGENT_PROBE_REPORT, JSON.stringify({ recordedAt: new Date().toISOString(), endpoint, model, transport: "json", evidence, gatewayAdmissions: admissions }, null, 2));
  }, 120000);
});
