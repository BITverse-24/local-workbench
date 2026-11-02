import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { assessAgentFileScope } from "../src/main/agent/requirement-scope.js";
import { parseTaskInterpretation } from "../src/main/agent/task-interpretation.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { createRun } from "../src/main/run/store.js";
import { bindAgentTaskRun, getAgentTask } from "../src/main/run/agent-task-store.js";
import { bindAgentExecutionLedger, getExecutionLedger, initializeExecutionLedger } from "../src/main/run/execution-ledger.js";
import { persistRunContract } from "../src/main/run/contract.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import { withRuntimeScope, type RuntimeScope } from "../src/main/run/runtime-scope.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";

// Controlled source-scope inputs. This does not test requirement extraction or a repair loop.
it.skipIf(!process.env.WORKBENCH_LMSTUDIO_FILE_SCOPE_PROBE)("assesses concrete file proposals with the actual 7B model without executing them",async()=>{
  const temporary=mkdtempSync(path.join(tmpdir(),"agent-file-scope-live-")),previous=dataRoot();
  const workspace=path.join(temporary,"workspace");mkdirSync(workspace);writeFileSync(path.join(workspace,"note.txt"),"saved source\n");
  setDataDir(temporary);initDb(path.join(temporary,"db.sqlite"));
  const endpoint=process.env.WORKBENCH_LMSTUDIO_PROBE_ENDPOINT ?? "http://127.0.0.1:1234";
  const gateway=new ModelGateway(undefined,[{id:"live-driver",runtime:"mlx-lm",baseUrl:`${endpoint.replace(/\/$/,"")}/v1`,model:"qwen2.5-coder-7b-instruct-mlx",capabilities:["text"],requestTimeoutMs:60000,healthPath:"/models",enabled:true,contextLength:8192,toolCallingFormat:"json"}]);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
  const cases=[{request:"Reproduce the failure, then repair note.txt by replacing source with content.",expected:true},{request:"Inspect note.txt and explain its content. Do not edit any file.",expected:false}];
  const reports:unknown[]=[];
  try {
    for(const item of cases){
      const chatId=createChat(),runId=createRun(chatId,item.request),messageId=addMessage({chat_id:chatId,role:"user",content:item.request}).id;
      getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(runId,workspace);
      const interpreted=parseTaskInterpretation(JSON.stringify({disposition:"continue",requirements:[{kind:"execute",description:item.request,source_id:"request",checks:[{description:item.request,kind:"review",operation:"semantic",path:null}]}],updates:[],full_suite:false}),messageId,item.request);
      const binding=bindAgentTaskRun({runId,chatId,messageId,workspace:{root:workspace,registeredAt:"file-scope-probe"},disposition:"continue",updates:interpreted.updates});
      const contract=persistRunContract({schemaVersion:1,runId,createdAt:new Date().toISOString(),objective:item.request,resolution:{status:"resolved"},routing:{intentType:"general_qa",taskType:"code",driverModel:"live-driver",actionable:true},response:{required:true,chatOnly:false},workspace:{requested:false,operations:[]},deliverables:[],constraints:{protectedPaths:[],restrictMutationsToTargets:false,userConstraints:[]},acceptance:{validateWrittenCode:false,validatedPythonDeliverables:[],artifactChecks:[]}});
      initializeExecutionLedger(contract);bindAgentExecutionLedger(binding);
      const context:ToolExecutionContext={runId,workspaceRoot:workspace,gateway,resultStore:new RunResultStore(runId),signal:controller.signal};
      const scope:RuntimeScope={runId,mode:"agent",agentPhase:"actions",signal:controller.signal};
      const reviewed=await withRuntimeScope(scope,async()=>{
        scope.agentCountingProfiles=await gateway.prepareAgentCountingProfiles("live-driver",{signal:controller.signal});
        const task=getAgentTask(binding.taskId)!;
        return assessAgentFileScope(task,task.snapshot.requirements[0].id,{id:randomUUID(),name:"edit_file",arguments:{path:"note.txt",replacements:[{old:"source",new:"content"}]}},context,"live-driver");
      });
      reports.push({...item,reviewed,admissions:getExecutionLedger(runId)?.agentAdmissions});
    }
    const proof={recordedAt:new Date().toISOString(),scope:"Read-only proposal-scope diagnostic. Controlled execute requirements; no extraction, source-edit validation, approvals, or repair execution tested.",model:"qwen2.5-coder-7b-instruct-mlx",contextLimit:8192,reports,sourceUnchanged:readFileSync(path.join(workspace,"note.txt"),"utf8") === "saved source\n"};
    if(process.env.WORKBENCH_AGENT_FILE_SCOPE_REPORT)writeFileSync(process.env.WORKBENCH_AGENT_FILE_SCOPE_REPORT,JSON.stringify(proof,null,2));
    expect(proof.sourceUnchanged).toBe(true);
    for(const report of reports as Array<{expected:boolean;reviewed:unknown}>)expect(report.reviewed).toMatchObject({verified:true,withinScope:report.expected});
  } finally {clearTimeout(timer);closeDb();setDataDir(previous);rmSync(temporary,{recursive:true,force:true});}
},130000);
