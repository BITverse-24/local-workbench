import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitLocalAgentRequest, assertAgentAdmissionReceipt, assertAgentProviderUsage, verifyLocalAgentCounter, type AgentCountingBinding } from "../src/main/gateway/agent-admission.js";

let root: string;
const template = "{% for m in messages %}{{ m.role }} {{ m.content }} EOS {% endfor %}assistant";
const binding: AgentCountingBinding = { endpoint: "http://localhost:1234/v1", modelIdentity: "loaded-model-revision", providerModel: "test-model", transport: "json", contextLimit: 8192,
  templateDigest: createHash("sha256").update(template).digest("hex") };
const payload = { model: binding.providerModel, messages: [{ role: "user", content: "fix" }], max_tokens: 2048 };
const probes = (["plain", "tools", "tool_result", "unicode"] as const).map(name => ({ name, payload }));
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "admission-"));
  writeFileSync(path.join(root, "tokenizer.json"), JSON.stringify({ version: "1.0", added_tokens: [], normalizer: null, decoder: null, post_processor: null,
    pre_tokenizer: { type: "WhitespaceSplit" }, model: { type: "WordPiece", unk_token: "UNK", vocab: { UNK: 0, user: 1, fix: 2, EOS: 3, assistant: 4 }, continuing_subword_prefix: "##", max_input_chars_per_word: 100 } }));
  writeFileSync(path.join(root, "tokenizer_config.json"), JSON.stringify({ chat_template: template }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const verify = () => verifyLocalAgentCounter({ binding, assetsDir: root, activeTemplate: template, probes, providerProbe: async () => ({ inputTokens: 4 }) });

describe("Agent exact admission", () => {
  it("admits a bounded prepared request only after setup and binds its exact payload", async () => {
    const verification = await verify();
    const receipt = await admitLocalAgentRequest({ binding, verification, assetsDir: root, activeTemplate: template, payload });
    expect(receipt.inputTokens).toBe(4);
    expect(receipt.outputTokens).toBe(2048);
    expect(() => assertAgentAdmissionReceipt(receipt, payload, binding)).not.toThrow();
    expect(() => assertAgentAdmissionReceipt(receipt, { ...payload, stream: true }, binding)).toThrow("changed after admission");
    expect(() => assertAgentProviderUsage(receipt, 4)).not.toThrow();
    expect(() => assertAgentProviderUsage(receipt, 5)).toThrow("Invalidate counting");
    expect(() => assertAgentProviderUsage(receipt, undefined)).toThrow("missing");
  });

  it("blocks setup mismatches, missing usage, missing probes, and template disagreement", async () => {
    await expect(verifyLocalAgentCounter({ binding, assetsDir: root, activeTemplate: template, probes, providerProbe: async () => ({ inputTokens: 3 }) })).rejects.toThrow("counts differ");
    await expect(verifyLocalAgentCounter({ binding, assetsDir: root, activeTemplate: template, probes, providerProbe: async () => ({}) })).rejects.toThrow("usage is missing");
    await expect(verifyLocalAgentCounter({ binding, assetsDir: root, activeTemplate: template, probes: probes.slice(0, 3), providerProbe: async () => ({ inputTokens: 4 }) })).rejects.toThrow("four fixed probes");
    await expect(verifyLocalAgentCounter({ binding, assetsDir: root, activeTemplate: `${template} EOS`, probes, providerProbe: async () => ({ inputTokens: 5 }) })).rejects.toThrow("active server template");
  });

  it("invalidates verification when the model, transport, template, or tokenizer changes", async () => {
    const verification = await verify();
    for (const change of [{ modelIdentity: "reloaded" }, { transport: "native" as const }, { templateDigest: "0".repeat(64) }])
      await expect(admitLocalAgentRequest({ binding: { ...binding, ...change }, verification, assetsDir: root, activeTemplate: template, payload })).rejects.toThrow("Verify counting again");
    writeFileSync(path.join(root, "added_tokens.json"), "{}");
    await expect(admitLocalAgentRequest({ binding, verification, assetsDir: root, activeTemplate: template, payload })).rejects.toThrow("Tokenizer or template changed");
  });

  it("blocks oversized input, excessive output, and a prepared request for another model", async () => {
    const verification = await verify();
    await expect(admitLocalAgentRequest({ binding, verification, assetsDir: root, activeTemplate: template, payload: { ...payload, messages: [{ role: "user", content: "fix ".repeat(6000) }] } })).rejects.toThrow("context limit");
    await expect(admitLocalAgentRequest({ binding, verification, assetsDir: root, activeTemplate: template, payload: { ...payload, max_tokens: 2049 } })).rejects.toThrow();
    await expect(admitLocalAgentRequest({ binding, verification, assetsDir: root, activeTemplate: template, payload: { ...payload, model: "other" } })).rejects.toThrow("different model");
  });
});
