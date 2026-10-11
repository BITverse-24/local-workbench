import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRegistryFromRows, configureModels } from "../src/main/gateway/registry.js";
import { ChatResponder } from "../src/main/run/chat-responder.js";
import { countTokens } from "../src/main/agent/context-manager.js";
import type { ModelRegistryEntry } from "../src/shared/contracts.js";

let root: string;
const profile: ModelRegistryEntry = { id: "primary-model", runtime: "ollama", model: "local-model", baseUrl: "http://127.0.0.1:11434/v1", capabilities: ["text"], requestTimeoutMs: 300000, healthPath: "/models", enabled: true, contextLength: 32768, maxOutputTokens: 4096, toolCallingFormat: "native", temperature: 0.1 };
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "context-portability-")); const config = path.join(root, "models.json"); writeFileSync(config, JSON.stringify({ models: [profile] })); configureModels({ modelsPath: config }); });
afterEach(() => { configureModels({ modelsPath: null }); rmSync(root, { recursive: true, force: true }); });

async function respond(model: ModelRegistryEntry, text = "Hey!") {
  const chat = vi.fn(async (_model: string, _messages: any[], _tools: any[], _options: any) => ({ ok: true, value: { content: "Hello!", finishReason: "stop" } }));
  const context = { runId: "test", workspaceRoot: root, gateway: { registry: new Map([[model.id, model]]), chatWithTools: chat } } as any;
  const result = await new ChatResponder().respond({ text, modelId: model.id, history: [{ role: "user", content: "Prior question" }], attachments: [], context, emit: () => {} });
  return { chat, result };
}

describe("Model context portability", () => {
  it("gives an unmatched LAN endpoint a separate output allowance", async () => {
    const [model] = buildRegistryFromRows([{ role: "draft", modelName: profile.model, host: "192.168.1.50", port: 11434, contextLength: 32768 }]);
    expect(model.baseUrl).toBe("http://192.168.1.50:11434/v1"); expect(model.contextLength).toBe(32768); expect(model.maxOutputTokens).toBe(8192);
    const { chat, result } = await respond(model); expect(result.text).toBe("Hello!"); expect(chat.mock.calls).toHaveLength(1);
  });
  it("retains transport and output settings only for an exact endpoint profile", () => {
    const [model] = buildRegistryFromRows([{ role: "draft", modelName: profile.model, host: "127.0.0.1", port: 11434, contextLength: 32768 }]);
    expect(model.maxOutputTokens).toBe(4096); expect(model.toolCallingFormat).toBe("native"); expect(model.temperature).toBe(0.1);
  });
  it.each([32768, 8192, 2048, 1024, 512])("caps a legacy oversized output limit within a %i-token context", async contextLength => {
    const { chat } = await respond({ ...profile, contextLength, maxOutputTokens: contextLength });
    const call = chat.mock.calls[0] as unknown as [string, Array<{ content: string }>, unknown[], { maxTokens: number }];
    expect(call[3].maxTokens).toBe(Math.floor(contextLength / 4));
    expect(call[1].reduce((sum, message) => sum + countTokens(message.content) + 4, 0) + call[3].maxTokens + Math.min(512, Math.max(32, Math.floor(contextLength / 16)))).toBeLessThan(contextLength);
  });
  it("retains a smaller explicit output allowance", async () => {
    const { chat } = await respond({ ...profile, maxOutputTokens: 512 }); expect((chat.mock.calls[0] as any)[3].maxTokens).toBe(512);
  });
  it("still rejects a request that cannot fit the model context", async () => {
    await expect(respond({ ...profile, contextLength: 2048, maxOutputTokens: 2048 }, "Long request. ".repeat(3000))).rejects.toThrow(/context limit/);
  });
});
