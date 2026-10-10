import { approvedPythonTool as executePythonTool } from "./helpers/approved-python.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool, ToolExecutionContext } from "../src/main/tools/types.js";
import type { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { createChat } from "../src/main/persistence/chats.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createRun } from "../src/main/run/store.js";
import { createRunDirectories } from "../src/main/run/filesystem.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";
import { compactConversationHistory, compactToolObservation, type AgentMessage } from "../src/main/agent/context-manager.js";
import { extractDocumentTool } from "../src/main/tools/specialist-tools.js";
import { readFileTool, listDirTool, writeFileTool } from "../src/main/tools/workspace-tools.js";
import { retrieveResultTool } from "../src/main/tools/result-retrieval.js";
import { normalizeRunContract } from "../src/main/run/contract.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";

describe("P1 production result registration and retrieval integration", () => {
  let root: string, dbPath: string, runId: string, runDir: string, context: ToolExecutionContext, oldRoot: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "p1-memory-")); oldRoot = process.env.WORKBENCH_DATA_ROOT; process.env.WORKBENCH_DATA_ROOT = root;
    dbPath = path.join(root, "db.sqlite"); initDb(dbPath); runId = createRun(createChat(), "Synthetic result-memory integration"); runDir = createRunDirectories(runId);
    context = { runId, workspaceRoot: path.join(runDir, "input"), gateway: { execute() { throw new Error("Native fixture must not call a model"); } } as unknown as ModelGateway, resultStore: new RunResultStore(runId, getDb(), root) };
  });
  afterEach(() => { closeDb(); if (oldRoot === undefined) delete process.env.WORKBENCH_DATA_ROOT; else process.env.WORKBENCH_DATA_ROOT = oldRoot; rmSync(root, { recursive: true, force: true }); });

  it("preserves 240 facts from twelve extracted documents after compaction, removal of sources/messages, and reopening the store", async () => {
    const extractor = new ToolDispatcher([extractDocumentTool]);
    const retrieval = new ToolDispatcher([retrieveResultTool]);
    const messages: AgentMessage[] = [{ role: "system", content: "Inspect these synthetic sources" }];
    const records: Array<{ id: string; filename: string; facts: string[]; text: string }> = [];
    for (let doc = 0; doc < 12; doc++) {
      const filename = `synthetic-source-${doc}.svg`;
      const facts = Array.from({ length: 20 }, (_, fact) => `FACT_${doc}_${fact} = original-value-${doc * 20 + fact}; ${"source-only-padding ".repeat(35)}`.trim());
      const text = facts.join("\n");
      writeFileSync(path.join(context.workspaceRoot, filename), `<svg xmlns="http://www.w3.org/2000/svg">${facts.map((fact, line) => `<text x="0" y="${line * 20}">${fact}</text>`).join("")}</svg>`);
      const call = { id: `extraction-${doc}`, name: "extract_document", arguments: { filename } };
      const [execution] = await extractor.dispatchConcurrent([call], context);
      expect(execution.result.ok).toBe(true);
      const record = execution.result.resultRef!;
      expect(record.storage.sizeBytes).toBeGreaterThan(8000);
      expect(record.sources).toEqual([{ filename, relation: "source" }]);
      expect(record.origin).toBe("source_extracted");
      expect(record.status).toBe("complete");
      expect(execution.result.output.length).toBeLessThanOrEqual(4000);
      if (execution.result.ok) expect(execution.result.data).toEqual({ resultId: record.resultId, type: "document", status: "complete" });
      messages.push({ role: "assistant", content: null, tool_calls: [call], turn: doc + 1 });
      messages.push({ role: "tool", tool_call_id: call.id, toolName: "extract_document", content: execution.result.output, resultId: record.resultId, turn: doc + 1 });
      records.push({ id: record.resultId, filename, facts, text });
    }
    const compacted = compactConversationHistory(messages, 50, 2, { globalSafetyLimit: 512 });
    for (let doc = 0; doc < 12; doc++) {
      const toolMessage = compacted.find((m) => m.tool_call_id === `extraction-${doc}`)!;
      expect(toolMessage.compaction?.truncated).toBe(true);
      expect(toolMessage.content).toContain(records[doc].id);
      expect(toolMessage.content).toContain("retrieve_result");
      expect(toolMessage.content).not.toContain(`FACT_${doc}_10 =`);
      expect(toolMessage.content!.length).toBeLessThanOrEqual(512);
      expect(compacted.some((m) => m.tool_calls?.some((c) => c.id === toolMessage.tool_call_id))).toBe(true);
    }

    // Original documents and AgentLoop-style messages are no longer available.
    for (const record of records) rmSync(path.join(context.workspaceRoot, record.filename));
    messages.length = 0;
    const verifyStoredFacts = async () => {
      for (const record of records) {
        for (const factIndex of [0, 10, 19]) {
          const fact = record.facts[factIndex];
          const [execution] = await retrieval.dispatchConcurrent([{ id: `recover-${record.id}-${factIndex}`, name: "retrieve_result", arguments: { result_id: record.id, mode: "json", pointer: "/sourceText", offset: record.text.indexOf(fact), max_chars: fact.length } }], context);
          expect(execution.result.ok).toBe(true);
          const slice = execution.result.ok ? execution.result.data as { content: string } : undefined;
          expect(slice?.content).toBe(fact);
          expect(context.resultStore!.inspectResult(record.id).sources).toEqual([{ filename: record.filename, relation: "source" }]);
        }
      }
      expect(context.resultStore!.listResults({ limit: 50 })).toHaveLength(12);
    };
    await verifyStoredFacts();
    closeDb(); initDb(dbPath);
    context.resultStore = new RunResultStore(runId, getDb(), root);
    await verifyStoredFacts();
  });

  it("captures full file contents before read_file observation truncation and provides bounded retrieval", async () => {
    const text = Array.from({ length: 700 }, (_, n) => `line ${n}: actual-value-${n}`).join("\n");
    writeFileSync(path.join(context.workspaceRoot, "large.txt"), text);
    const [execution] = await new ToolDispatcher([readFileTool]).dispatchConcurrent([{ id: "full-read", name: "read_file", arguments: { path: "large.txt" } }], context);
    expect(execution.result.ok).toBe(true);
    expect(execution.result.output).not.toContain("actual-value-350");
    const record = execution.result.resultRef!;
    expect(context.resultStore!.retrieveResultSlice(record.resultId, { mode: "lines", startLine: 351, count: 1 }).content).toBe("line 350: actual-value-350");
    const output = await retrieveResultTool.execute({ result_id: record.resultId, max_chars: 3000 }, context);
    expect(output.output.length).toBeLessThanOrEqual(4000);
    expect(context.resultStore!.getResult(record.resultId).storage.sizeBytes).toBe(Buffer.byteLength(text));
  });
  it("preserves SVG read payloads beyond the legacy extraction cap", async () => {
    const facts = Array.from({ length: 30 }, (_, n) => `source-${n}: ${"native text ".repeat(40)}`.trim());
    writeFileSync(path.join(context.workspaceRoot, "large.svg"), `<svg>${facts.map((fact) => `<text>${fact}</text>`).join("")}</svg>`);
    const [execution] = await new ToolDispatcher([readFileTool]).dispatchConcurrent([{ id: "svg-read", name: "read_file", arguments: { path: "large.svg" } }], context);
    expect(execution.result.ok).toBe(true);
    const record = execution.result.resultRef!;
    expect(record.storage.sizeBytes).toBeGreaterThan(8000);
    const headerLength = `[Document: large.svg (SVG Vector Drawing, ${facts.join("\n").length} characters)]\n\n`.length;
    expect(context.resultStore!.retrieveResultSlice(record.resultId, { mode: "text", offset: headerLength + facts.join("\n").indexOf("source-29:"), maxChars: facts[29].length }).content).toBe(facts[29]);
  });
  it("preserves result references within small budgets and rejects budgets that would destroy the ID", () => {
    const record = context.resultStore!.registerResult({ type: "text", origin: "source_extracted", status: "complete", producer: { tool: "read_file", callId: "small-budget" }, payload: "x".repeat(2000), summary: "source" });
    const observation = compactToolObservation({ content: "x".repeat(2000), resultId: record.resultId, isOlderTurn: true, maxBudget: 100 });
    expect(observation.content.length).toBeLessThanOrEqual(100);
    expect(observation.content).toContain(record.resultId);
    expect(observation.content).toContain("retrieve_result");
    expect(() => compactToolObservation({ content: "x", resultId: record.resultId, isOlderTurn: true, maxBudget: 20 })).toThrow("cannot preserve");
  });
  it("keeps escaped retrieval slices intact with accurate continuation inside the observation budget", async () => {
    const payload = "\u0001\"\\".repeat(2000);
    const record = context.resultStore!.registerResult({ type: "text", origin: "source_extracted", status: "complete", producer: { tool: "read_file", callId: "escaped-text" }, payload, summary: "escaped source" });
    const result = await retrieveResultTool.execute({ result_id: record.resultId, max_chars: 3000 }, context);
    expect(result.output.length).toBeLessThanOrEqual(4000);
    const slice = result.data as { content: string; nextOffset: number; truncated: boolean };
    expect(slice.truncated).toBe(true);
    expect(slice.nextOffset).toBe(slice.content.length);
    expect(slice.content).toBe(payload.slice(0, slice.nextOffset));
    expect(result.output).not.toContain("OBSERVATION COMPACTED");
    expect(JSON.parse(result.output.slice(result.output.indexOf("\n") + 1)).content).toBe(slice.content);
  });
  it("does not publish canonical workspace writes as deliverable artifacts", async () => {
    context.runContract = normalizeRunContract(runId, validateAndNormalizeIntent({ intentType: "code_modification", primaryGoal: "Write a workspace module", isActionable: true, chatResponseOnly: false, workspaceMutationRequested: true, targetFiles: ["module.py"], expectedDeliverables: [] }, { hasWorkspace: true, workspaceFiles: [], userPrompt: "Write module.py" }));
    const [execution] = await new ToolDispatcher([writeFileTool]).dispatchConcurrent([{ id: "workspace-write", name: "write_file", arguments: { path: "module.py", content: "value = 1" } }], context);
    expect(execution.result.ok).toBe(true);
    expect(execution.result.artifacts).toBeUndefined();
  });
  it("retains compatibility and does not persist small directory listings or legacy callers", async () => {
    const [listing] = await new ToolDispatcher([listDirTool]).dispatchConcurrent([{ id: "listing", name: "list_dir", arguments: {} }], context);
    expect(listing.result.ok).toBe(true);
    expect(listing.result.resultRef).toBeUndefined();
    expect(context.resultStore!.listResults()).toEqual([]);
    writeFileSync(path.join(context.workspaceRoot, "small.txt"), "unchanged legacy output");
    const legacy = { ...context, resultStore: undefined };
    const [read] = await new ToolDispatcher([readFileTool]).dispatchConcurrent([{ id: "legacy-read", name: "read_file", arguments: { path: "small.txt" } }], legacy);
    expect(read.result.output).toBe("unchanged legacy output");
    expect(read.result.resultRef).toBeUndefined();
  });
  it("registers partial execution and derived provenance without attributing conclusions to sources", async () => {
    const tool: AgentTool = { name: "execute_python", definition: { type: "function", function: { name: "execute_python", description: "fixture external dependency", parameters: { type: "object", properties: {} } } }, async execute() {
      return { ok: false, output: JSON.stringify({ exitCode: 1, stdout: "first step completed", stderr: "second step failed" }), summary: "Partial transformation", error: { code: "validation_failure", retryable: true, message: "second step failed" }, intermediate: { type: "execution", status: "partial", origin: "execution", payload: { partialRows: [{ value: 7 }] }, sources: [{ filename: "input.csv", relation: "input" }] } };
    } };
    const [execution] = await new ToolDispatcher([tool]).dispatchConcurrent([{ id: "partial-call", name: "execute_python", arguments: {} }], context);
    expect(execution.result.ok).toBe(false);
    expect(execution.result.resultRef?.status).toBe("partial");
    expect(execution.result.resultRef?.origin).toBe("execution");
    expect(context.resultStore!.retrieveResultSlice(execution.result.resultRef!.resultId, { mode: "json", pointer: "/partialRows/0/value" }).content).toBe("7");
  });
  it("registers real Python output before display truncation and retrieves its original tail", async () => {
    context.runContract = normalizeRunContract(runId, validateAndNormalizeIntent({ intentType: "general_qa", primaryGoal: "Compute in chat", isActionable: false, chatResponseOnly: true, workspaceMutationRequested: false, targetFiles: [], expectedDeliverables: [] }, { hasWorkspace: false, workspaceFiles: [], userPrompt: "Compute in chat" }));
    const tail = ":tail-original";
    const [execution] = await new ToolDispatcher([executePythonTool]).dispatchConcurrent([{ id: "real-python", name: "execute_python", arguments: { code: `print("prefix:" + "x" * 9000 + ${JSON.stringify(tail)})` } }], context);
    expect(execution.result.ok,JSON.stringify(execution.result)).toBe(true);
    expect(execution.result.resultRef?.status).toBe("complete");
    expect(execution.result.output.length).toBeLessThanOrEqual(4000);
    expect(execution.result.artifacts).toBeUndefined();
    expect(context.resultStore!.retrieveResultSlice(execution.result.resultRef!.resultId, { mode: "json", pointer: "/capturedOutput/stdout", offset: 9007, maxChars: tail.length }).content).toBe(tail);
  });
  it("returns persistence failure rather than tool success when the real insert fails", async () => {
    const events: any[] = []; context.emitRunEvent = (event) => events.push(event);
    writeFileSync(path.join(context.workspaceRoot, "source.txt"), "real observation");
    getDb().exec("CREATE TRIGGER fail_result_insert BEFORE INSERT ON intermediate_results BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END");
    const [execution] = await new ToolDispatcher([readFileTool]).dispatchConcurrent([{ id: "failed-save", name: "read_file", arguments: { path: "source.txt" } }], context);
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) expect(execution.result.error.code).toBe("persistence_failure");
    expect(events.filter((e) => e.type === "tool_result").every((e) => e.ok === false)).toBe(true);
    expect(context.resultStore!.listResults()).toEqual([]);
  });
  it("rejects mutation of immutable stored payloads through the common execution boundary", async () => {
    const record = context.resultStore!.registerResult({ type: "text", status: "complete", origin: "source_extracted", producer: { tool: "read_file", callId: "original" }, summary: "original", payload: "original immutable value" });
    const sandbox = { ...context, workspaceRoot: path.join(runDir, "intermediate") };
    const [execution] = await new ToolDispatcher([writeFileTool]).dispatchConcurrent([{ id: "rewrite", name: "write_file", arguments: { path: record.storage.relativePath.replace(/^intermediate\//, ""), content: "changed" } }], sandbox);
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) expect(execution.result.error.code).toBe("permission_denied");
    expect(context.resultStore!.retrieveResultSlice(record.resultId).content).toBe("original immutable value");
  });
});
