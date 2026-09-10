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
import type { ChatModelRequest, ModelRegistryEntry } from "../src/shared/contracts.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "workbench-integration-")); process.env.WORKBENCH_DATA_ROOT = path.join(dir, "data"); initDb(path.join(dir, "db.sqlite")); });
afterEach(() => { closeDb(); delete process.env.WORKBENCH_DATA_ROOT; if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("AI/backend integration safety", () => {
  it("routes reports to vision and CSV intent to code", () => { expect(routeTask("inspect this", { mediaType: "application/pdf" })).toEqual({ taskType: "vision", modelId: "vision-qwen25vl", reason: "scanned report" }); expect(routeTask("flag CSV out-of-range readings", { mediaType: "text/csv" })).toEqual({ taskType: "code", modelId: "code-qwen25coder", reason: "CSV/code intent" }); expect(routeTask("summarise the data", { mediaType: "text/csv" })).toEqual({ taskType: "code", modelId: "code-qwen25coder", reason: "CSV/code intent" }); });
  it("routes attachment-less script requests to draft chat", () => { expect(routeTask("write me a small script")).toEqual({ taskType: "draft", modelId: "draft-qwen3", reason: "fallback drafting" }); expect(routeTask("write me a script", { mediaType: "text/csv" })).toEqual({ taskType: "code", modelId: "code-qwen25coder", reason: "CSV/code intent" }); });
  it("rejects unsafe Python and accepts a bounded local script", () => { expect(validateCode({ filename: "task.py", source: "import requests", expectedResult: "x", inputFiles: ["data.csv"], outputFiles: ["summary.csv"], allowedImports: [] }).ok).toBe(false); expect(validateCode({ filename: "task.py", source: "import csv\nprint('ok')", expectedResult: "ok", inputFiles: ["data.csv"], outputFiles: ["summary.csv"], allowedImports: ["csv"] }).ok).toBe(true); });
  it("enforces vision page-reference integrity and code-summary shape", () => { const vision = validateVision({ sourceText: "E-201", findings: [{ findingId: "f1", title: "Leak", value: "yes", pageReferenceIds: ["p1"], confidence: "high", evidence: "page text" }], pageReferences: [{ id: "p1", page: 1, text: "page text" }] }); expect(vision.ok).toBe(true); expect(validateCodeSummary({ summary: "OUT_OF_RANGE 7/240 (high=5, low=2)", verified: true }).ok).toBe(true); expect(validateCodeSummary({ summary: "done" }).ok).toBe(false); });
  it("keeps attachments inside the run and rejects traversal", () => { const runId = createRun(createChat("attachment"), "test"); createRunDirectories(runId); const ref = registerAttachment(runId, { filename: "input.csv", mediaType: "text/csv", sizeBytes: 2, base64OrBuffer: "aGk=" }); expect(ref.relativePath).toContain(`runs/${runId}/input/`); expect(() => resolveRunPath(runId, "../other", "input")).toThrow(); expect(() => resolveRunPath(runId, "/etc/passwd", "input")).toThrow(); });
  it("rejects confirmation replay and wrong run ids", () => { const runId = createRun(createChat("confirm"), "test"); const action = createConfirmation(runId, "execute_python"); expect(() => decide(runId, action.actionId, true)).not.toThrow(); expect(() => decide(runId, action.actionId, true)).toThrow(); expect(() => decide(createRun(createChat("other"), "other"), action.actionId, true)).toThrow(); });
  it("keeps OpenRouter credentials in the request header only", async () => { process.env.TEST_OPENROUTER_KEY = "secret-value"; const model: ModelRegistryEntry = { id: "draft-qwen3", taskTypes: ["draft"], runtime: "openrouter", baseUrl: "https://example.test/v1", model: "test-model", capabilities: ["text", "structured-output"], requestTimeoutMs: 1000, healthPath: "/models", apiKeyEnv: "TEST_OPENROUTER_KEY", enabled: true }; let seen = ""; const gateway = new ModelGateway({ async request(_url, init) { seen = init.headers.authorization ?? ""; return { status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: "hi" }) } }] }); } }; } }, new Map([[model.id, model]])); const request: ChatModelRequest = { requestId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", taskType: "draft", modelId: "draft-qwen3", responseFormat: "chat-result", systemPrompt: "s", userPrompt: "u", timeoutMs: 1000 }; const result = await gateway.execute(request); expect(result.ok).toBe(true); expect(seen).toBe("Bearer secret-value"); });
});
