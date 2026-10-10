import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { createRun } from "../src/main/run/store.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createConfirmation, decide } from "../src/main/confirmation/store.js";
import { createRunDirectories, registerAttachment, resolveRunPath } from "../src/main/run/filesystem.js";
import { routeTask } from "../src/main/router/deterministic-router.js";
import { validateCode, validateCodeSummary, validateVision } from "../src/main/validators/responses.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { RunManager } from "../src/main/run/manager.js";
import { listMessages } from "../src/main/persistence/messages.js";
import type { ChatModelRequest, ModelRegistryEntry, RunEvent } from "../src/shared/contracts.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "workbench-integration-")); process.env.WORKBENCH_DATA_ROOT = path.join(dir, "data"); initDb(path.join(dir, "db.sqlite")); });
afterEach(() => { closeDb(); delete process.env.WORKBENCH_DATA_ROOT; if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("AI/backend integration safety", () => {
  it("routes reports to vision and CSV intent to code", () => { expect(routeTask("inspect this", { mediaType: "application/pdf" })).toEqual({ taskType: "vision", modelId: "primary-model", reason: "scanned report" }); expect(routeTask("flag CSV out-of-range readings", { mediaType: "text/csv" })).toEqual({ taskType: "code", modelId: "primary-model", reason: "CSV/code intent" }); expect(routeTask("summarise the data", { mediaType: "text/csv" })).toEqual({ taskType: "code", modelId: "primary-model", reason: "CSV/code intent" }); });
  it("routes attachment-less script requests to draft chat", () => { expect(routeTask("write me a small script")).toEqual({ taskType: "draft", modelId: "primary-model", reason: "fallback drafting" }); expect(routeTask("write me a script", { mediaType: "text/csv" })).toEqual({ taskType: "code", modelId: "primary-model", reason: "CSV/code intent" }); });
  it("rejects unsafe Python and accepts a bounded local script", () => { expect(validateCode({ filename: "task.py", source: "import requests", expectedResult: "x", inputFiles: ["data.csv"], outputFiles: ["summary.csv"], allowedImports: [] }).ok).toBe(false); expect(validateCode({ filename: "task.py", source: "import csv\nprint('ok')", expectedResult: "ok", inputFiles: ["data.csv"], outputFiles: ["summary.csv"], allowedImports: ["csv"] }).ok).toBe(true); });
  it("enforces vision page-reference integrity and code-summary shape", () => { const vision = validateVision({ sourceText: "E-201", findings: [{ findingId: "f1", title: "Leak", value: "yes", pageReferenceIds: ["p1"], confidence: "high", evidence: "page text" }], pageReferences: [{ id: "p1", page: 1, text: "page text" }] }); expect(vision.ok).toBe(true); expect(validateCodeSummary({ summary: "OUT_OF_RANGE 7/240 (high=5, low=2)", verified: true }).ok).toBe(true); expect(validateCodeSummary({ summary: "done" }).ok).toBe(false); });
  it("keeps attachments inside the run and rejects traversal", () => { const runId = createRun(createChat("attachment"), "test"); createRunDirectories(runId); const ref = registerAttachment(runId, { filename: "input.csv", mediaType: "text/csv", sizeBytes: 2, base64OrBuffer: "aGk=" }); expect(ref.relativePath).toContain(`runs/${runId}/input/`); expect(() => resolveRunPath(runId, "../other", "input")).toThrow(); expect(() => resolveRunPath(runId, "/etc/passwd", "input")).toThrow(); });
  it("stores attachments with unlisted MIME types", () => { const runId = createRun(createChat("generic attachment"), "test"); createRunDirectories(runId); const ref = registerAttachment(runId, { filename: "archive.bin", mediaType: "application/vnd.example.archive", sizeBytes: 2, base64OrBuffer: Buffer.from("hi") }); expect(ref.mediaType).toBe("application/vnd.example.archive"); expect(ref.filename).toBe("archive.bin"); });
  it("rejects confirmation replay and wrong run ids", () => { const runId = createRun(createChat("confirm"), "test"); const action = createConfirmation(runId, "execute_python"); expect(() => decide(runId, action.actionId, true)).not.toThrow(); expect(() => decide(runId, action.actionId, true)).toThrow(); expect(() => decide(createRun(createChat("other"), "other"), action.actionId, true)).toThrow(); });
  it("keeps credentials in the request header only when apiKeyEnv is set", async () => { process.env.TEST_MODEL_KEY = "secret-value"; const model: ModelRegistryEntry = { id: "draft-qwen3", taskTypes: ["draft"], runtime: "llama-server", baseUrl: "https://example.test/v1", model: "test-model", capabilities: ["text", "structured-output"], requestTimeoutMs: 1000, healthPath: "/models", apiKeyEnv: "TEST_MODEL_KEY", enabled: true }; let seen = ""; const gateway = new ModelGateway({ async request(_url, init) { seen = init.headers.authorization ?? ""; return { status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: "hi" }) } }] }); } }; } }, new Map([[model.id, model]])); const request: ChatModelRequest = { requestId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", taskType: "draft", modelId: "draft-qwen3", responseFormat: "chat-result", systemPrompt: "s", userPrompt: "u", timeoutMs: 1000 }; const result = await gateway.execute(request); expect(result.ok).toBe(true); expect(seen).toBe("Bearer secret-value"); });


  it("streams chat drafting directly into text chat without structured output", async () => {
    const emittedEvents: RunEvent[] = [];
    const model: ModelRegistryEntry = {
      id: "draft-qwen3",
      taskTypes: ["draft"],
      runtime: "llama-server",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      capabilities: ["text"],
      requestTimeoutMs: 1000,
      healthPath: "/models",
      enabled: true,
    };
    let capturedBody: any;
    const gateway = new ModelGateway(
      {
        async request() {
          throw new Error("should not call request when streaming");
        },
        async streamRequest(_url, init, _timeout, onChunk) {
          capturedBody = JSON.parse(init.body!);
          onChunk("Here is the ");
          onChunk("engineering summary.");
          return {
            status: 200,
            async text() {
              return JSON.stringify({
                choices: [
                  {
                    message: { content: "Here is the engineering summary.", role: "assistant" },
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

    const manager = new RunManager(gateway, (event) => emittedEvents.push(event));
    const chatId = createChat("Stream Chat");
    const { runId } = await manager.start({
      chatId,
      userText: "Give me an engineering summary of the pump skid.",
    });

    // Wait for the async run to finish
    await new Promise((r) => setTimeout(r, 200));

    // Verify response_format was NOT forced into a JSON schema
    expect(capturedBody.response_format).toBeUndefined();
    expect(capturedBody.stream).toBe(true);

    // Verify chunks were emitted with consistent messageId
    const chunks = emittedEvents.filter(
      (e): e is Extract<RunEvent, { type: "assistant_message_chunk" }> => e.type === "assistant_message_chunk",
    );
    expect(chunks.length).toBe(2);
    expect(chunks[0].delta).toBe("Here is the ");
    expect(chunks[1].delta).toBe("engineering summary.");
    const streamedMessageId = chunks[0].messageId;
    expect(chunks[1].messageId).toBe(streamedMessageId);

    // Verify final assistant_message matches the streamed messageId and text
    const finalMsg = emittedEvents.find(
      (e): e is Extract<RunEvent, { type: "assistant_message" }> => e.type === "assistant_message",
    );
    expect(finalMsg).toBeDefined();
    expect(finalMsg?.messageId).toBe(streamedMessageId);
    expect(finalMsg?.text).toBe("Here is the engineering summary.");

    // Verify persisted message in SQLite database
    const saved = listMessages(chatId);
    expect(saved.some((m) => m.id === streamedMessageId && m.content === "Here is the engineering summary.")).toBe(
      true,
    );
  });
});
