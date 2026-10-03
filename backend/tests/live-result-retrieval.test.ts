import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { ModelConfigRow, RunEvent } from "../src/shared/contracts.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { retrieveResultTool } from "../src/main/tools/result-retrieval.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { buildRegistryFromRows, loadRegistry } from "../src/main/gateway/registry.js";
import { AgentLoop } from "../src/main/agent/agent-loop.js";

// Explicit opt-in fails if unreachable; ordinary offline suites report an actual skip.
describe.skipIf(process.env.WORKBENCH_LIVE_RESULT_TESTS !== "1")("Live local-model result retrieval", () => {
  it("invokes native retrieval and recovers the original stored value without source documents", async () => {
    let registry;
    if (process.env.WORKBENCH_LIVE_MODELS_PATH) registry = [...loadRegistry(process.env.WORKBENCH_LIVE_MODELS_PATH).values()];
    else {
      const settings = new Database(process.env.WORKBENCH_LIVE_DB_PATH ?? path.resolve("data/data/workbench.db"), { readonly: true, fileMustExist: true });
      try {
        const row = settings.prepare("SELECT value FROM settings WHERE key='configured_models'").get() as { value: string } | undefined;
        if (!row) throw new Error("Live result test needs configured_models or WORKBENCH_LIVE_MODELS_PATH");
        registry = buildRegistryFromRows(JSON.parse(row.value) as ModelConfigRow[]);
      } finally { settings.close(); }
    }
    const root = mkdtempSync(path.join(os.tmpdir(), "p1-live-result-"));
    try {
      initDb(path.join(root, "db.sqlite"));
      const runId = createRun(createChat(), "Live retrieval test");
      const store = new RunResultStore(runId, getDb(), root);
      const record = store.registerResult({ type: "structured", status: "complete", origin: "source_extracted", producer: { tool: "read_file", callId: "live-fixture" }, summary: "Stored facts; source is unavailable", payload: { facts: [{ label: "early", value: "small" }, { label: "requested", value: "preserved-value-6187" }] }, sources: [{ filename: "removed-synthetic-source.txt", relation: "source" }] });
      const events: RunEvent[] = [];
      const result = await new AgentLoop().run({ runId, driverModelId: "draft-qwen3", userPrompt: `Use retrieve_result to read result ${record.resultId} at JSON pointer /facts/1/value. Report its exact value. The source file is unavailable.`, systemPrompt: "Use native retrieval for stored data. Never guess its value.", tools: [retrieveResultTool], context: { runId, workspaceRoot: root, gateway: new ModelGateway(undefined, registry), resultStore: store }, maxTurns: 4, emitEvent: (event) => events.push(event) });
      expect(events.some((e) => e.type === "tool_call" && String(e.tool) === "retrieve_result")).toBe(true);
      expect(result.finalText).toContain("preserved-value-6187");
      expect(result.outcome).toBe("completed");
    } finally { closeDb(); rmSync(root, { recursive: true, force: true }); }
  }, 120000);
});
