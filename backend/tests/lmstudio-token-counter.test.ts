import { homedir } from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countLMStudioPreparedRequest, lmStudioCountingInput } from "../src/main/gateway/lmstudio-token-counter.js";
import { countLocalAgentRequest } from "../src/main/gateway/local-token-counter.js";
import { formatMessagesForFallback } from "../src/main/gateway/model-gateway.js";

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
  it("compares local rendering and server counting with provider usage for four JSON transport probes", async () => {
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
      evidence.push({ probe: probe.name, status: response.status, providerInputTokens: result.usage?.prompt_tokens, server, local });
      console.log(JSON.stringify(evidence.at(-1)));
      expect(response.ok).toBe(true);
      expect(server.contextLimit).toBe(8192);
      expect(local.renderedDigest).toBe(server.renderedDigest);
      expect(local.inputTokens).toBe(server.inputTokens);
      expect(result.usage?.prompt_tokens).toBe(server.inputTokens);
    }
    if (process.env.WORKBENCH_AGENT_PROBE_REPORT) writeFileSync(process.env.WORKBENCH_AGENT_PROBE_REPORT, JSON.stringify({ recordedAt: new Date().toISOString(), endpoint, model, transport: "json", evidence }, null, 2));
  }, 120000);
});
