// Built only for the native package smoke check. Uses production backend paths.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelGateway } from "../backend/src/main/gateway/model-gateway.js";
import { closeDb, configurePersistence, getDb, initDb } from "../backend/src/main/persistence/db.js";
import { createChat } from "../backend/src/main/persistence/chats.js";
import { createRun } from "../backend/src/main/run/store.js";
import { RunResultStore } from "../backend/src/main/run/result-store.js";
import { buildExecutionEnvelope } from "../backend/src/main/run/envelope.js";
import { withRuntimeScope } from "../backend/src/main/run/runtime-scope.js";
import { ToolDispatcher } from "../backend/src/main/agent/tool-dispatcher.js";
import { readFileTool, runCommandTool, normalizeRunCommandArgs } from "../backend/src/main/tools/workspace-tools.js";
import { retrieveResultTool } from "../backend/src/main/tools/result-retrieval.js";
import { MutationPolicyGuard } from "../backend/src/main/harness/policy-guard.js";
import { getCommandCapability } from "../backend/src/main/harness/tools/run-command.js";

async function smoke() {
  const root = mkdtempSync(path.join(os.tmpdir(), "workbench-package-smoke-"));
  const priorRoot = process.env.WORKBENCH_DATA_ROOT;
  process.env.WORKBENCH_DATA_ROOT = root;
  try {
    configurePersistence({ dataDir: root, schemaPath: path.join(__dirname, "..", "..", "backend", "src", "main", "persistence", "schema.sql") });
    const dbPath = path.join(root, "db.sqlite"); initDb(dbPath);
    const runId = createRun(createChat(), "Package portability check");
    getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v1',?)").run(runId, path.join(root, "workspace"));
    const workspaceRoot = path.join(root, "workspace"); mkdirSync(workspaceRoot);
    const source = "A real file read from the packaged Agent backend.\n";
    writeFileSync(path.join(workspaceRoot, "source.md"), source);
    writeFileSync(path.join(workspaceRoot, "module.py"), "def double(value): return value * 2\n");
    const resultStore = new RunResultStore(runId, getDb(), root);
    const policyGuard = new MutationPolicyGuard({ strict: true });
    const envelope = buildExecutionEnvelope({ runId, mode: "agent", modelId: "primary-model", hasWorkspace: true, workspaceRoot, commandExecutionRequested: true });
    const events: any[] = [];
    const context = { runId, workspaceRoot, gateway: {} as ModelGateway, resultStore, envelope, policyGuard, emitRunEvent: (event: any) => events.push(event) };
    const dispatcher = new ToolDispatcher([readFileTool, retrieveResultTool, runCommandTool]);
    await withRuntimeScope({ runId, mode: "agent", signal: new AbortController().signal }, async () => {
      const [read] = await dispatcher.dispatchConcurrent([{ id: "read", name: "read_file", arguments: { path: "source.md" } }], context);
      assert.equal(read.result.ok, true, read.result.output);
      const id = read.result.resultRef!.resultId;
      const [retrieved] = await dispatcher.dispatchConcurrent([{ id: "retrieve", name: "retrieve_result", arguments: { result_id: id } }], context);
      assert.equal(retrieved.result.ok, true, retrieved.result.output);
      assert.ok(retrieved.result.output.includes(source.trim()));
      assert.equal(resultStore.verifyIntegrity(id).valid, true);
      const capabilities = await getCommandCapability();
      assert.notEqual(capabilities.status, "unavailable", capabilities.message);
      // Force the macOS fallback as well. Linux uses its actual host capability.
      const priorSandbox = process.env.WORKBENCH_USE_MAC_SANDBOX;
      process.env.WORKBENCH_USE_MAC_SANDBOX = "0";
      try {
        const args = normalizeRunCommandArgs({ command: "python3 -B", python_code: "import module\nassert module.double(7) == 14\nprint('CHECK_OK')" });
        const command = args.command as string;
        policyGuard.grantScope({ runId, operation: "run_command", command, allowUnisolated: true });
        const [checked] = await dispatcher.dispatchConcurrent([{ id: "check", name: "run_command", arguments: args }], context);
        assert.equal(checked.result.ok, true, checked.result.output);
        assert.ok(checked.result.output.includes("CHECK_OK"));
        if (process.platform === "win32" || process.platform === "darwin") assert.ok(checked.result.output.includes('"isolationStatus":"unisolated"'));
      } finally {
        if (priorSandbox === undefined) delete process.env.WORKBENCH_USE_MAC_SANDBOX; else process.env.WORKBENCH_USE_MAC_SANDBOX = priorSandbox;
      }
      getDb().exec("CREATE TRIGGER fail_result_insert BEFORE INSERT ON intermediate_results BEGIN SELECT RAISE(ABORT,'injected manifest failure'); END");
      const [failed] = await dispatcher.dispatchConcurrent([{ id: "failure", name: "read_file", arguments: { path: "source.md" } }], context);
      assert.equal(failed.result.ok, false);
      if (!failed.result.ok) {
        assert.equal(failed.result.error.code, "persistence_failure");
        assert.ok(failed.result.error.message.includes("commit result manifest"));
        assert.ok(failed.result.error.message.includes("did not modify workspace files"));
      }
      assert.equal(events.filter(e => e.type === "tool_result" && e.callId === "failure")[0].ok, false);
      assert.equal(readFileSync(path.join(workspaceRoot, "source.md"), "utf8"), source);
      getDb().exec("DROP TRIGGER fail_result_insert");
      closeDb(); initDb(dbPath);
      assert.equal(new RunResultStore(runId, getDb(), root).retrieveResultSlice(id).content, source);
    });
    console.log(`Package portability check passed on ${process.platform}: Agent read, result retrieval, integrity, reopen, command validation and storage failure.`);
  } finally {
    closeDb();
    if (priorRoot === undefined) delete process.env.WORKBENCH_DATA_ROOT; else process.env.WORKBENCH_DATA_ROOT = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
}
smoke().catch(error => { console.error(error); process.exitCode = 1; });
