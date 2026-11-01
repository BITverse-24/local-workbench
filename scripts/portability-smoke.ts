// Built only for the native package smoke check. Uses production backend paths.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelGateway } from "../backend/src/main/gateway/model-gateway.js";
import { closeDb, configurePersistence, getDb, initDb } from "../backend/src/main/persistence/db.js";
import { createChat } from "../backend/src/main/persistence/chats.js";
import { createRun, getState, transition } from "../backend/src/main/run/store.js";
import { addMessage } from "../backend/src/main/persistence/messages.js";
import { bindAgentTaskRun, getAgentTaskBinding } from "../backend/src/main/run/agent-task-store.js";
import { bindAgentExecutionLedger, getExecutionLedger, initializeExecutionLedger, reconcileInterruptedExecutions } from "../backend/src/main/run/execution-ledger.js";
import { persistRunContract } from "../backend/src/main/run/contract.js";
import { recoverInterruptedModeRuns } from "../backend/src/main/run/recovery.js";
import { createConfirmation, decide } from "../backend/src/main/confirmation/store.js";
import { RunResultStore } from "../backend/src/main/run/result-store.js";
import { buildExecutionEnvelope } from "../backend/src/main/run/envelope.js";
import { withRuntimeScope } from "../backend/src/main/run/runtime-scope.js";
import { ToolDispatcher } from "../backend/src/main/agent/tool-dispatcher.js";
import { readFileTool, runCommandTool, normalizeRunCommandArgs } from "../backend/src/main/tools/workspace-tools.js";
import { retrieveResultTool } from "../backend/src/main/tools/result-retrieval.js";
import { MutationPolicyGuard } from "../backend/src/main/harness/policy-guard.js";
import { captureCommandWorkspaceDigest, commandApprovalDigest, getCommandCapability, runCommand } from "../backend/src/main/harness/tools/run-command.js";
import { createAgentVerificationRequest, discoverAgentTestPlans } from "../backend/src/main/agent/test-verification.js";

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
      if (process.platform === "darwin") {
        // Probe the packaged v3 command path with a launch environment that
        // cannot find Node. Do not run the test command or modify the project.
        writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({scripts:{test:"node --test"}}));
        writeFileSync(path.join(workspaceRoot, "case.js"), "module.exports = 1;\n");
        writeFileSync(path.join(workspaceRoot, "case.test.js"), "require('node:test').test('case',()=>{});\n");
        const discovery=discoverAgentTestPlans({workspaceRoot,changedPaths:["case.js"]});
        assert.equal(discovery.ok,true);
        if (!discovery.ok) throw new Error(discovery.detail);
        const request=createAgentVerificationRequest(discovery.plans[0]);
        const approval={workspaceDigest:captureCommandWorkspaceDigest(workspaceRoot)};
        const guard=new MutationPolicyGuard({strict:true});
        guard.grantScope({runId,operation:"run_command",command:request.command,operationDigest:commandApprovalDigest(request.command,approval),allowUnisolated:true});
        const priorPath=process.env.PATH,priorIsolation=process.env.WORKBENCH_USE_MAC_SANDBOX;
        process.env.PATH=path.join(root,"no-tools");process.env.WORKBENCH_USE_MAC_SANDBOX="0";
        try {
          const result=await withRuntimeScope({runId,mode:"agent",agentPhase:"actions",signal:new AbortController().signal},()=>runCommand(workspaceRoot,request.command,5000,{guard,runId,approval},request));
          assert.equal(result.verification?.reason,"test_runtime_unavailable");
          assert.equal(result.verification?.executed,0);
          assert.equal(readFileSync(path.join(workspaceRoot,"case.js"),"utf8"),"module.exports = 1;\n");
        } finally {
          if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;
          if(priorIsolation===undefined)delete process.env.WORKBENCH_USE_MAC_SANDBOX;else process.env.WORKBENCH_USE_MAC_SANDBOX=priorIsolation;
        }
      }
      closeDb(); initDb(dbPath);
      assert.equal(new RunResultStore(runId, getDb(), root).retrieveResultSlice(id).content, source);
      const recoveryChat=createChat(), recoveryRun=createRun(recoveryChat,"Preserve the pending repair"),messageId=addMessage({chat_id:recoveryChat,role:"user",content:"Preserve the pending repair"}).id;
      getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(recoveryRun,workspaceRoot);
      const binding=bindAgentTaskRun({runId:recoveryRun,chatId:recoveryChat,messageId,workspace:{root:workspaceRoot,registeredAt:"package-smoke"},disposition:"continue",updates:[]});
      const contract=persistRunContract({schemaVersion:1,runId:recoveryRun,createdAt:new Date().toISOString(),objective:"Preserve the pending repair",resolution:{status:"resolved"},routing:{intentType:"general_qa",taskType:"code",driverModel:"primary-model",actionable:true},response:{required:true,chatOnly:false},workspace:{requested:false,operations:[]},deliverables:[],constraints:{protectedPaths:[],restrictMutationsToTargets:false,userConstraints:[]},acceptance:{validateWrittenCode:false,validatedPythonDeliverables:[],artifactChecks:[]}});
      initializeExecutionLedger(contract);bindAgentExecutionLedger(binding);
      transition(recoveryRun,"classifying");transition(recoveryRun,"acting");transition(recoveryRun,"awaiting_confirmation");
      const confirmation=createConfirmation(recoveryRun,"plan_approval");
      closeDb();initDb(dbPath);reconcileInterruptedExecutions();recoverInterruptedModeRuns();
      assert.equal(getState(recoveryRun),"partial");
      assert.equal(getAgentTaskBinding(recoveryRun)?.taskRevision,binding.taskRevision);
      assert.equal(getExecutionLedger(recoveryRun)?.resumeCount,0);
      assert.ok(["expired","cancelled"].includes((getDb().prepare("SELECT outcome FROM confirmations WHERE action_id=?").get(confirmation.actionId) as {outcome:string}).outcome));
      assert.throws(()=>decide(recoveryRun,confirmation.actionId,true));
      assert.equal(readFileSync(path.join(workspaceRoot,"source.md"),"utf8"),source);
    });
    console.log(`Package portability check passed on ${process.platform}: Agent read, result retrieval, integrity, restart recovery, command validation, storage failure${process.platform === "darwin" ? ", and missing Node" : ""}.`);
  } finally {
    closeDb();
    if (priorRoot === undefined) delete process.env.WORKBENCH_DATA_ROOT; else process.env.WORKBENCH_DATA_ROOT = priorRoot;
    rmSync(root, { recursive: true, force: true });
  }
}
smoke().catch(error => { console.error(error); process.exitCode = 1; });
