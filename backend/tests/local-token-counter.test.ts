import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countLocalAgentRequest } from "../src/main/gateway/local-token-counter.js";

let root: string;
const template = "{{ bos_token }} {% for message in messages %}{{ message.role }} {{ message.content }} {{ eos_token }} {% endfor %}{% if tools %}tools {{ tools | tojson }} {% endif %}{% if add_generation_prompt %}assistant{% endif %}";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "local-counter-"));
  writeFileSync(path.join(root, "tokenizer.json"), JSON.stringify({
    version: "1.0", added_tokens: [], normalizer: null, pre_tokenizer: { type: "WhitespaceSplit" }, post_processor: null, decoder: null,
    model: { type: "WordPiece", unk_token: "[UNK]", continuing_subword_prefix: "##", max_input_chars_per_word: 100,
      vocab: { "[UNK]": 0, BOS: 1, EOS: 2, system: 3, user: 4, assistant: 5, hi: 6, fix: 7, tools: 8 } },
  }));
  writeFileSync(path.join(root, "tokenizer_config.json"), JSON.stringify({ bos_token: "BOS", eos_token: "EOS", chat_template: template }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const messages = [{ role: "system", content: "hi" }, { role: "user", content: "fix" }];

describe("Bounded local prompt counting", () => {
  it("counts message wrappers, special tokens, and the generation prefix", async () => {
    const count = await countLocalAgentRequest({ assetsDir: root, payload: { messages } });
    // BOS system hi EOS user fix EOS assistant
    expect(count.inputTokens).toBe(8);
    expect(count.assetDigests["tokenizer.json"]).toMatch(/^[a-f0-9]{64}$/);
    expect(count.templateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(count.renderedDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("counts the prepared native tools and JSON prompt as supplied, without adding history", async () => {
    const plain = await countLocalAgentRequest({ assetsDir: root, payload: { messages } });
    const native = await countLocalAgentRequest({ assetsDir: root, payload: { messages, tools: [{ type: "function", function: { name: "read_file", description: "Read source", parameters: { type: "object" } } }] } });
    const json = await countLocalAgentRequest({ assetsDir: root, payload: { messages: [{ role: "system", content: "hi Available tools read_file path string" }, messages[1]] } });
    expect(native.inputTokens).toBeGreaterThan(plain.inputTokens);
    expect(json.inputTokens).toBe(13);
    expect(native.renderedDigest).not.toBe(json.renderedDigest);
  });

  it("binds counts to asset and template digests, including optional special-token files", async () => {
    const first = await countLocalAgentRequest({ assetsDir: root, payload: { messages } });
    writeFileSync(path.join(root, "special_tokens_map.json"), '{"eos_token":"EOS"}');
    const next = await countLocalAgentRequest({ assetsDir: root, payload: { messages }, activeTemplate: `${template} EOS` });
    expect(next.inputTokens).toBe(9);
    expect(next.templateDigest).not.toBe(first.templateDigest);
    expect(next.assetDigests).not.toEqual(first.assetDigests);
  });

  it("blocks missing assets, ambiguous templates, unsupported multimodal input, and cancelled work", async () => {
    await expect(countLocalAgentRequest({ assetsDir: path.join(root, "absent"), payload: { messages } })).rejects.toThrow();
    writeFileSync(path.join(root, "tokenizer_config.json"), JSON.stringify({ chat_template: [{ name: "default", template }] }));
    await expect(countLocalAgentRequest({ assetsDir: root, payload: { messages } })).rejects.toThrow("explicit supported chat template");
    await expect(countLocalAgentRequest({ assetsDir: root, payload: { messages: [{ role: "user", content: [{ type: "image_url" }] }] } })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(countLocalAgentRequest({ assetsDir: root, payload: { messages }, signal: controller.signal })).rejects.toThrow();
  });

  it("rejects tokenizer assets that point outside the selected local directory", async () => {
    const parent = path.join(root, "..", `${path.basename(root)}-outside.json`);
    try {
      writeFileSync(parent, "{}");
      symlinkSync(parent, path.join(root, "special_tokens_map.json"));
      await expect(countLocalAgentRequest({ assetsDir: root, payload: { messages } })).rejects.toThrow("leaves its selected directory");
    } finally { rmSync(parent, { force: true }); }
  });
});
