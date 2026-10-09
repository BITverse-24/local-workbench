import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import type { ModelProgressEvent, ModelRegistryEntry } from "../src/shared/contracts.js";

const model: ModelRegistryEntry = { id: "local", model: "local", runtime: "llama-server", baseUrl: "http://localhost:8080/v1", capabilities: ["text"], enabled: true, requestTimeoutMs: 1000, healthPath: "/models" };
let dir = "";
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "workbench-progress-")); process.env.WORKBENCH_DATA_ROOT = dir; });
afterEach(() => { delete process.env.WORKBENCH_DATA_ROOT; rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const envelope = (content: string | null, extra = {}) => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content, ...extra }, finish_reason: "stop" }] }) });

it("streams structured specialist output for progress without publishing its payload", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const events: ModelProgressEvent[] = [];
  let payload: any;
  const gateway = new ModelGateway({ request: async () => { throw new Error("Expected stream"); },
    streamRequest: async (_url, init, _timeout, onChunk, onActivity) => {
      payload = JSON.parse(init.body!);
      now += 200;
      onActivity?.({ channel: "reasoning", chars: 30 });
      now += 200;
      onChunk('{"filename":"task.py","source":"print(1)","expectedResult":"one","inputFiles":[],"outputFiles":[],"allowedImports":[]}');
      return envelope('{"filename":"task.py","source":"print(1)","expectedResult":"one","inputFiles":[],"outputFiles":[],"allowedImports":[]}');
    } }, [model]);
  gateway.onProgress(event => events.push(event));
  const visible: string[] = [];
  const result = await gateway.execute({ requestId: "request", runId: "00000000-0000-4000-8000-000000000101", modelId: "local", taskType: "code", responseFormat: "code-result",
    systemPrompt: "Return source", userPrompt: "Write code", timeoutMs: 1000, task: "Write code", inputFile: { attachmentId: "input", filename: "input.csv", mediaType: "text/csv" }, allowedLanguage: "python", executionRules: [], parentToolCallId: "tool", onChunk: chunk => visible.push(chunk) });
  expect(result.ok).toBe(true);
  expect(payload.stream).toBe(true);
  expect(visible).toEqual([]);
  expect(events.map(event => [event.status, event.channel])).toEqual([
    ["waiting", "structured"], ["receiving", "reasoning"], ["receiving", "structured"], ["received", "structured"],
  ]);
  expect(events.every(event => event.parentCallId === "tool")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("print(1)");
});

it("observes streamed JSON tool fallback while preserving complete arguments", async () => {
  const gateway = new ModelGateway({ request: async () => { throw new Error("Expected stream"); }, streamRequest: async (_url, init, _timeout, chunk) => {
    expect(JSON.parse(init.body!).stream).toBe(true);
    const value = '{"content":"","tool_calls":[{"name":"write_file","arguments":{"path":"main.py","content":"x = 1\\n"}}]}';
    chunk(value);
    return envelope(value);
  } }, [{ ...model, toolCallingFormat: "json" }]);
  const events: ModelProgressEvent[] = [];
  gateway.onProgress(event => events.push(event));
  const text: string[] = [];
  const result = await gateway.chatWithTools("local", [{ role: "user", content: "Write the file" }], [{ type: "function", function: { name: "write_file", description: "Save", parameters: { type: "object", properties: {} } } }], { runId: "00000000-0000-4000-8000-000000000102", onChunk: chunk => text.push(chunk) });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.tool_calls?.[0].arguments).toEqual({ path: "main.py", content: "x = 1\n" });
  expect(text).toEqual([]);
  expect(events[events.length - 1].outputChars).toBeGreaterThan(0);
});

it("does not promote reasoning-only output to a completed answer", async () => {
  const gateway = new ModelGateway({ request: async () => envelope(null, { reasoning_content: "Private thought" }) }, [model]);
  const result = await gateway.chatWithTools("local", [{ role: "user", content: "Explain" }], []);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("empty_model_response");
});

it("publishes a real transport failure and stops notifying removed observers", async () => {
  const gateway = new ModelGateway({ request: async () => { throw new Error("Connection lost"); } }, [model]);
  const events: ModelProgressEvent[] = [];
  const unsubscribe = gateway.onProgress(event => events.push(event));
  await gateway.chatWithTools("local", [{ role: "user", content: "Explain" }], [], { runId: "00000000-0000-4000-8000-000000000103" });
  expect(events.map(event => event.status)).toEqual(["waiting", "failed"]);
  unsubscribe();
  await gateway.chatWithTools("local", [{ role: "user", content: "Explain" }], [], { runId: "00000000-0000-4000-8000-000000000103" });
  expect(events).toHaveLength(2);
});

it("shows bounded plain specialist drafts without promoting them to final chat", async () => {
  const events: ModelProgressEvent[] = [];
  const gateway = new ModelGateway({ request: async () => { throw new Error("Expected stream"); }, streamRequest: async (_url, _init, _timeout, onChunk, onActivity) => {
    onActivity?.({ channel: "reasoning", chars: 40 });
    onChunk("<think>Private analysis</think>");
    onChunk("Draft section. " + "Useful text. ".repeat(100));
    return envelope("Draft section. " + "Useful text. ".repeat(100));
  } }, [model]);
  gateway.onProgress(event => events.push(event));
  const response = await gateway.execute({ requestId: "draft", runId: "00000000-0000-4000-8000-000000000104", modelId: "local", taskType: "draft", responseFormat: "chat-result", systemPrompt: "Write a draft", userPrompt: "Draft the report", timeoutMs: 1000, parentToolCallId: "draft-tool" });
  expect(response.ok).toBe(true);
  const preview = events[events.length - 1].preview!;
  expect(preview).toHaveLength(800);
  expect(preview).toContain("Useful text.");
  expect(JSON.stringify(events)).not.toContain("Private analysis");
});
