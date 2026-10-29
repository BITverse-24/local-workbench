import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AgentTaskRunner } from "../src/main/agent/agent-task-runner.js";
import { discoverAgentTestPlans } from "../src/main/agent/test-verification.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { getCurrentAgentTask } from "../src/main/run/agent-task-store.js";
import { buildExecutionEnvelope } from "../src/main/run/envelope.js";
import { getExecutionLedger } from "../src/main/run/execution-ledger.js";
import { dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";
import { createRun, transition } from "../src/main/run/store.js";

function workspaceFiles(root: string, relative = ""): Record<string, string> {
  return Object.fromEntries(readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    if (entry.name === ".harness_backups") return [];
    const name = path.join(relative, entry.name);
    return entry.isDirectory() ? Object.entries(workspaceFiles(root, name)) : [[name, createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex")]];
  }));
}

// Input must be a prepared, pristine evaluation copy. Never restore or edit the incident workspace.
it.skipIf(!process.env.WORKBENCH_LMSTUDIO_REPAIR_PROBE)("diagnoses an actual 7B Flow D repair in a fresh workspace", async () => {
  const source = process.env.WORKBENCH_AGENT_REPAIR_WORKSPACE, report = process.env.WORKBENCH_AGENT_REPAIR_REPORT;
  if (!source || !report) throw new Error("Set the prepared workspace and diagnostic report paths.");
  const selectedRuntimeSourceDigests = Object.fromEntries([
    "agent/agent-task-runner.ts","agent/task-interpretation.ts","agent/requirement-scope.ts","agent/context-packet.ts","agent/source-evidence.ts","agent/requirement-review.ts",
    "agent/test-verification.ts","agent/verification-stage.ts","run/agent-task-store.ts","run/execution-ledger.ts","gateway/model-gateway.ts","harness/policy-guard.ts","harness/tools/run-command.ts","harness/tools/list-dir.ts",
  ].map(file=>[file,createHash("sha256").update(readFileSync(path.join(process.cwd(),"backend/src/main",file))).digest("hex")]));
  const temporary = mkdtempSync(path.join(tmpdir(), "agent-repair-live-")), previous = dataRoot();
  const workspace = path.join(temporary, "workspace"); mkdirSync(workspace);
  cpSync(source, workspace, { recursive: true, filter: file => !file.split(path.sep).includes(".harness_backups") });
  const original = workspaceFiles(workspace), mutable = new Set(["src/storage.js", "src/work-orders.js"]);
  const discovery = discoverAgentTestPlans({workspaceRoot:workspace,changedPaths:[]});
  if (!discovery.ok) throw new Error(discovery.detail);
  const testCommands = new Set(discovery.plans.map(plan => plan.fullCommand));
  const project = JSON.parse(readFileSync(path.join(workspace,"package.json"),"utf8"));
  // Exact aliases for this fixture's one immutable test script. No command prefix grants.
  if (project.scripts?.test === "node --test" && Object.keys(project.scripts).length === 1) {
    testCommands.add("npm test");testCommands.add("node --test");
  }
  const request = "Inspect the FieldOps work-order web app in this workspace. Reproduce its failing tests, then repair both defects: the status filter must work with search, and invalid saved browser data must not stop the app from loading. Keep the current design and public behavior. Do not add dependencies. Run the full test suite and explain the cause and fix in each module.";
  setDataDir(temporary); initDb(path.join(temporary, "db.sqlite"));
  const endpoint = process.env.WORKBENCH_LMSTUDIO_PROBE_ENDPOINT ?? "http://127.0.0.1:1234";
  const gateway = new ModelGateway(undefined, [{ id:"live-driver",runtime:"mlx-lm",baseUrl:`${endpoint.replace(/\/$/,"")}/v1`,model:"qwen2.5-coder-7b-instruct-mlx",capabilities:["text"],requestTimeoutMs:60000,healthPath:"/models",enabled:true,contextLength:8192,toolCallingFormat:"json" }]);
  const chatId = createChat(), runId = createRun(chatId, request), messageId = addMessage({chat_id:chatId,role:"user",content:request}).id;
  getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(runId, workspace);
  const guard = new MutationPolicyGuard(); guard.setProtectedPaths(runId,Object.keys(original).filter(file => !mutable.has(file)));
  const diagnosticDeadlineMs = 900000;
  const store = new RunResultStore(runId), controller = new AbortController(), timer = setTimeout(()=>controller.abort(),diagnosticDeadlineMs);
  const approvals: Array<{preview:unknown;approved:boolean}> = [];
  // Opt-in local evidence only. Preserve the native transport and its deadlines.
  const preparedRequests: unknown[] = [], fetchNative = globalThis.fetch;
  const capture = vi.spyOn(globalThis,"fetch").mockImplementation((url,init)=>{
    if (String(url).endsWith("/chat/completions") && typeof init?.body === "string") preparedRequests.push(JSON.parse(init.body));
    return fetchNative(url,init);
  });
  try {
    const result = await withRuntimeScope({runId,mode:"agent",signal:controller.signal},()=>new AgentTaskRunner().run({modelId:"live-driver",chatId,messageId,workspace:{root:workspace,registeredAt:"repair-diagnostic"},
      state:state=>transition(runId,state),approve:async preview=>{
        const operation = JSON.parse(preview.split("\n\n")[0]);
        const approved = operation.operation === "run_command" ? testCommands.has(operation.arguments.command) :
          ["edit_file","write_file"].includes(operation.operation) && mutable.has(operation.arguments.path);
        approvals.push({preview:operation,approved}); return approved;
      },context:{runId,workspaceRoot:workspace,gateway,resultStore:store,policyGuard:guard,signal:controller.signal,envelope:buildExecutionEnvelope({runId,mode:"agent",modelId:"live-driver",hasWorkspace:true,workspaceRoot:workspace})}}));
    const independent = spawnSync(process.execPath,["--test"],{cwd:workspace,encoding:"utf8",timeout:15000,env:{...process.env,ELECTRON_RUN_AS_NODE:"1"}});
    const records = store.listResults({limit:50});
    for(let offset=50;records.length===offset;offset+=50)records.push(...store.listResults({limit:50,offset}));
    const results = records.map(record=>{
      let content="",offset:number|undefined=0;
      while(offset!==undefined){const page=store.retrieveResultSlice(record.resultId,{mode:"text",offset,maxChars:3000});content+=page.content;offset=page.nextOffset;}
      return {record,content};
    });
    const current = workspaceFiles(workspace), changed = [...new Set([...Object.keys(original),...Object.keys(current)])].filter(file=>original[file]!==current[file]);
    const proof = {recordedAt:new Date().toISOString(),scope:"Source-runtime diagnostic; not packaged or release certification",diagnosticDeadlineMs,selectedRuntimeSourceDigests,model:"qwen2.5-coder-7b-instruct-mlx",contextLimit:8192,result,original,current,changed,
      protectedFilesUnchanged:changed.every(file=>mutable.has(file)),approvals,preparedRequests,task:getCurrentAgentTask(chatId),ledger:getExecutionLedger(runId),results,
      independentTests:{status:independent.status,signal:independent.signal,stdout:independent.stdout,stderr:independent.stderr,error:independent.error?.message},
      finalSources:Object.fromEntries([...mutable].map(file=>[file,readFileSync(path.join(workspace,file),"utf8")]))};
    writeFileSync(report,JSON.stringify(proof,null,2));
    expect(proof.protectedFilesUnchanged).toBe(true);
    expect(result.outcome,result.text).toBe("completed");
    expect(independent.status,independent.stdout+independent.stderr).toBe(0);
    expect(proof.ledger?.agentAdmissions.every(item=>item.status==="usage_verified")).toBe(true);
  } finally {capture.mockRestore();clearTimeout(timer);closeDb();setDataDir(previous);rmSync(temporary,{recursive:true,force:true});}
},920000);
