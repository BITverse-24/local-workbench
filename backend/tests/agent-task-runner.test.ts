import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commandExecutor from "../src/main/harness/tools/run-command.js";
import * as childProcesses from "../src/main/tools/child-process.js";
import { AgentTaskRunner } from "../src/main/agent/agent-task-runner.js";
import { selectAgentFailureStep } from "../src/main/agent/source-evidence.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { countLocalAgentRequest } from "../src/main/gateway/local-token-counter.js";
import * as server from "../src/main/gateway/lmstudio-token-counter.js";
import { saveAgentCountingVerification, verifyLocalAgentCounter } from "../src/main/gateway/agent-admission.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { createRun, transition } from "../src/main/run/store.js";
import { createRunDirectories, dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import { getCurrentAgentTask } from "../src/main/run/agent-task-store.js";
import { reconcileInterruptedExecutions, assertExecutionCanResume, updateExecutionLedgerState, getExecutionLedger } from "../src/main/run/execution-ledger.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";
import { buildExecutionEnvelope } from "../src/main/run/envelope.js";
import { parseTaskInterpretation } from "../src/main/agent/task-interpretation.js";
import { RunManager } from "../src/main/run/manager.js";
import { savedAgentTaskFacts } from "../src/main/agent/task-evidence.js";
import { readAgentInputBytes } from "../src/main/agent/workspace-actions.js";
import { recoverInterruptedModeRuns } from "../src/main/run/recovery.js";
import { createConfirmation } from "../src/main/confirmation/store.js";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
let root: string, previousRoot: string, chatId: string;
const template = "{% for m in messages %}{{m.role}} {{m.content}} EOS {% endfor %}assistant";
type Reply = (payload: any) => unknown;
let replies: Reply[];
let scopeReplies: Reply[];
let refinementReplies: Reply[];
let fileScopeReplies: Reply[];
let artifactScopeReplies: Reply[];
let artifactPartReplies: Reply[];
let runSignal:AbortSignal|undefined;
let runContextLimit=8192;
let explicitModuleDecisions=false;
beforeEach(() => { process.env.WORKBENCH_AGENT_EXEC = "off"; process.env.WORKBENCH_AGENT_ESCALATION = "off"; root = mkdtempSync(path.join(tmpdir(), "agent-runner-")); previousRoot = dataRoot(); setDataDir(root); initDb(path.join(root, "db.sqlite")); chatId = createChat(); replies = [];scopeReplies=[];refinementReplies=[];fileScopeReplies=[];artifactScopeReplies=[];artifactPartReplies=[];runSignal=undefined;runContextLimit=8192;explicitModuleDecisions=false;
  writeFileSync(path.join(root, "tokenizer.json"), JSON.stringify({ version: "1.0", added_tokens: [], normalizer: null, decoder: null, post_processor: null, pre_tokenizer: { type: "WhitespaceSplit" }, model: { type: "WordPiece", unk_token: "UNK", vocab: { UNK: 0, user: 1, EOS: 2, assistant: 3, Setup: 4 }, continuing_subword_prefix: "##", max_input_chars_per_word: 200000 } }));
  writeFileSync(path.join(root, "tokenizer_config.json"), JSON.stringify({ chat_template: template })); writeFileSync(path.join(root, "note.txt"), "saved source\n");
  vi.spyOn(server, "countLMStudioPreparedRequest").mockImplementation(async options => { const local = await countLocalAgentRequest({ assetsDir: root, activeTemplate: template, payload: options.payload }); return { inputTokens: local.inputTokens, renderedDigest: local.renderedDigest, instanceReference: "loaded", modelPath: "local", contextLimit: runContextLimit, counterIdentity: "lmstudio-sdk-1.5.0" }; });
});
afterEach(() => { delete process.env.WORKBENCH_AGENT_EXEC; delete process.env.WORKBENCH_AGENT_ESCALATION; delete process.env.WORKBENCH_DETERMINISTIC_FILE_SCOPE; vi.restoreAllMocks(); closeDb(); setDataDir(previousRoot); rmSync(root, { recursive: true, force: true }); });
function interpretation(kind: string, text: string) { return { disposition: "continue", requirements: [{ kind, description: text, source_id: "request", checks: [{ description: text, kind: "inspection", operation: "semantic", path: null }] }], updates: [], full_suite: false }; }
function packetState(content:string):any { return JSON.parse(content.split("\n\nOBSERVED SOURCE ")[0]); }
function observedSource(payload:any,filename:string,content:string) {
  const state=packetState(payload.messages[1].content);
  expect(state.selectedSources.pages).toContainEqual(expect.objectContaining({path:filename}));
  expect(state.selectedSources.pages.find((page:any)=>page.path === filename).content).toBeUndefined();
  expect(payload.messages[1].content).toContain(`<source>\n${content}\n</source>`);
}
async function run(text: string, managerPath = false, onApprove: (preview: string) => Promise<boolean> = async () => true, setupError?: string, workspaceRoot = root, registerArtifacts = false, inputFixture?:{id:string;filename:string;content:string}, intent?:"continue"|"new") {
  if (fileScopeReplies.length > 0) process.env.WORKBENCH_DETERMINISTIC_FILE_SCOPE = "off";
  else delete process.env.WORKBENCH_DETERMINISTIC_FILE_SCOPE;
  let runId = managerPath ? "" : createRun(chatId, text);
  const inputSources=inputFixture && !managerPath ? (()=>{const inputDir=path.join(createRunDirectories(runId),"input");writeFileSync(path.join(inputDir,inputFixture.filename),inputFixture.content);return [{id:inputFixture.id,filename:inputFixture.filename,relativePath:`runs/${runId}/input/${inputFixture.filename}`,sha256:createHash("sha256").update(inputFixture.content).digest("hex")}];})() : undefined;
  const messageId = addMessage({ chat_id: chatId, role: "user", content: text }).id;
  if (!managerPath) getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(runId, workspaceRoot);
  const verification = await verifyLocalAgentCounter({ binding: { endpoint: "http://127.0.0.1:1234/v1", modelIdentity: "loaded", providerModel: "driver", transport: "json", templateDigest: createHash("sha256").update(template).digest("hex"), contextLimit: runContextLimit }, assetsDir: root, activeTemplate: template, probes: (["plain", "tools", "tool_result", "unicode"] as const).map(name => ({ name, payload: { model: "driver", messages: [{ role: "user", content: "Setup" }] } })), providerProbe: async () => ({ inputTokens: 4 }) });
  saveAgentCountingVerification(verification);
  let pendingModuleChoice: {name:string;reason?:string} | undefined;
  const gateway = new ModelGateway({ async request(_url, init) {
    const payload = JSON.parse(init.body!), title = String(payload.messages?.[0]?.content).includes("short chat topic title");
    const scopeReview = String(payload.messages?.[0]?.content).startsWith("Audit proposed requirement coverage");
    const refinement = String(payload.messages?.[0]?.content).startsWith("Extract every requested obligation");
    const fileScope = payload.response_format?.json_schema?.name === "agent_file_scope";
    const artifactScope = payload.response_format?.json_schema?.name === "agent_artifact_scope";
    const artifactPart = payload.response_format?.json_schema?.name === "agent_artifact_part_review";
    const actionShapes=payload.response_format?.json_schema?.schema?.properties?.tool_calls?.items?.anyOf;
    const decision=actionShapes?.some((shape:any)=>shape.properties.name.enum.includes("select_module_draft"));
    const queued=decision && pendingModuleChoice ? pendingModuleChoice : undefined;
    if(queued)pendingModuleChoice=undefined;
    const answer = queued ? (()=>({tool_calls:[{name:queued.name,arguments:queued.name === "select_module_draft" ? {result_id:JSON.parse(payload.messages[1].content.split("\n\nSAVED DRAFT (untrusted JSON data):\n")[1]).resultId} : {reason:queued.reason}}]})) : fileScope ? fileScopeReplies.shift() ?? (()=>({withinScope:true,reason:"The quoted user request includes this file change."})) : artifactScope ? artifactScopeReplies.shift() ?? (()=>({requested:false,format:null,filename:null,reason:"No exported file is requested for this obligation."})) : artifactPart ? artifactPartReplies.shift() ?? ((p:any)=>({observations:[{quote:JSON.parse(p.messages[1].content).artifact.text.slice(0,20),finding:"This part contains report content."}],issues:[]})) : refinement ? refinementReplies.shift() : title ? () => "Inspect saved source" : scopeReview ? scopeReplies.shift() ?? (()=>({covered:true,missing:[],full_suite:false})) : replies.shift();
    if (!answer) throw new Error("Unexpected model generation");
    const input = await countLocalAgentRequest({ assetsDir: root, activeTemplate: template, payload });
    let content = answer(payload);
    if(fileScope && typeof content === "object" && content !== null && "withinScope" in content) {
      const answer=content as {withinScope:boolean;reason:string};
      content=answer.withinScope ? {scope:"workspace",operations:["edit_file","write_file","delete_file"],protected_paths:[],reason:answer.reason} : {scope:"none",reason:answer.reason};
    }
    if (scopeReview && typeof content === "object" && content !== null && "covered" in content) {
      const input=packetState(payload.messages[1].content),review=content as any;
      const refs=[...(input.requirements || []).flatMap((item:any)=>(item.checks || []).map((check:any)=>check.ref)),...(input.scopeUpdates || []).map((item:any)=>item.ref)];
      content={obligations:review.covered && !review.missing.length ? refs.length ? [{description:input.source.text.slice(0,1000),check_refs:refs}] : [] : (review.missing.length ? review.missing : ["Uncovered obligation"]).map((description:string)=>({description,check_refs:[]})),full_suite:review.full_suite};
    }
    if (String(payload.messages?.[0]?.content).startsWith("The host has verified the saved repair") && typeof content === "object" && content !== null && (content as any).tool_calls?.[0]?.name === "finish") content = (content as any).tool_calls[0].arguments.text;
    const shapes=payload.response_format?.json_schema?.schema?.properties?.tool_calls?.items?.anyOf;
    const directProposal=payload.response_format?.json_schema?.name === "agent_tool_arguments";
    const moduleProposal=Boolean(directProposal && payload.response_format?.json_schema?.schema?.properties?.content);
    const proposalName=moduleProposal ? "propose_module_repair" : "propose_repair";
    if((directProposal || shapes?.length === 1 && shapes[0].properties.name.enum[0] === "propose_repair") && typeof content === "object" && content !== null){
      const calls=(content as any).tool_calls;
      if(calls?.length === 1 && calls[0].name !== "propose_repair") {
        const {name,arguments:args}=calls[0];
        const current=moduleProposal ? readFileSync(path.join(workspaceRoot,packetState(payload.messages[1].content).currentStep.target.path),"utf8") : "";
        const proposal=name === "edit_file" ? moduleProposal ? {content:args.replacements.reduce((text:string,item:any)=>text.replace(item.old,item.new),current)} : {kind:"edit",replacements:args.replacements.map((item:any)=>({old:item.old.split("\n"),new:item.new.split("\n")}))} :
          name === "read_file" ? {kind:"source",...args,reason:"Obtain missing source"} : name === "request_capability" ? {kind:"tools",...args,reason:args.reason ?? "Show needed tools"} : name === "finish" ? {kind:"blocked",reason:args.text} : undefined;
        if(proposal)content={tool_calls:[{name:proposalName,arguments:proposal}]};
      }
      if(directProposal && (content as any).tool_calls?.length === 1 && ["propose_repair","propose_module_repair"].includes((content as any).tool_calls[0].name)){
        const args=(content as any).tool_calls[0].arguments;
        content=moduleProposal && ["source","tools","blocked"].includes(args.kind) ? args.kind === "blocked" ? {content:null,blocked_reason:args.reason} : {content:null,context_needed:args.reason} : args;
      }
    }
    if(moduleProposal && typeof content === "object" && content !== null && (content as any).tool_calls?.[0]?.name === "draft_module")content=(content as any).tool_calls[0].arguments;
    if(moduleProposal && typeof content === "object" && content !== null && "content" in content) {
      const draft=content as {content:string|null;context_needed?:string;blocked_reason?:string};
      if(draft.content === null && (draft.context_needed || draft.blocked_reason)) {
        pendingModuleChoice={name:draft.context_needed ? "request_module_context" : "block_module_repair",reason:draft.context_needed ?? draft.blocked_reason};
        content={content:readFileSync(path.join(workspaceRoot,packetState(payload.messages[1].content).currentStep.target.path),"utf8")};
      } else if(typeof draft.content === "string" && !explicitModuleDecisions) pendingModuleChoice={name:"select_module_draft"};
    }
    if(decision && typeof content === "object" && content !== null && (content as any).tool_calls?.[0]?.name === "propose_module_repair") {
      const args=(content as any).tool_calls[0].arguments;
      if(args.context_needed || args.blocked_reason)content={tool_calls:[{name:args.context_needed ? "request_module_context" : "block_module_repair",arguments:{reason:args.context_needed ?? args.blocked_reason}}]};
    }
    return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: input.inputTokens, completion_tokens: 30 } }) };
  } }, [{ id: "driver", runtime: "mlx-lm", baseUrl: "http://127.0.0.1:1234/v1", model: "driver", capabilities: ["text"], toolCallingFormat: "json", requestTimeoutMs: 1000, healthPath: "/models", enabled: true, contextLength: 8192 }]);
  vi.spyOn(gateway, "prepareAgentCountingProfiles").mockImplementation(async()=>{if(setupError)throw new Error(setupError);return [{assetsDir:root,activeTemplate:template,verification}];});
  const approve = vi.fn(onApprove), emit = vi.fn((event:any)=>{
    if(registerArtifacts && event.type === "artifact_ready") {
      const artifact=event.artifact, file=path.join(root,artifact.relativePath), digest=createHash("sha256").update(readFileSync(file)).digest("hex");
      getDb().prepare("INSERT INTO artifacts(artifact_id,run_id,kind,filename,relative_path,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)").run(artifact.artifactId,artifact.runId,artifact.kind,artifact.filename,artifact.relativePath,artifact.sizeBytes,digest,artifact.createdAt);
    }
  });
  if (managerPath) {
    const manager = new RunManager(gateway, emit, undefined, { agentV3Preview: true });
    const harness = new HarnessManager(); harness.registerWorkspace(workspaceRoot); manager.setHarness(harness);
    const started = await manager.start({ chatId, userMessageId: messageId, userText: text, mode: "agent", selectedModel: "driver" }); runId = started.runId;
    await vi.waitFor(() => expect(["completed", "partial", "failed", "cancelled"]).toContain(manager.getRunSnapshot({ runId })?.state), { timeout: 10000 });
    const snapshot = manager.getRunSnapshot({ runId })!;
    const answer = getDb().prepare("SELECT content FROM messages WHERE run_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(runId) as { content: string };
    return { result: { outcome: snapshot.state, stopReason: getExecutionLedger(runId)?.agentProgress?.stopReason, text: answer.content }, runId, approve, emit, snapshot, manager };
  }
  const result = await withRuntimeScope({ runId, mode: "agent", signal: runSignal ?? new AbortController().signal }, () => new AgentTaskRunner().run({ modelId: "driver", chatId, messageId, intent, workspace: { root: workspaceRoot, registeredAt: "first" }, approve, state: state => { if (getDb().prepare("SELECT state FROM runs WHERE id=?").get(runId)) transition(runId, state); }, context: { runId, workspaceRoot, gateway, inputSources, resultStore: new RunResultStore(runId), policyGuard: new MutationPolicyGuard(), envelope: buildExecutionEnvelope({ runId, mode: "agent", modelId: "driver", hasWorkspace: true, workspaceRoot }), emitRunEvent: emit } }));
  transition(runId, result.outcome === "completed" ? "completed" : result.outcome === "cancelled" ? "cancelled" : "partial");
  return { result, runId, approve, emit, manager: undefined };
}
function failingWorkspace() {
  const workspace=path.join(root,"project");mkdirSync(workspace);
  const implementation='exports.readValue = () => { throw new Error("baseline failure"); };\n';
  writeFileSync(path.join(workspace,"package.json"),JSON.stringify({scripts:{test:"node --test"}}));
  writeFileSync(path.join(workspace,"value.cjs"),implementation);
  writeFileSync(path.join(workspace,"value.test.cjs"),'const {test}=require("node:test");const {readValue}=require("./value.cjs");test("existing failure",()=>readValue());\n');
  return {workspace,implementation};
}
describe("Agent v3 task host loop", () => {
  it.each(["current","changed"] as const)("reads a staged input by ID and verifies an exact exported copy: %s",async mode=>{
    const input={id:"11111111-1111-4111-8111-111111111111",filename:"attached.txt",content:"Attached café\r\n"};
    const text="Read attached.txt and export its exact content as copy.txt.";
    artifactScopeReplies=[()=>({requested:true,format:"txt",filename:"copy.txt",reason:"The instruction requests an exported copy."})];
    replies=[()=>({disposition:"continue",requirements:[{kind:"deliver",description:text,source_id:"request",checks:[{description:"Export exact source",kind:"delivery",operation:"verbatim_source",path:"attached.txt"}]}],updates:[],full_suite:false}),
      payload=>{expect(packetState(payload.messages[1].content).stagedInputs).toContainEqual(expect.objectContaining({sourceId:input.id,filename:input.filename}));return {tool_calls:[{name:"read_input",arguments:{source_id:input.id}}]};},
      ()=>({tool_calls:[{name:"request_capability",arguments:{capability:"artifact_generation",reason:"Export the copy"}}]}),
      ()=>({tool_calls:[{name:"generate_deliverable",arguments:{type:"txt",filename:"copy.txt",content:input.content}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The copy is saved."}}]}),
      payload=>{const state=packetState(payload.messages[1].content);expect(state.hostVerifiedChecks).toContainEqual(expect.objectContaining({passed:true,matchForm:"artifact_bytes"}));if(mode==="changed")writeFileSync(path.join(root,"runs",getCurrentAgentTask(chatId)!.latestRunId!,"input",input.filename),"changed");return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The saved bytes match the staged input."}))};},
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The copy is saved."}}]})];
    const {result,approve}=await run(text,false,async()=>true,undefined,root,true,input);
    expect(result.outcome,result.text).toBe(mode==="current"?"completed":"partial");expect(approve).toHaveBeenCalledOnce();
  });
  it.each(["current","changed","conflict"] as const)("carries a task input into a later attempt: %s",async mode=>{
    const input={id:"11111111-1111-4111-8111-111111111111",filename:"attached.txt",content:"Task input\r\n"};
    const text="Read attached.txt and export its exact content as copy.txt.";
    const parsed=()=>({disposition:"continue",requirements:[{kind:"deliver",description:text,source_id:"request",checks:[{description:"Export exact source",kind:"delivery",operation:"verbatim_source",path:"attached.txt"}]}],updates:[],full_suite:false});
    artifactScopeReplies=[()=>({requested:true,format:"txt",filename:"copy.txt",reason:"The instruction requests a copy."})];
    replies=[parsed,()=>({tool_calls:[{name:"read_input",arguments:{source_id:input.id}}]}),()=>({tool_calls:[{name:"finish",arguments:{text:"Pending."}}]}),()=>({tool_calls:[{name:"finish",arguments:{text:"Pending."}}]})];
    const first=await run(text,false,async()=>true,undefined,root,true,input);
    expect(first.result.outcome).toBe("partial");
    const alias={...input,relativePath:`runs/${first.runId}/input/${input.filename}`,sha256:createHash("sha256").update(input.content).digest("hex")};
    getDb().prepare("UPDATE run_mode_details SET metrics_json=? WHERE run_id=?").run(JSON.stringify({sourceAliases:[alias]}),first.runId);
    if(mode==="changed")writeFileSync(path.join(root,alias.relativePath),"changed input");
    artifactScopeReplies=[()=>({requested:true,format:"txt",filename:"copy.txt",reason:"The task requests a copy."})];
    replies=[()=>({disposition:"evidence",requirements:[],updates:[],full_suite:false}),
      payload=>{expect(packetState(payload.messages[1].content).stagedInputs).toContainEqual(expect.objectContaining({sourceId:input.id}));return {tool_calls:[{name:"read_input",arguments:{source_id:input.id}}]};},
      ()=>({tool_calls:[{name:"request_capability",arguments:{capability:"artifact_generation",reason:"Export the copy"}}]}),
      ()=>({tool_calls:[{name:"generate_deliverable",arguments:{type:"txt",filename:"copy.txt",content:input.content}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"Copy saved."}}]}),
      ...(mode==="current" ? [(payload:any)=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Current input was copied."}))};}] : [()=>({tool_calls:[{name:"finish",arguments:{text:"Copy saved."}}]})])];
    const second=await run("Continue",false,async()=>true,undefined,root,true,mode==="conflict"?{...input,content:"conflicting bytes"}:undefined);
    expect(second.result.outcome,second.result.text).toBe(mode==="current"?"completed":"partial");
    if(mode==="conflict"){expect(second.result.text).toContain("conflicting saved revisions");expect(second.approve).not.toHaveBeenCalled();}
  });
  it("does not carry task inputs into an explicitly new task",async()=>{
    const input={id:"11111111-1111-4111-8111-111111111111",filename:"attached.txt",content:"Earlier input\n"}, text="Read attached.txt.";
    replies=[()=>interpretation("inspect",text),()=>({tool_calls:[{name:"read_input",arguments:{source_id:input.id}}]}),()=>({tool_calls:[{name:"finish",arguments:{text:"Input inspected."}}]}),payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The input was inspected."}))};}];
    const first=await run(text,false,async()=>true,undefined,root,false,input);
    expect(first.result.outcome,first.result.text).toBe("completed");
    getDb().prepare("UPDATE run_mode_details SET metrics_json=? WHERE run_id=?").run(JSON.stringify({sourceAliases:[{id:input.id,filename:input.filename,relativePath:`runs/${first.runId}/input/${input.filename}`,sha256:createHash("sha256").update(input.content).digest("hex")}]}),first.runId);
    const next="Explain this new objective.";
    replies=[()=>interpretation("deliver",next),payload=>{expect(packetState(payload.messages[1].content).stagedInputs).toEqual([]);return {tool_calls:[{name:"finish",arguments:{text:"A new objective."}}]};},payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The explanation was delivered."}))};}];
    const second=await run(next,false,async()=>true,undefined,root,false,undefined,"new");
    expect(second.result.outcome,second.result.text).toBe("completed");
    expect(()=>readAgentInputBytes({runId:second.runId,workspaceRoot:root,gateway:{} as any,inputSources:[{id:input.id,filename:input.filename,relativePath:`runs/${first.runId}/input/${input.filename}`,sha256:createHash("sha256").update(input.content).digest("hex"),originRunId:first.runId}]},input.id)).toThrow("outside this task");
  });
  it("restores staged task inputs through the RunManager on a follow-up",async()=>{
    const setup="Explain the setup.";
    replies=[()=>interpretation("deliver",setup),()=>({tool_calls:[{name:"finish",arguments:{text:"Ready."}}]}),payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Delivered."}))};}];
    const initial=await run(setup,true), manager=initial.manager!, input=Buffer.from("Manager staged input\n");
    const attachment=manager.registerAttachment({chatId,filename:"attached.txt",mediaType:"text/plain",sizeBytes:input.length,base64OrBuffer:input});
    const firstText="Inspect attached.txt.", firstMessage=addMessage({chat_id:chatId,role:"user",content:firstText}).id;
    replies=[()=>interpretation("inspect",firstText),()=>({tool_calls:[{name:"read_input",arguments:{source_id:attachment.attachment.attachmentId}}]}),()=>({tool_calls:[{name:"finish",arguments:{text:"Inspected."}}]}),payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Input inspected."}))};}];
    const first=await manager.start({chatId,userMessageId:firstMessage,userText:firstText,mode:"agent",selectedModel:"driver",agentTaskIntent:"new",attachmentToken:attachment.attachment.attachmentId});
    await vi.waitFor(()=>expect(manager.getRunSnapshot({runId:first.runId})?.state).toBe("completed"),{timeout:10000});
    const nextText="Inspect the same input again.", nextMessage=addMessage({chat_id:chatId,role:"user",content:nextText}).id;
    replies=[()=>interpretation("inspect",nextText),payload=>{expect(packetState(payload.messages[1].content).stagedInputs).toContainEqual(expect.objectContaining({sourceId:attachment.attachment.attachmentId,historical:true}));return {tool_calls:[{name:"read_input",arguments:{source_id:attachment.attachment.attachmentId}}]};},()=>({tool_calls:[{name:"finish",arguments:{text:"Inspected again."}}]}),...Array.from({length:2},()=>(payload:any)=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Input inspected."}))};})];
    const second=await manager.start({chatId,userMessageId:nextMessage,userText:nextText,mode:"agent",selectedModel:"driver"});
    await vi.waitFor(()=>expect(["completed","partial","failed","cancelled"]).toContain(manager.getRunSnapshot({runId:second.runId})?.state),{timeout:10000});
    const response=getDb().prepare("SELECT content FROM messages WHERE run_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(second.runId) as {content:string}|undefined;
    expect(manager.getRunSnapshot({runId:second.runId})?.state,response?.content).toBe("completed");
    const freshText="Explain a separate objective.", freshMessage=addMessage({chat_id:chatId,role:"user",content:freshText}).id;
    replies=[()=>interpretation("deliver",freshText),payload=>{expect(packetState(payload.messages[1].content).stagedInputs).toEqual([]);return {tool_calls:[{name:"finish",arguments:{text:"Separate objective."}}]};},payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Delivered."}))};}];
    const fresh=await manager.start({chatId,userMessageId:freshMessage,userText:freshText,mode:"agent",selectedModel:"driver",agentTaskIntent:"new"});
    await vi.waitFor(()=>expect(["completed","partial","failed","cancelled"]).toContain(manager.getRunSnapshot({runId:fresh.runId})?.state),{timeout:10000});
    const freshResponse=getDb().prepare("SELECT content FROM messages WHERE run_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(fresh.runId) as {content:string}|undefined;
    expect(manager.getRunSnapshot({runId:fresh.runId})?.state,freshResponse?.content).toBe("completed");
  });
  it("does not claim an attached code repair is verified from an exported file alone",async()=>{
    const input={id:"11111111-1111-4111-8111-111111111111",filename:"attached.py",content:"def value():\n    return 0\n"};
    const text="Repair attached.py and export repaired.py.";
    artifactScopeReplies=[()=>({requested:true,format:"file",filename:"repaired.py",reason:"The instruction requests an exported repair."})];
    replies=[()=>interpretation("change",text),
      ()=>({tool_calls:[{name:"read_input",arguments:{source_id:input.id}}]}),
      ()=>({tool_calls:[{name:"request_capability",arguments:{capability:"artifact_generation",reason:"Export the repair"}}]}),
      ()=>({tool_calls:[{name:"generate_deliverable",arguments:{type:"file",filename:"repaired.py",content:"def value():\n    return 1\n"}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The repair is saved."}}]}),
      payload=>{expect(packetState(payload.messages[1].content).feedback.text).toContain("artifact-specific execution evidence");return {tool_calls:[{name:"finish",arguments:{text:"The repair is saved."}}]};}];
    const {result,approve}=await run(text,false,async()=>true,undefined,root,true,input);
    expect(result.outcome).toBe("partial");expect(approve).toHaveBeenCalledOnce();
  });
  it.each(["current","changed"] as const)("tests an approved exported repair in the project copy: %s",async mode=>{
    const workspace=path.join(root,"project");mkdirSync(workspace);
    const input={id:"11111111-1111-4111-8111-111111111111",filename:"value.js",content:"module.exports = 1;\n"};
    writeFileSync(path.join(workspace,"package.json"),JSON.stringify({scripts:{test:"node --test"}}));
    writeFileSync(path.join(workspace,"value.js"),input.content);
    writeFileSync(path.join(workspace,"value.test.js"),"const {test}=require('node:test');const assert=require('node:assert/strict');test('value',()=>assert.ok(require('./value.js')>0));\n");
    const originalExecutor=childProcesses.executeProcess, tested:string[]=[];
    vi.spyOn(childProcesses,"executeProcess").mockImplementation(async(binary,args,options)=>{
      if(options.env?.WORKBENCH_TEST_REPORT && options.cwd) tested.push(readFileSync(path.join(options.cwd,"value.js"),"utf8"));
      return originalExecutor(binary,args,options);
    });
    const text="Repair attached value.js, export repaired.js, and run the full test suite.";
    artifactScopeReplies=[()=>({requested:true,format:"file",filename:"repaired.js",reason:"The instruction requests an exported repair."})];
    replies=[()=>({disposition:"continue",requirements:[{kind:"change",description:text,source_id:"request",checks:[{description:"Repair and export the file",kind:"review",operation:"semantic",path:null}]},{kind:"execute",description:"Run the full test suite on the repair",source_id:"request",checks:[{description:"Full test suite passes",kind:"execution",operation:"semantic",path:null}]}],updates:[],full_suite:true}),
      ()=>({tool_calls:[{name:"read_input",arguments:{source_id:input.id}}]}),
      ()=>({tool_calls:[{name:"request_capability",arguments:{capability:"artifact_generation",reason:"Export the repair"}}]}),
      ()=>({tool_calls:[{name:"generate_deliverable",arguments:{type:"file",filename:"repaired.js",content:"module.exports = 2;\n"}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The repair is saved."}}]}),
      ...Array.from({length:2},()=> (payload:any)=>{const state=packetState(payload.messages[1].content);if(mode === "changed")writeFileSync(path.join(root,"runs",getCurrentAgentTask(chatId)!.latestRunId!,"input",input.filename),"changed");return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The exported repair and test evidence are saved."}))};}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The repair is saved."}}]})];
    const {result,runId,approve}=await run(text,false,async()=>true,undefined,workspace,true,input);
    expect(result.outcome,result.text).toBe(mode === "current" ? "completed" : "partial");
    expect(readFileSync(path.join(workspace,"value.js"),"utf8")).toBe(input.content);
    expect(tested).toContain("module.exports = 2;\n");
    expect(approve.mock.calls.some(([preview])=>preview.includes('"testArtifact"'))).toBe(true);
    expect(getExecutionLedger(runId)?.verification?.evidence.some(check=>check.criterionId.startsWith("acceptance:validate-export:") && check.status === "passed")).toBe(true);
  });
  it("does not complete a requested file from an answer alone",async()=>{
    const text="Create a downloadable report.md with the project summary.";
    artifactScopeReplies=[()=>({requested:true,format:"md",filename:"report.md",reason:"The instruction requests this file."})];
    replies=[()=>interpretation("deliver",text),()=>({tool_calls:[{name:"finish",arguments:{text:"The report is ready."}}]}),payload=>{
      expect(packetState(payload.messages[1].content).feedback.text).toContain("has no current saved artifact");
      return {tool_calls:[{name:"finish",arguments:{text:"The report is ready."}}]};
    }];
    const {result,runId,approve}=await run(text);
    expect(result.outcome).toBe("partial");expect(result.stopReason).toBe("repeated_action");expect(approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(runId)?.agentProgress?.artifactScopes).toHaveLength(1);
    expect(existsSync(path.join(root,"runs",runId,"output","report.md"))).toBe(false);
  });
  it("completes a requested file only after approved creation and saved-content review",async()=>{
    const text="Create a downloadable report.md with the project summary.";
    artifactScopeReplies=[()=>({requested:true,format:"md",filename:"report.md",reason:"The instruction requests this file."})];
    replies=[()=>interpretation("deliver",text),
      ()=>({tool_calls:[{name:"request_capability",arguments:{capability:"artifact_generation",reason:"Create the requested report"}}]}),
      ()=>({tool_calls:[{name:"generate_deliverable",arguments:{type:"md",filename:"report.md",content:"# Project summary\n\nA complete project report."}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The report is saved."}}]}),
      payload=>{const state=packetState(payload.messages[1].content);expect(state.artifactEvidence.items[0]).toMatchObject({filename:"report.md",completeText:true});return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The saved report contains the requested summary."}))};}];
    const {result,approve}=await run(text,false,async()=>true,undefined,root,true);
    expect(result.outcome).toBe("completed");expect(approve).toHaveBeenCalledOnce();
  });
  it("reviews a large artifact in contiguous parts before completion",async()=>{
    const text="Create a downloadable report.md with the project summary.";
    artifactScopeReplies=[()=>({requested:true,format:"md",filename:"report.md",reason:"The instruction requests this file."})];
    replies=[()=>interpretation("deliver",text),
      ()=>({tool_calls:[{name:"request_capability",arguments:{capability:"artifact_generation",reason:"Create the report"}}]}),
      ()=>({tool_calls:[{name:"generate_deliverable",arguments:{type:"md",filename:"report.md",content:"# Report\n\n"+"content ".repeat(250)}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The report is saved."}}]}),
      payload=>{const state=packetState(payload.messages[1].content);expect(state.artifactEvidence.items[0].partReview).toMatchObject({completeCoverage:true,parts:2});return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The reviewed parts cover the report."}))};}];
    const {result,runId}=await run(text,false,async()=>true,undefined,root,true);
    expect(result.outcome,result.text).toBe("completed");
    const records=new RunResultStore(runId).listResults({limit:50}).filter(item=>item.producer.tool==="agent_artifact_part_review");
    expect(records).toHaveLength(2);
    const parts=records.map(item=>JSON.parse(new RunResultStore(runId).readResultPayload(item.resultId))).sort((a,b)=>a.start-b.start);
    expect(parts[0].start).toBe(0);expect(parts[0].end).toBe(parts[1].start);expect(parts[1].end).toBe(parts[1].total);
  });
  it.each(["forged", "changed", "issue"] as const)("keeps a large artifact unverified when part review is %s",async mode=>{
    const text="Create a downloadable report.md with the project summary.";
    artifactScopeReplies=[()=>({requested:true,format:"md",filename:"report.md",reason:"The instruction requests this file."})];
    artifactPartReplies=[payload=>{
      if(mode==="changed")writeFileSync(path.join(root,"runs",getCurrentAgentTask(chatId)!.latestRunId!,"output","report.md"),"external change");
      const part=JSON.parse(payload.messages[1].content).artifact.text;
      return {observations:[{quote:mode==="forged"?"fabricated quotation":part.slice(0,20),finding:"Report content"}],issues:mode==="issue"?["A visible defect"]:[]};
    }];
    replies=[()=>interpretation("deliver",text),
      ()=>({tool_calls:[{name:"request_capability",arguments:{capability:"artifact_generation",reason:"Create the report"}}]}),
      ()=>({tool_calls:[{name:"generate_deliverable",arguments:{type:"md",filename:"report.md",content:"# Report\n\n"+"content ".repeat(250)}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The report is saved."}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The report is saved."}}]})];
    const {result}=await run(text,false,async()=>true,undefined,root,true);
    expect(result.outcome).toBe("partial");
  });
  it.each(["exact", "unicode_crlf", "mismatch", "source_changed", "artifact_changed"] as const)("checks exported bytes against observed source: %s",async mode=>{
    const text="Read note.txt and export its exact content as note-copy.txt.";
    const source=mode==="unicode_crlf"?"café\r\nnext\r\n":"saved source\n";
    writeFileSync(path.join(root,"note.txt"),source);
    artifactScopeReplies=[()=>({requested:true,format:"txt",filename:"note-copy.txt",reason:"The instruction requests an exported copy."})];
    replies=[()=>({disposition:"continue",requirements:[{kind:"deliver",description:text,source_id:"request",checks:[{description:"Export exact source",kind:"delivery",operation:"verbatim_source",path:"note.txt"}]}],updates:[],full_suite:false}),
      ()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),()=>"saved source\n",
      ()=>({tool_calls:[{name:"request_capability",arguments:{capability:"artifact_generation",reason:"Export the requested copy"}}]}),
      ()=>({tool_calls:[{name:"generate_deliverable",arguments:{type:"txt",filename:"note-copy.txt",content:mode==="mismatch"?"different bytes":source}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"saved source\n"}}]}),
      payload=>{
        if(mode==="mismatch"){expect(packetState(payload.messages[1].content).feedback.text).toContain("does not match");return {tool_calls:[{name:"finish",arguments:{text:"saved source\n"}}]};}
        if(mode==="source_changed")writeFileSync(path.join(root,"note.txt"),"external change");
        if(mode==="artifact_changed")writeFileSync(path.join(root,"runs",getCurrentAgentTask(chatId)!.latestRunId!,"output","note-copy.txt"),"external change");
        const state=packetState(payload.messages[1].content);expect(state.hostVerifiedChecks).toContainEqual(expect.objectContaining({passed:true,matchForm:"artifact_bytes"}));return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Exact copy reviewed."}))};
      },()=>({tool_calls:[{name:"finish",arguments:{text:"saved source\n"}}]})];
    const {result}=await run(text,false,async()=>true,undefined,root,true);
    expect(result.outcome,result.text).toBe(["exact","unicode_crlf"].includes(mode)?"completed":"partial");
  });
  it.each(["unrequested", "invented", "mismatch", "denied", "stale", "approved"] as const)("binds document generation to task scope and concrete approval: %s",async mode=>{
    const text="Create a downloadable report.md with the project summary.";
    artifactScopeReplies=[()=>({requested:mode!=="unrequested",format:mode==="unrequested"?null:"md",filename:mode==="unrequested"?null:mode==="invented"?"invented.md":"report.md",reason:"The saved instruction determines the output."})];
    replies=[()=>interpretation("deliver",text),
      ()=>({tool_calls:[{name:"request_capability",arguments:{capability:"artifact_generation",reason:"Create the requested report"}}]}),
      ()=>({tool_calls:[{name:"generate_deliverable",arguments:{type:"md",filename:mode==="mismatch"?"other.md":"report.md",content:"# Project summary\n\nA complete project report."}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The report is saved."}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The report is saved."}}]})];
    const {result,runId,approve}=await run(text,false,async()=>{if(mode==="stale")getDb().prepare("UPDATE agent_tasks SET is_current=0 WHERE chat_id=?").run(chatId);return mode!=="denied";});
    const output=path.join(root,"runs",runId,"output","report.md");
    expect(existsSync(output)).toBe(mode==="approved");
    expect(approve).toHaveBeenCalledTimes(["unrequested","invented","mismatch"].includes(mode) ? 0 : 1);
    if(["unrequested","invented","mismatch"].includes(mode))expect(result.stopReason).toBe("artifact_scope_unverified");
    if(mode==="denied")expect(result.outcome).toBe("cancelled");
    if(mode==="approved")expect(readFileSync(output,"utf8")).toContain("complete project report");
  });
  it("honors cancellation at generation return before binding an execution attempt",async()=>{
    const controller=new AbortController();runSignal=controller.signal;
    replies=[()=>{controller.abort();return interpretation("change","Repair note.txt");}];
    const {result,runId,approve}=await run("Repair note.txt");
    expect(result.outcome).toBe("cancelled");expect(result.stopReason).toBe("cancelled");expect(approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(1);
    expect(getExecutionLedger(runId)?.agentProgress?.actions).toEqual([]);
    expect(getCurrentAgentTask(chatId)?.snapshot.messages[0].disposition).toBe("pending");
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it("revises omitted repair obligations after a separate pre-action scope review",async()=>{
    const request="Inspect note.txt, repair its source wording, run the full test suite, and explain the fix.";
    scopeReplies=[payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.source.text).toBe(request);
      expect(input.requirements.map((item:any)=>item.kind)).toEqual(["execute"]);
      expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
      return {covered:false,missing:["Inspection, file repair, and explanation must be separate requirements."],full_suite:true};
    },payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.requirements.map((item:any)=>item.kind)).toEqual(["execute","inspect","change","execute","deliver"]);
      return {covered:true,missing:[],full_suite:true};
    }];
    refinementReplies=[payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.source.text).toBe(request);expect(input.source.sourceId).toBe("s1");
      expect(input.missing).toContain("separate requirements");
      return {requirements:["inspect","change","execute","deliver"].map(kind=>({kind,description:kind,check:{operation:"semantic",path:null}})),full_suite:true};
    }];
    replies=[()=>interpretation("execute",request),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),
    ()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]}),
    ()=>({tool_calls:[{name:"finish",arguments:{text:"The wording edit is saved. The full test suite remains unavailable."}}]})];
    const {result,runId,approve}=await run(request);
    expect(result.stopReason,result.text).toBe("checks_unavailable");expect(approve).toHaveBeenCalledTimes(1);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements.map(item=>item.kind)).toEqual(["execute","inspect","change","execute","deliver"]);
    expect(getExecutionLedger(runId)?.agentProgress).toMatchObject({scopeCorrectionUsed:true,fullSuite:true});
    expect(getExecutionLedger(runId)?.agentTask?.protocolCorrections).toBe(0);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeLessThanOrEqual(8);
  });
  it("keeps the full request pending when independent scope assessment still rejects its one revision",async()=>{
    const request="Inspect and repair note.txt, then run all tests.";
    scopeReplies=[()=>({covered:false,missing:["Repair obligation is absent."],full_suite:true}),()=>({covered:false,missing:["Repair obligation is still absent."],full_suite:true})];
    replies=[()=>({disposition:"status",requirements:[],updates:[],full_suite:false})];
    refinementReplies=[()=>({requirements:[],full_suite:false})];
    const {result,runId,approve,emit}=await run(request);
    expect(result.stopReason).toBe("requirement_coverage_unverified");expect(approve).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([event])=>event.type === "tool_call")).toBe(false);
    expect(getCurrentAgentTask(chatId)?.snapshot.messages[0]).toMatchObject({content:request,disposition:"pending"});
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(4);
    expect(getExecutionLedger(runId)?.agentTask?.taskRevision).toBeUndefined();
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it("cancels a bounded scope revision before binding authority or starting workspace actions",async()=>{
    const controller=new AbortController();runSignal=controller.signal;
    const request="Inspect and repair note.txt.";
    replies=[()=>interpretation("inspect",request)];
    scopeReplies=[()=>({covered:false,missing:["Repair obligation is absent."],full_suite:false})];
    refinementReplies=[()=>{controller.abort();return {requirements:[],full_suite:false};}];
    const {result,runId,approve,emit}=await run(request);
    expect(result.outcome).toBe("cancelled");expect(approve).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([event])=>event.type === "tool_call")).toBe(false);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(3);
    expect(getCurrentAgentTask(chatId)?.snapshot.messages[0]).toMatchObject({content:request,disposition:"pending"});
    expect(getExecutionLedger(runId)?.agentProgress?.scopeCorrectionUsed).toBe(true);
  });
  it("binds a missing explanation to its exact source while preserving the earlier repair obligation",async()=>{
    const request="Repair note.txt. Explain the change.";
    scopeReplies=[()=>({covered:true,missing:[],full_suite:false}),payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.source).toMatchObject({sourceId:"s2",text:" Explain the change."});
      expect(input.originalMessages).toBeUndefined();expect(input.proposedUpdates).toBeUndefined();
      return {covered:false,missing:["A delivery requirement for the explanation is missing."],full_suite:false};
    },()=>({covered:true,missing:[],full_suite:false}),payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.requirements.map((item:any)=>item.kind)).toEqual(["change","deliver"]);
      return {covered:true,missing:[],full_suite:false};
    }];
    refinementReplies=[payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.source).toMatchObject({sourceId:"s2",text:" Explain the change."});
      expect(input.contextBefore).toBeUndefined();
      expect(input.missing).toContain("delivery requirement");
      return {requirements:[{kind:"deliver",description:"Explain the saved change",check:{operation:"semantic",path:null}}],full_suite:false};
    }];
    replies=[()=>interpretation("change",request),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),
      ()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The wording is corrected by the saved source-to-content replacement."}}]}),
      ...Array.from({length:2},()=>(payload:any)=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The saved text edit and explanation meet the request."}))};})];
    const {result,runId,approve}=await run(request);
    expect(result.outcome,result.text).toBe("completed");expect(approve).toHaveBeenCalledTimes(1);
    const requirements=getCurrentAgentTask(chatId)!.snapshot.requirements;
    expect(requirements.map(item=>item.kind)).toEqual(["change","deliver"]);
    expect(requirements[0].source.quote).toBe(request);
    expect(requirements[1].source.quote).toBe(" Explain the change.");
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeLessThanOrEqual(16);
  });
  it("shares the 40-call limit with source scope review and leaves the full request pending",async()=>{
    process.env.WORKBENCH_AGENT_CALL_BUDGETS = "off";
    const request=Array.from({length:45},(_,index)=>`Inspect source ${index}.`).join(" ");
    replies=[()=>interpretation("inspect",request)];
    const {result,runId,approve,emit}=await run(request);
    delete process.env.WORKBENCH_AGENT_CALL_BUDGETS;
    expect(result.stopReason,result.text).toBe("model_call_limit");expect(approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(40);
    expect(getExecutionLedger(runId)?.agentAdmissions).toHaveLength(40);
    expect(emit.mock.calls.some(([event])=>event.type === "tool_call")).toBe(false);
    expect(getCurrentAgentTask(chatId)?.snapshot.messages[0]).toMatchObject({content:request,disposition:"pending"});
  });
  it("retains an unparsed original through setup failure and interprets it on a later continuation", async () => {
    const original = "Repair note.txt by replacing source with content.";
    const first = await run(original,false,undefined,"Counting setup unavailable");
    expect(first.result.outcome).toBe("partial"); expect(first.approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(first.runId)?.agentTask?.modelCalls).toBe(0);
    const saved = getCurrentAgentTask(chatId)!;
    expect(saved.snapshot.messages[0]).toMatchObject({content:original,disposition:"pending"});
    expect(getExecutionLedger(first.runId)?.agentTask?.preparation).toMatchObject({taskId:saved.taskId,taskRevision:1,messageId:saved.snapshot.messages[0].id});
    replies = [payload=>{
      const input = packetState(payload.messages[1].content);
      expect(input.pendingRequests[0].sources.map((item:any)=>item.text).join("")).toBe(original);
      return {disposition:"continue",requirements:[{kind:"change",description:original,source_id:"p1:request",checks:[{description:"Save the requested text edit",kind:"review",operation:"semantic",path:null}]}],updates:[],full_suite:false};
    },()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),
    ()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]}),
    ()=>({tool_calls:[{name:"finish",arguments:{text:"The requested text edit is saved."}}]}),payload=>{
      const input = packetState(payload.messages[1].content);
      expect(input.originalRequests.some((message:any)=>message.content===original)).toBe(true);
      return {covered:true,missing:[],requirements:input.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The observed text edit is saved."}))};
    }];
    const next = await run("Continue");
    expect(next.result.outcome,next.result.text).toBe("completed");
    expect(getCurrentAgentTask(chatId)?.taskId).toBe(saved.taskId);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements[0].source.messageId).toBe(saved.snapshot.messages[0].id);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved content\n");
  });
  it("keeps malformed interpretation pending and does not treat later logs as permission to discard it", async () => {
    const original = "Repair note.txt";
    replies = [()=>({invalid:"one"}),()=>({invalid:"two"})];
    const first = await run(original);
    expect(first.result.stopReason).toBe("requirement_interpretation_failed");
    expect(getCurrentAgentTask(chatId)?.snapshot.messages[0].disposition).toBe("pending");
    replies = [()=>({disposition:"evidence",requirements:[],updates:[],full_suite:false})];
    const logs = await run("Error: old repair is still broken");
    expect(logs.result.stopReason).toBe("requirements_pending");
    expect(logs.approve).not.toHaveBeenCalled();
    expect(getCurrentAgentTask(chatId)?.snapshot.messages.map(item=>item.disposition)).toEqual(["pending","evidence"]);
  });
  it("answers status about a pending original without taking workspace actions", async () => {
    await run("Repair note.txt",false,undefined,"Counting setup unavailable");
    const task = getCurrentAgentTask(chatId)!;
    replies = [()=>({disposition:"status",requirements:[],updates:[],full_suite:false}),payload=>{
      const input = packetState(payload.messages[1].content);
      expect(input.pendingRequests[0].content).toBe("Repair note.txt");
      return "The original repair request still needs requirement interpretation.";
    }];
    const status = await run("What is the status?");
    expect(status.result.stopReason).toBe("status_reply"); expect(status.approve).not.toHaveBeenCalled();
    expect(status.emit.mock.calls.some(([event])=>event.type==="tool_call")).toBe(false);
    expect(getCurrentAgentTask(chatId)?.taskId).toBe(task.taskId);
    expect(getCurrentAgentTask(chatId)?.snapshot.messages[0].disposition).toBe("pending");
    expect(getCurrentAgentTask(chatId)?.status).not.toBe("completed");
  });
  it("saves the task-level baseline approval with an explicit null requirement instead of an undefined value", async () => {
    writeFileSync(path.join(root,"package.json"),JSON.stringify({type:"module",scripts:{test:"node --test"}}));
    writeFileSync(path.join(root,"example.test.js"),'import test from "node:test"; test("existing test",()=>{});');
    const text = "Run the existing project tests.";
    replies = [()=>interpretation("execute",text),()=>({tool_calls:[{name:"finish",arguments:{text:"Report the available checks."}}]})];
    const {runId,result} = await run(text);
    expect(result.text).not.toContain("non-JSON value");
    const store = new RunResultStore(runId), approval = store.listResults({limit:50}).find(record=>record.producer.tool==="agent_operation_approval");
    expect(approval).toBeDefined();
    expect(store.retrieveResultSlice(approval!.resultId,{mode:"json",pointer:"/requirementId"}).content).toBe("null");
  });
  it("obtains source from actual baseline failures before the model proposes an approved repair",async()=>{
    const workspace=path.join(root,"project");mkdirSync(workspace);
    const implementation='exports.readValue = () => { throw new Error("wrong value"); };\n';
    const test='const {test}=require("node:test");const assert=require("node:assert/strict");const {readValue}=require("./value.cjs");test("existing value",()=>assert.equal(readValue(),"ready"));\n';
    writeFileSync(path.join(workspace,"package.json"),JSON.stringify({scripts:{test:"node --test"}}));
    writeFileSync(path.join(workspace,"value.cjs"),implementation);writeFileSync(path.join(workspace,"value.test.cjs"),test);
    const request="Inspect the source, reproduce the failure, repair value.cjs, and run the existing tests.";
    replies=[()=>({disposition:"continue",requirements:["inspect","change","execute"].map(kind=>({kind,description:request,source_id:"request",checks:[{description:request,kind:kind === "execute"?"execution":"review",operation:"semantic",path:null}]})),updates:[],full_suite:true}),payload=>{
      const state=packetState(payload.messages[1].content);
      expect(state.currentRequirement.kind).toBe("change");
      observedSource(payload,"value.cjs",implementation);
      observedSource(payload,"value.test.cjs",test);
      expect(state.feedback.text).toContain("wrong value");
      return {tool_calls:[{name:"edit_file",arguments:{path:"value.cjs",expected_digest:createHash("sha256").update(implementation).digest("hex"),replacements:[{old:'throw new Error("wrong value");',new:'return "ready";'}]}}]};
    },()=>({tool_calls:[{name:"finish",arguments:{text:"The existing test now passes after the value repair."}}]}),...Array.from({length:3},()=>(payload:any)=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Source was inspected; the baseline failed and the existing test passed after repair."}))};})];
    const {result,runId,approve,emit}=await run(request,false,undefined,undefined,workspace);
    expect(result.outcome,result.text+JSON.stringify(emit.mock.calls.filter(([event])=>event.type === "tool_result"))).toBe("completed");
    const ledger=getExecutionLedger(runId)!;
    expect(ledger.agentProgress?.actions.map(action=>action.operation)).toEqual(["draft_module","edit_file"]);
    expect(ledger.agentProgress?.sourceResultIds).toHaveLength(2);
    expect(ledger.agentProgress?.reads.map(read=>read.path)).toContain("value.cjs");
    expect(ledger.verification?.evidence).toContainEqual(expect.objectContaining({criterionId:"baseline:project-tests",status:"failed"}));
    expect(ledger.verification?.evidence).toContainEqual(expect.objectContaining({criterionId:"acceptance:validate-written-code",status:"passed"}));
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation.replace('throw new Error("wrong value");','return "ready";'));
    expect(readFileSync(path.join(workspace,"value.test.cjs"),"utf8")).toBe(test);
    expect(approve).toHaveBeenCalledTimes(3);
    // A historical pass cannot retire failure context for a later source revision.
    writeFileSync(path.join(workspace,"value.cjs"),implementation);
    expect(selectAgentFailureStep({runId,workspaceRoot:workspace} as any)?.phase).toBe("address_failure");
  });
  it("keeps one failure module in focus, follows failed-test imports, then verifies both saved edits",async()=>{
    const workspace=path.join(root,"project");mkdirSync(workspace);
    const storage='exports.load = () => { throw new Error("bad data"); };\n';
    const filters='exports.select = (items, status) => items;\n';
    const storageTest='const {test}=require("node:test");const assert=require("node:assert/strict");const {load}=require("./storage.cjs");test("invalid data",()=>assert.deepEqual(load(),[]));\n';
    const filtersTest='const {test}=require("node:test");const assert=require("node:assert/strict");const {select}=require("./filters.cjs");test("status filter",()=>assert.equal(select([{status:"open"},{status:"closed"}],"open").length,1));\n';
    for(const [file,content] of Object.entries({"package.json":JSON.stringify({scripts:{test:"node --test"}}),"storage.cjs":storage,"filters.cjs":filters,"storage.test.cjs":storageTest,"filters.test.cjs":filtersTest,"unrelated.txt":"do not read this as a checklist"}))writeFileSync(path.join(workspace,file),content);
    const request="Inspect, reproduce, and repair both existing module failures. Run the full suite.";
    const edit=(file:string,source:string,old:string,replacement:string)=>({tool_calls:[{name:"edit_file",arguments:{path:file,expected_digest:createHash("sha256").update(source).digest("hex"),replacements:[{old,new:replacement}]}}]});
    replies=[()=>interpretation("execute",request),payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.currentStep).toMatchObject({phase:"address_failure",target:{path:"storage.cjs",role:"implementation",digest:createHash("sha256").update(storage).digest("hex")}});
      expect(input.currentStep.executionResultIds).toHaveLength(1);
      observedSource(payload,"storage.cjs",storage);
      expect(input.suggestedReadPaths).toBeUndefined();
      return edit("storage.cjs",storage,'throw new Error("bad data");','return [];');
    },payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.currentStep).toMatchObject({phase:"address_failure",target:{path:"filters.cjs",role:"implementation"},relatedPaths:["filters.cjs","filters.test.cjs"]});
      observedSource(payload,"filters.cjs",filters);
      expect(input.selectedSources.pages.some((page:any)=>page.path === "storage.cjs")).toBe(false);
      return edit("filters.cjs",filters,"=> items;","=> items.filter(item => item.status === status);");
    },payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.currentStep).toBeUndefined();
      expect(input.checkEvidence).toContainEqual(expect.objectContaining({criterionId:"acceptance:validate-written-code",status:"passed"}));
      expect(payload.messages[0].content).toContain("The host has verified the saved repair");
      expect(payload.response_format).toBeUndefined();
      return {tool_calls:[{name:"finish",arguments:{text:"Both module defects are repaired. The host must verify the existing suite."}}]};
    },payload=>{const input=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:input.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Existing tests failed before the saved edits and passed after them."}))};}];
    const {result,runId,approve}=await run(request,false,undefined,undefined,workspace);
    expect(result.outcome,result.text).toBe("completed");expect(approve.mock.calls.length).toBeGreaterThanOrEqual(4);
    const ledger=getExecutionLedger(runId)!;
    expect(ledger.agentProgress?.actions.map(action=>action.operation)).toEqual(["draft_module","edit_file","draft_module","edit_file"]);
    expect(ledger.agentProgress?.sourceResultIds?.length).toBeGreaterThanOrEqual(4);
    expect(ledger.agentProgress?.failure?.targets.filter(target=>target.role === "implementation").map(target=>target.path)).toContain("filters.cjs");
    expect(ledger.verification?.repairCount).toBeLessThanOrEqual(2);expect(ledger.verification?.evidence.find(check=>check.criterionId === "acceptance:validate-written-code")?.status).toBe("passed");
    expect(readFileSync(path.join(workspace,"storage.test.cjs"),"utf8")).toBe(storageTest);expect(readFileSync(path.join(workspace,"filters.test.cjs"),"utf8")).toBe(filtersTest);
  });
  it("runs checks after each changed failure candidate and stops after two unsuccessful repair cycles",async()=>{
    const {workspace,implementation}=failingWorkspace();
    let current=implementation;
    replies=[()=>interpretation("execute","Reproduce and repair value.cjs"),...[1,2,3].map(index=>(payload:any)=>{
      const state=packetState(payload.messages[1].content);
      expect(state.currentStep.phase).toBe("address_failure");
      expect(state.feedback.text).toContain(index === 1 ? "Baseline failures" : "Correct the saved code");
      const next=`exports.readValue = () => { throw new Error("failed repair ${index}"); };\n`;
      const proposal={tool_calls:[{name:"edit_file",arguments:{path:"value.cjs",expected_digest:createHash("sha256").update(current).digest("hex"),replacements:[{old:current,new:next}]}}]};
      current=next;return proposal;
    })];
    const {result,runId,approve}=await run("Reproduce and repair value.cjs",false,undefined,undefined,workspace);
    expect(result.outcome).toBe("partial");expect(result.text).toContain("two repair cycles");
    const ledger=getExecutionLedger(runId)!;
    expect(ledger.agentProgress?.actions.map(action=>action.operation)).toEqual(["draft_module","edit_file","draft_module","edit_file","draft_module","edit_file"]);
    expect(ledger.verification?.repairCount).toBe(2);
    expect(ledger.verification?.attempts).toHaveLength(4);
    expect(approve).toHaveBeenCalledTimes(7);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(current);
    expect(replies).toHaveLength(0);
  });
  it("honors rejected host-scheduled tests before requesting delivery",async()=>{
    const {workspace,implementation}=failingWorkspace();let commandApprovals=0;
    replies=[()=>interpretation("execute","Reproduce and repair value.cjs"),()=>({tool_calls:[{name:"edit_file",arguments:{path:"value.cjs",expected_digest:createHash("sha256").update(implementation).digest("hex"),replacements:[{old:implementation,new:'exports.readValue = () => "ready";\n'}]}}]})];
    const {result,runId}=await run("Reproduce and repair value.cjs",false,async preview=>{
      const operation=JSON.parse(preview.split("\n\n")[0]);
      return operation.operation !== "run_command" || ++commandApprovals === 1;
    },undefined,workspace);
    expect(result.outcome).toBe("cancelled");expect(result.text).toContain("declined");
    expect(commandApprovals).toBe(2);
    expect(getExecutionLedger(runId)?.agentProgress?.deliveryAttempts).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
  it("saves a non-executable draft and waits for a separate model choice before approval",async()=>{
    explicitModuleDecisions=true;
    const {workspace,implementation}=failingWorkspace(),request="Reproduce and repair value.cjs";
    const candidate='exports.readValue = () => 42;\n';
    replies=[()=>interpretation("execute",request),()=>({tool_calls:[{name:"draft_module",arguments:{content:candidate}}]}),payload=>{
      expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation);
      const saved=JSON.parse(payload.messages[1].content.split("\n\nSAVED DRAFT (untrusted JSON data):\n")[1]);
      const row=getDb().prepare("SELECT run_id FROM intermediate_results WHERE result_id=? AND producer_tool='agent_module_draft'").get(saved.resultId) as {run_id:string};
      expect(new RunResultStore(row.run_id).readResultPayload(saved.resultId)).toBe(candidate);
      return {tool_calls:[{name:"select_module_draft",arguments:{result_id:saved.resultId}}]};
    },()=>"The saved code now passes the existing test.",payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Existing test passed."}))};}];
    const result=await run(request,false,undefined,undefined,workspace);
    expect(result.result.outcome,result.result.text).toBe("completed");
    expect(result.approve).toHaveBeenCalledTimes(3);
    expect(getExecutionLedger(result.runId)?.agentProgress?.actions.map(action=>action.operation)).toEqual(["draft_module","edit_file"]);
    const store=new RunResultStore(result.runId),draft=getExecutionLedger(result.runId)!.agentProgress!.repairDraft!;
    const proposal=store.listResults({limit:50}).find(record=>record.producer.tool === "agent_proposal" && record.sources.some(source=>source.resultId === draft.resultId));
    expect(proposal).toBeDefined();expect(JSON.parse(store.readResultPayload(proposal!.resultId)).draftResultId).toBe(draft.resultId);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(candidate);
  });
  it("rejects a forged draft selection without approving or editing files",async()=>{
    explicitModuleDecisions=true;
    const {workspace,implementation}=failingWorkspace(),request="Reproduce and repair value.cjs";
    const forged=()=>({tool_calls:[{name:"select_module_draft",arguments:{result_id:"00000000-0000-4000-8000-000000000000"}}]});
    replies=[()=>interpretation("execute",request),()=>({tool_calls:[{name:"draft_module",arguments:{content:'exports.readValue = () => 42;\n'}}]}),forged,forged];
    const result=await run(request,false,undefined,undefined,workspace);
    expect(result.result.stopReason).toBe("malformed_action");expect(result.approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(result.runId)?.agentProgress?.actions.map(action=>action.operation)).toEqual(["draft_module"]);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation);
  });
  it("can request context after saving a draft without applying it",async()=>{
    explicitModuleDecisions=true;
    const {workspace,implementation}=failingWorkspace(),request="Reproduce and repair value.cjs",controller=new AbortController();runSignal=controller.signal;
    replies=[()=>interpretation("execute",request),()=>({tool_calls:[{name:"draft_module",arguments:{content:'exports.readValue = () => 42;\n'}}]}),
      ()=>({tool_calls:[{name:"request_module_context",arguments:{reason:"Read another source before deciding."}}]}),payload=>{
        expect(packetState(payload.messages[1].content).toolView).toContain("one action");
        expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation);
        controller.abort();return {tool_calls:[{name:"read_file",arguments:{path:"value.test.cjs"}}]};
      }];
    const result=await run(request,false,undefined,undefined,workspace);
    expect(result.result.outcome).toBe("cancelled");expect(result.approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(result.runId)?.agentProgress?.actions.map(action=>action.operation)).toEqual(["draft_module","request_context"]);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation);
  });
  it("can show all registered tools for one repair action without granting mutation authority",async()=>{
    const {workspace,implementation}=failingWorkspace();writeFileSync(path.join(workspace,"extra.txt"),"needed context\n");
    const toolNames=(payload:any)=>payload.response_format.json_schema.name === "agent_tool_arguments" ? [Boolean(payload.response_format.json_schema.schema.properties?.content) ? "draft_module" : "propose_repair"] : payload.response_format.json_schema.schema.properties.tool_calls.items.anyOf.flatMap((tool:any)=>tool.properties.name.enum);
    replies=[()=>interpretation("execute","Reproduce and repair value.cjs"),payload=>{
      expect(toolNames(payload)).toEqual(["draft_module"]);
      return {tool_calls:[{name:"propose_repair",arguments:{kind:"tools",capability:"source_access",reason:"Find additional source for this repair"}}]};
    },payload=>{
      expect(toolNames(payload)).toEqual(expect.arrayContaining(["read_file","search","list_dir","write_file","edit_file","delete_file","run_command"]));
      expect(packetState(payload.messages[1].content).toolView).toContain("one action");
      return {tool_calls:[{name:"read_file",arguments:{path:"extra.txt"}}]};
    },payload=>{
      expect(toolNames(payload)).toEqual(["draft_module"]);
      expect(payload.messages[1].content).toContain("<source>\nneeded context\n\n</source>");
      expect(payload.messages[1].content.indexOf("OBSERVED SOURCE value.cjs")).toBeLessThan(payload.messages[1].content.indexOf("OBSERVED SOURCE extra.txt"));
      expect(payload.messages[1].content).toContain("Role: CURRENT REPAIR TARGET");
      expect(payload.messages[1].content).toContain("Role: SUPPORTING CONTEXT; do not replace the target with this file");
      return {tool_calls:[{name:"propose_repair",arguments:{kind:"blocked",reason:"No further repair is justified by this evidence"}}]};
    }];
    const {result,runId,approve}=await run("Reproduce and repair value.cjs",false,undefined,undefined,workspace);
    expect(result.stopReason,result.text).toBe("repair_blocked");expect(approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(runId)?.agentProgress?.actions.map(action=>action.operation)).toEqual(["draft_module","request_context","read_file","draft_module"]);
    expect(getExecutionLedger(runId)?.agentProgress?.expandedToolFocus).toBeUndefined();
    expect(getExecutionLedger(runId)?.agentProgress?.reads.some(read=>read.path === "extra.txt")).toBe(true);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements.every(item=>item.state === "active")).toBe(true);
  });
  it("rejects a repair proposal that tries to replace its host-bound target",async()=>{
    const {workspace,implementation}=failingWorkspace();
    const override=()=>({tool_calls:[{name:"propose_repair",arguments:{kind:"edit",path:"value.test.cjs",replacements:[{old:[implementation],new:["exports.readValue = () => 1;"]}]}}]});
    replies=[()=>interpretation("execute","Reproduce and repair value.cjs"),override,override];
    const {result,runId,approve}=await run("Reproduce and repair value.cjs",false,undefined,undefined,workspace);
    expect(result.stopReason,result.text).toBe("malformed_action");expect(approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(runId)?.agentTask?.protocolCorrections).toBe(1);
    expect(getExecutionLedger(runId)?.agentProgress?.actions).toEqual([]);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation);
  });
  it("stops repeated module context requests when only capability metadata changed",async()=>{
    const {workspace,implementation}=failingWorkspace();
    const request="Reproduce and repair value.cjs";
    replies=[()=>interpretation("execute",request),()=>({tool_calls:[{name:"propose_module_repair",arguments:{content:null,context_needed:"Need other tools"}}]}),()=>{
      const id=getCurrentAgentTask(chatId)!.latestRunId!;
      new RunResultStore(id).registerResult({type:"structured",status:"complete",origin:"execution",producer:{tool:"agent_operation_approval",callId:"approval"},summary:"Approval receipt",payload:{operation:"run_command"},sources:[]});
      return {tool_calls:[{name:"request_capability",arguments:{capability:"document_processing",reason:"Show another tool"}}]};
    },()=>({tool_calls:[{name:"propose_module_repair",arguments:{content:null,context_needed:"Need more tools again"}}]})];
    const {result,runId,approve}=await run(request,false,undefined,undefined,workspace);
    expect(result.stopReason,result.text).toBe("repeated_context_request");expect(approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(runId)?.agentProgress?.actions.map(action=>action.operation)).toEqual(["draft_module","request_context","request_capability"]);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation);
  });
  it("stops the same command on unchanged project inputs after its first result",async()=>{
    const request="Run the command printf READY.", command=()=>({tool_calls:[{name:"run_command",arguments:{command:"printf READY"}}]});
    const workspace=path.join(root,"command-project");mkdirSync(workspace);
    replies=[()=>interpretation("execute",request),command,command];
    const {result,approve,runId}=await run(request,false,undefined,undefined,workspace);
    expect(result.stopReason,result.text).toBe("repeated_action");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(runId)?.agentProgress?.actions.filter(action=>action.operation === "run_command")).toHaveLength(1);
  });
  it("rejects a wrong-module replacement when public behavior must be preserved",async()=>{
    const workspace=path.join(root,"preserve-project");mkdirSync(workspace);
    const source="export function filter() { return 1; }\nexport function change() { return 2; }\n";
    writeFileSync(path.join(workspace,"module.js"),source);
    const text="Repair module.js. Keep the current design and public behavior.";
    const proposal=()=>({tool_calls:[{name:"edit_file",arguments:{path:"module.js",expected_digest:createHash("sha256").update(source).digest("hex"),replacements:[{old:source,new:"console.log('wrong module');\n"}]}}]});
    replies=[()=>({disposition:"continue",requirements:[{kind:"change",description:"Repair module.js",source_id:"request",checks:[{description:"Repair it",kind:"review",operation:"semantic",path:null}]},{kind:"preserve",description:"Keep public behavior",source_id:"request",checks:[{description:"Preserve public behavior",kind:"review",operation:"semantic",path:null}]}],updates:[],full_suite:false}),
      ()=>({tool_calls:[{name:"read_file",arguments:{path:"module.js"}}]}),proposal,proposal];
    const {result,approve}=await run(text,false,undefined,undefined,workspace);
    expect(result.outcome).toBe("partial");expect(approve).not.toHaveBeenCalled();
    expect(readFileSync(path.join(workspace,"module.js"),"utf8")).toBe(source);
  });
  it("rejects command publication that removes preserved exports",async()=>{
    const workspace=path.join(root,"command-preserve-project");mkdirSync(workspace);
    const source="export function filter() { return 1; }\n";writeFileSync(path.join(workspace,"module.js"),source);
    const text="Update module.js with a command. Keep current public behavior.";
    const proposal=()=>({tool_calls:[{name:"run_command",arguments:{command:"printf 'console.log(1)' > module.js"}}]});
    replies=[()=>({disposition:"continue",requirements:[{kind:"change",description:"Update module.js",source_id:"request",checks:[{description:"Update it",kind:"review",operation:"semantic",path:null}]},{kind:"preserve",description:"Keep public behavior",source_id:"request",checks:[{description:"Preserve behavior",kind:"review",operation:"semantic",path:null}]}],updates:[],full_suite:false}),proposal,proposal];
    const {result,approve}=await run(text,false,undefined,undefined,workspace);
    expect(result.outcome).toBe("partial");expect(approve).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(workspace,"module.js"),"utf8")).toBe(source);
  });
  it("obtains read-only failure evidence without requiring a change category",async()=>{
    const workspace=path.join(root,"project");mkdirSync(workspace);
    const implementation='exports.readValue = () => { throw new Error("failure to inspect"); };\n';
    writeFileSync(path.join(workspace,"package.json"),JSON.stringify({scripts:{test:"node --test"}}));
    writeFileSync(path.join(workspace,"value.cjs"),implementation);
    writeFileSync(path.join(workspace,"value.test.cjs"),'const {test}=require("node:test");const {readValue}=require("./value.cjs");test("existing failure",()=>readValue());\n');
    const controller=new AbortController();runSignal=controller.signal;
    const request="Inspect source and reproduce the existing test failure.";
    replies=[()=>({disposition:"continue",requirements:["inspect","execute"].map(kind=>({kind,description:request,source_id:"request",checks:[{description:request,kind:kind === "execute"?"execution":"inspection",operation:"semantic",path:null}]})),updates:[],full_suite:true}),payload=>{
      const state=packetState(payload.messages[1].content);
      observedSource(payload,"value.cjs",implementation);
      expect(state.currentRequirement.kind).toBe("execute");
      expect(payload.response_format.json_schema.name).toBe("agent_tool_arguments");
      expect(state.readSelection).toBeUndefined();
      expect(state.currentStep.target.path).toBe("value.cjs");
      controller.abort();return {tool_calls:[{name:"finish",arguments:{text:"The baseline failure has saved source evidence."}}]};
    }];
    const {result,runId,approve}=await run(request,false,undefined,undefined,workspace);
    expect(result.outcome,result.text).toBe("cancelled");expect(approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(runId)?.agentProgress?.sourceResultIds).toHaveLength(2);
    expect(getExecutionLedger(runId)?.agentProgress?.actions).toEqual([]);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation);
  });
  it("restores read paths omitted by repacking instead of keeping the larger packet's tool enum",async()=>{
    const workspace=path.join(root,"project");mkdirSync(workspace);
    const implementation='exports.value = () => { throw new Error("failure"); };\n';
    writeFileSync(path.join(workspace,"package.json"),JSON.stringify({scripts:{test:"node --test"}}));
    writeFileSync(path.join(workspace,"value.cjs"),implementation);
    writeFileSync(path.join(workspace,"value.test.cjs"),'const {test}=require("node:test");const {value}=require("./value.cjs");test("existing failure",()=>value());\n');
    const original=ModelGateway.prototype.chatWithTools;let rejected=0;
    vi.spyOn(ModelGateway.prototype,"chatWithTools").mockImplementation(async function(this:ModelGateway,modelId,messages,tools,options){
      const state=packetState(messages[1]?.content ?? "{}");
      if(state.selectedSources?.pages.some((page:any)=>page.path === "value.test.cjs")){
        const names=tools.map(tool=>tool.function.name);
        expect(names).toContain(names.includes("select_module_draft") ? "select_module_draft" : state.toolView ? "read_file" : "draft_module");
        rejected++;return {ok:false,error:{kind:"ai-error",code:"agent_context_limit",message:"Remove optional source pages",retryable:false}};
      }
      return original.call(this,modelId,messages,tools,options);
    });
    const controller=new AbortController();runSignal=controller.signal;
    replies=[()=>interpretation("execute","Reproduce the existing failure"),payload=>{
      const state=packetState(payload.messages[1].content);
      expect(state.selectedSources.complete).toBe(false);
      expect(state.selectedSources.pages.map((page:any)=>page.path)).toEqual(["value.cjs"]);
      expect(payload.response_format.json_schema.name).toBe("agent_tool_arguments");
      expect(state.contextRule).toContain("registered tools");
      return {tool_calls:[{name:"propose_module_repair",arguments:{content:null,context_needed:"Read the omitted test source"}}]};
    },payload=>{
      const state=packetState(payload.messages[1].content);
      expect(state.suggestedReadPaths).toContain("value.test.cjs");
      const read=payload.response_format.json_schema.schema.properties.tool_calls.items.anyOf.find((tool:any)=>tool.properties.name.enum[0] === "read_file");
      expect(read.properties.arguments.properties.path.enum).toContain("value.test.cjs");
      controller.abort();return {tool_calls:[{name:"read_file",arguments:{path:"value.test.cjs"}}]};
    }];
    const {result,runId,approve}=await run("Reproduce the existing failure",false,undefined,undefined,workspace);
    expect(result.outcome,result.text).toBe("cancelled");expect(rejected).toBe(6);expect(approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBe(5);
    expect(getExecutionLedger(runId)?.agentProgress?.reads.every(read=>read.path === "value.cjs")).toBe(true);
    expect(getExecutionLedger(runId)?.agentProgress?.actions.map(action=>action.operation)).toEqual(["draft_module","request_context"]);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe(implementation);
  });
  it("explicitly resumes the saved v3 contract, task, and call budget without repeating interpretation", async () => {
    const text = "Inspect note.txt";
    const covered = (payload: any) => {
      const state = packetState(payload.messages[1].content);
      return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Inspected source" })) };
    };
    replies = [() => interpretation("inspect", text), () => "Advice without an inspection.", covered, () => "More advice."];
    const first = await run(text, true);
    expect(first.result.outcome).toBe("partial");
    const before = getExecutionLedger(first.runId)!;
    const task = getCurrentAgentTask(chatId)!;
    expect(before.agentProgress?.reads).toHaveLength(0);
    replies = [() => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "saved source", covered];
    await first.manager!.resume(first.runId);
    await vi.waitFor(() => expect(first.manager!.getRunSnapshot({ runId: first.runId })?.state).toBe("completed"), { timeout: 10000 });
    const after = getExecutionLedger(first.runId)!;
    expect(after.agentTask?.modelCalls).toBeGreaterThan(before.agentTask!.modelCalls);
    expect(after.resumeCount).toBe(1);
    expect(after.agentTask?.taskId).toBe(task.taskId);
    expect(getCurrentAgentTask(chatId)?.snapshot.revision).toBe(task.snapshot.revision);
    expect(after.agentAdmissions.filter(item => item.phase === "requirements")).toHaveLength(2);
  });
  it("restores a v3 task after restart with the same project identity and fresh approval",async()=>{
    const text="Repair note.txt";
    replies=[()=>interpretation("change",text),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),()=>"Invalid action",()=>"Invalid action"];
    const first=await run(text,true),task=getCurrentAgentTask(chatId)!;
    expect(first.result.outcome).toBe("partial");
    const approval=createConfirmation(first.runId,"plan_approval","old preview","Old approval");
    closeDb();initDb(path.join(root,"db.sqlite"));reconcileInterruptedExecutions();recoverInterruptedModeRuns();
    const harness=new HarnessManager();expect(harness.restoreWorkspace()).toEqual(task.workspace);
    const resumed=new RunManager((first.manager as any).gateway,undefined,undefined,{agentV3Preview:true});resumed.setHarness(harness);
    expect(resumed.getRunSnapshot({runId:first.runId})?.recovery?.canResume).toBe(true);
    expect(getDb().prepare("SELECT outcome FROM confirmations WHERE action_id=?").get(approval.actionId)).toEqual({outcome:"expired"});
    replies=[()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]})];
    await resumed.resume(first.runId);
    await vi.waitFor(()=>expect(resumed.getRunSnapshot({runId:first.runId})?.pendingAction).toBeDefined(),{timeout:10000});
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
    const pending=resumed.getRunSnapshot({runId:first.runId})!.pendingAction!;
    expect(pending.actionId).not.toBe(approval.actionId);
    await resumed.confirm({runId:first.runId,actionId:pending.actionId,approved:false});
    await vi.waitFor(()=>expect(resumed.getRunSnapshot({runId:first.runId})?.state).toBe("cancelled"));
    expect(getCurrentAgentTask(chatId)?.snapshot.revision).toBe(task.snapshot.revision);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it("blocks v3 resume after project registration changes without spending a resume",async()=>{
    replies=[()=>interpretation("change","Repair note.txt"),()=>"Invalid action",()=>"Invalid action"];
    const first=await run("Repair note.txt",true),harness=new HarnessManager();
    harness.registerWorkspace(root);first.manager!.setHarness(harness);
    expect(first.manager!.getRunSnapshot({runId:first.runId})?.recovery).toMatchObject({canResume:false,reason:expect.stringContaining("binding changed")});
    await expect(first.manager!.resume(first.runId)).rejects.toThrow("binding changed");
    expect(getExecutionLedger(first.runId)?.resumeCount).toBe(0);
  });
  it("continues a legacy request in a linked v3 attempt and preserves the historical ledger",async()=>{
    const text="Inspect note.txt";
    replies=[()=>interpretation("inspect",text),()=>"Invalid action",()=>"Invalid action"];
    const first=await run(text,true),ledger=getExecutionLedger(first.runId);
    getDb().prepare("UPDATE run_mode_details SET engine_version='agent-v2' WHERE run_id=?").run(first.runId);
    const oldTask=getCurrentAgentTask(chatId)!;
    getDb().prepare("DELETE FROM agent_tasks WHERE task_id=?").run(oldTask.taskId);
    replies=[()=>interpretation("inspect",text),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),()=>"Inspected saved source.",payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Source inspected"}))};}];
    const next=await first.manager!.resume(first.runId);
    expect(next.runId).not.toBe(first.runId);
    await vi.waitFor(()=>expect(first.manager!.getRunSnapshot({runId:next.runId})?.state).toBe("completed"),{timeout:10000});
    expect(first.manager!.getRunSnapshot({runId:next.runId})).toMatchObject({engineVersion:"agent-v3",agentTaskBinding:{predecessorRunId:first.runId}});
    expect(getExecutionLedger(first.runId)).toEqual(ledger);
    expect(getExecutionLedger(next.runId)?.agentTask?.modelCalls).toBeGreaterThan(0);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it.skipIf(!process.env.WORKBENCH_LMSTUDIO_RUNNER_PROBE)("runs an actual 7B inspection through the new loop without workspace mutations", async () => {
    vi.restoreAllMocks();
    const endpoint = process.env.WORKBENCH_LMSTUDIO_PROBE_ENDPOINT ?? "http://127.0.0.1:1234";
    const model = process.env.WORKBENCH_AGENT_REPAIR_MODEL ?? "qwen2.5-coder-7b-instruct-mlx";
    const gateway = new ModelGateway(undefined, [{ id: "live-driver", runtime: "mlx-lm", baseUrl: `${endpoint.replace(/\/$/, "")}/v1`, model, capabilities: ["text"], requestTimeoutMs: 60000, healthPath: "/models", enabled: true, contextLength: 8192, toolCallingFormat: "json" }]);
    const text = "Read note.txt and report its exact content. Do not edit any file.";
    const runId = createRun(chatId, text), messageId = addMessage({ chat_id: chatId, role: "user", content: text }).id;
    getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(runId, root);
    const approve = vi.fn(async () => false), controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const result = await withRuntimeScope({ runId, mode: "agent", signal: controller.signal }, () => new AgentTaskRunner().run({ modelId: "live-driver", chatId, messageId, workspace: { root, registeredAt: "live" }, approve, state: state => transition(runId, state), context: { runId, workspaceRoot: root, gateway, resultStore: new RunResultStore(runId), policyGuard: new MutationPolicyGuard(), envelope: buildExecutionEnvelope({ runId, mode: "agent", modelId: "live-driver", hasWorkspace: true, workspaceRoot: root }) } }));
      const store = new RunResultStore(runId);
      const records = store.listResults({ limit: 50 });
      for (let offset = 50; records.length === offset; offset += 50) records.push(...store.listResults({ limit: 50, offset }));
      const savedResults = records.map(record => {
        let content = "", offset: number | undefined = 0;
        while (offset !== undefined) { const page = store.retrieveResultSlice(record.resultId, { mode: "text", offset, maxChars: 3000 }); content += page.content; offset = page.nextOffset; }
        return { record, content };
      });
      const proof = { recordedAt: new Date().toISOString(), model, contextLimit: 8192, result, admissions: getExecutionLedger(runId)?.agentAdmissions, progress: getExecutionLedger(runId)?.agentProgress, requirements: getCurrentAgentTask(chatId)?.snapshot.requirements, approvalRequests: approve.mock.calls.length, savedResults };
      if (process.env.WORKBENCH_AGENT_RUNNER_PROBE_REPORT) writeFileSync(process.env.WORKBENCH_AGENT_RUNNER_PROBE_REPORT, JSON.stringify(proof, null, 2));
      expect(result.outcome, result.text).toBe("completed"); expect(result.text).toContain("saved source"); expect(approve).not.toHaveBeenCalled();
      expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("saved source\n");
    } finally { clearTimeout(timeout); }
  }, 120000);
  it.skipIf(!process.env.WORKBENCH_LMSTUDIO_DOCUMENT_PROBE)("completes a live staged-input inspection and Markdown deliverable export through the v3 loop", async () => {
    vi.restoreAllMocks();
    const endpoint = process.env.WORKBENCH_LMSTUDIO_PROBE_ENDPOINT ?? "http://127.0.0.1:1234";
    const model = process.env.WORKBENCH_AGENT_REPAIR_MODEL ?? "qwen/qwen3.5-9b";
    const gateway = new ModelGateway(undefined, [{ id: "live-driver", runtime: "mlx-lm", baseUrl: `${endpoint.replace(/\/$/, "")}/v1`, model, capabilities: ["text"], requestTimeoutMs: 60000, healthPath: "/models", enabled: true, contextLength: 8192, toolCallingFormat: "json" }]);
    const input = { id: "11111111-1111-4111-8111-111111111111", filename: "incident-notes.txt", content: "Pump P-204 pressure sensor failed calibration during the 08:00 inspection.\nAction: Replace sensor unit S-204 and rerun pressure test.\n" };
    const text = "Read the staged input incident-notes.txt and create a downloadable Markdown file named summary.md that summarizes the pump incident and required action. Do not edit any workspace files.";
    const runId = createRun(chatId, text), messageId = addMessage({ chat_id: chatId, role: "user", content: text }).id;
    getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,'agent','agent-v3',?)").run(runId, root);
    const inputDir = path.join(root, "runs", runId, "input"); mkdirSync(inputDir, { recursive: true });
    writeFileSync(path.join(inputDir, input.filename), input.content);
    const inputSources = [{ id: input.id, filename: input.filename, relativePath: `runs/${runId}/input/${input.filename}`, sha256: createHash("sha256").update(input.content).digest("hex"), originRunId: runId }];
    const approvals: unknown[] = [];
    const approve = vi.fn(async (preview: string) => {
      const parsed = JSON.parse(preview.split("\n\n")[0]);
      approvals.push(parsed);
      return parsed.operation === "generate_deliverable" && parsed.arguments?.filename === "summary.md";
    });
    const emit = vi.fn((event: any) => {
      if (event.type === "artifact_ready") {
        const artifact = event.artifact, file = path.join(root, artifact.relativePath), digest = createHash("sha256").update(readFileSync(file)).digest("hex");
        getDb().prepare("INSERT INTO artifacts(artifact_id,run_id,kind,filename,relative_path,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)").run(artifact.artifactId, artifact.runId, artifact.kind, artifact.filename, artifact.relativePath, artifact.sizeBytes, digest, artifact.createdAt);
      }
    });
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 240000);
    try {
      const result = await withRuntimeScope({ runId, mode: "agent", signal: controller.signal }, () => new AgentTaskRunner().run({ modelId: "live-driver", chatId, messageId, workspace: { root, registeredAt: "live-doc" }, approve, state: state => transition(runId, state), context: { runId, workspaceRoot: root, gateway, inputSources, resultStore: new RunResultStore(runId), policyGuard: new MutationPolicyGuard(), envelope: buildExecutionEnvelope({ runId, mode: "agent", modelId: "live-driver", hasWorkspace: true, workspaceRoot: root }), emitRunEvent: emit } }));
      const output = path.join(root, "runs", runId, "output", "summary.md");
      const exported = existsSync(output) ? readFileSync(output, "utf8") : null;
      const store = new RunResultStore(runId);
      const records = store.listResults({ limit: 50 });
      for (let offset = 50; records.length === offset; offset += 50) records.push(...store.listResults({ limit: 50, offset }));
      const savedResults = records.map(record => {
        let content = "", offset: number | undefined = 0;
        while (offset !== undefined) { const page = store.retrieveResultSlice(record.resultId, { mode: "text", offset, maxChars: 3000 }); content += page.content; offset = page.nextOffset; }
        return { record, content };
      });
      const proof = { recordedAt: new Date().toISOString(), model, contextLimit: 8192, result, admissions: getExecutionLedger(runId)?.agentAdmissions, progress: getExecutionLedger(runId)?.agentProgress, requirements: getCurrentAgentTask(chatId)?.snapshot.requirements, approvals, exported, noteUnchanged: readFileSync(path.join(root, "note.txt"), "utf8") === "saved source\n", savedResults };
      if (process.env.WORKBENCH_AGENT_DOCUMENT_PROBE_REPORT) writeFileSync(process.env.WORKBENCH_AGENT_DOCUMENT_PROBE_REPORT, JSON.stringify(proof, null, 2));
      expect(result.outcome, result.text).toBe("completed");
      expect(exported).toContain("P-204");
      expect(approve).toHaveBeenCalledTimes(1);
      expect(proof.noteUnchanged).toBe(true);
    } finally { clearTimeout(timeout); }
  }, 260000);
  it("routes an opted-in preview through RunManager and exposes the durable task snapshot", async () => {
    const text = "Inspect note.txt";
    replies = [() => interpretation("inspect", text), () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "Inspected the saved source.", payload => {
      const state = packetState(payload.messages[1].content); return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Source evidence saved" })) };
    }];
    const { result, runId, snapshot } = await run(text, true);
    expect(result.outcome, result.text).toBe("completed");
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeLessThanOrEqual(8);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeGreaterThan(0);
    expect(getCurrentAgentTask(chatId)?.status).toBe("completed");
    expect(snapshot?.agentV3Available).toBe(true);
    expect(snapshot?.agentTaskFacts).toMatchObject({changesApplied:[],remainingRequirements:[]});
  });
  it("keeps task continuity visible after a Chat run and does not enable v3 from historical engine data", async () => {
    const text = "Inspect note.txt";
    replies = [() => interpretation("inspect", text), () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "saved source", payload => {
      const state = packetState(payload.messages[1].content); return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Source read" })) };
    }];
    const first = await run(text, true), taskId = getCurrentAgentTask(chatId)!.taskId;
    const question = "Give a short explanation.", messageId = addMessage({ chat_id: chatId, role: "user", content: question }).id;
    replies = [() => "A direct Chat answer."];
    const next = await first.manager!.start({ chatId, userMessageId: messageId, userText: question, mode: "chat", selectedModel: "driver" });
    await vi.waitFor(() => expect(first.manager!.getRunSnapshot({ runId: next.runId })?.state).toBe("completed"), { timeout: 10000 });
    expect(first.manager!.getRunSnapshot({ runId: next.runId })).toMatchObject({ mode: "chat", agentV3Available: true, agentTask: { taskId } });
    const closed = new RunManager(first.manager!.getGateway());
    expect(closed.getRunSnapshot({ runId: first.runId })).toMatchObject({ engineVersion: "agent-v3", agentV3Available: false });
  });
  it("counts interpretation, reads once, performs a separate review, and completes an evidenced inspection", async () => {
    const text = "Inspect note.txt";
    replies = [() => interpretation("inspect", text), () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "The source was inspected.", payload => {
      const state = packetState(payload.messages[1].content);
      expect(state.evidenceSlices).toContainEqual(expect.objectContaining({ sourceText: "saved source\n", completeFile: true }));
      expect(state.sourceComparisons).toContainEqual(expect.objectContaining({ completeFile: true, current: true, exactTextIncluded: false }));
      expect(state.results.items.every((item: any) => ["source_extracted", "execution"].includes(item.origin))).toBe(true);
      return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Saved source was read" })) };
    }];
    const { result, runId, emit } = await run(text);
    expect(result.outcome, `${result.text}\n${JSON.stringify(emit.mock.calls)}`).toBe("completed");
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeLessThanOrEqual(8);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeGreaterThan(0);
    expect(getExecutionLedger(runId)?.agentAdmissions[0]).toMatchObject({ phase: "requirements", status: "usage_verified" });
    expect(getExecutionLedger(runId)?.agentAdmissions[0]).toMatchObject({taskId:getCurrentAgentTask(chatId)!.taskId,taskRevision:1});
    expect(getExecutionLedger(runId)?.agentProgress?.reads[0].path).toBe("note.txt");
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements).toHaveLength(1);
  });
  it("does not complete a repair with advice or convert Markdown into actions", async () => {
    const text = "Repair note.txt";
    replies = [() => interpretation("change", text), () => '```json\n{"tool_calls":[{"name":"write_file","arguments":{"path":"note.txt","content":"fragment"}}]}\n```', () => "Here is more advice."];
    const { result, approve } = await run(text);
    expect(result.outcome).toBe("partial"); expect(approve).not.toHaveBeenCalled();
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("saved source\n");
  });
  it("rejects a fenced action and permits one corrected bare action without executing the example", async () => {
    const text = "Inspect note.txt";
    replies = [() => interpretation("inspect", text), () => '```json\n{"tool_calls":[{"name":"write_file","arguments":{"path":"note.txt","content":"bad"}}]}\n```',
      () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "saved source", payload => {
        const state = packetState(payload.messages[1].content); return { covered: true, missing: [], requirements: state.requirements.map((item: any) => ({ id: item.id, satisfied: true, reason: "Saved source was read" })) };
      }];
    const { result, approve, runId } = await run(text);
    expect(result.outcome).toBe("completed"); expect(approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(runId)?.agentTask?.protocolCorrections).toBe(1);
    expect(getExecutionLedger(runId)?.agentProgress?.actions.map(action => action.operation)).toEqual(["read_file"]);
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("saved source\n");
  });
  it("answers a status follow-up without workspace actions and retains earlier requirements", async () => {
    replies = [() => interpretation("change", "Repair note.txt"), () => "Pending repair", () => "Still pending"];
    await run("Repair note.txt");
    const original = getCurrentAgentTask(chatId)!.snapshot.requirements;
    replies = [() => ({ disposition: "status", requirements: [], updates: [], full_suite: false }), () => "Repair is still pending. No checks have passed."];
    const { result, emit, approve } = await run("What is the status?");
    expect(result.outcome).toBe("completed"); expect(result.stopReason).toBe("status_reply"); expect(approve).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([event]) => event.type === "tool_call")).toBe(false);
    expect(getCurrentAgentTask(chatId)!.snapshot.requirements).toEqual(original);
    expect(getCurrentAgentTask(chatId)!.status).toBe("partial");
  });
  it("keeps inspection read-only even when a valid observed edit is proposed", async () => {
    const text = "Inspect note.txt and reproduce the failure without edits";
    fileScopeReplies=[payload=>{const input=packetState(payload.messages[1].content);expect(input.userInstruction.quote).toBe(text);return {withinScope:false,reason:"The user requested inspection only."};}];
    replies = [() => interpretation("execute", text), () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }),()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"broken"}]}}]})];
    const { result, approve } = await run(text);
    expect(result.outcome).toBe("partial");expect(result.stopReason).toBe("action_outside_task");expect(approve).not.toHaveBeenCalled();
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it.each([true,false])("assesses a mixed execute repair against its source and requires concrete approval=%s",async approved=>{
    const request="Reproduce the failure, then repair note.txt by replacing source with content.";
    fileScopeReplies=[payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.userInstruction.quote).toBe(request);expect(input).not.toHaveProperty("operation");
      return {withinScope:true,reason:"The quoted instruction requests the concrete repair."};
    }];
    replies=[()=>interpretation("execute",request),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]}),()=>({tool_calls:[{name:"finish",arguments:{text:"The repair is saved; tests are unavailable."}}]})];
    const {result,runId,approve}=await run(request,false,async()=>approved);
    expect(approve).toHaveBeenCalledTimes(1);expect(getCurrentAgentTask(chatId)?.snapshot.requirements.map(item=>item.kind)).toEqual(["execute"]);
    expect(result.stopReason,result.text).toBe(approved ? "checks_unavailable" : "approval_denied");
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe(approved ? "saved content\n" : "saved source\n");
    const records=new RunResultStore(runId).listResults({limit:50});
    expect(records.find(record=>record.producer.tool === "agent_file_scope_review")?.origin).toBe("model_derived");
    expect(records.some(record=>record.producer.tool === "edit_file")).toBe(approved);
  });
  it("honors cancellation during scope assessment before approval or mutation",async()=>{
    const controller=new AbortController();runSignal=controller.signal;
    fileScopeReplies=[()=>{controller.abort();return {withinScope:true,reason:"The requested edit is related."};}];
    replies=[()=>interpretation("change","Repair note.txt"),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]})];
    const {result,approve}=await run("Repair note.txt");expect(result.outcome).toBe("cancelled");expect(approve).not.toHaveBeenCalled();
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it("reuses source-bound scope and rejects a later protected target before approval",async()=>{
    writeFileSync(path.join(root,"protected.txt"),"keep source\n");
    const request="Repair note.txt only. Do not edit protected.txt.";let scopeCalls=0;
    fileScopeReplies=[payload=>{scopeCalls++;expect(packetState(payload.messages[1].content)).not.toHaveProperty("operation");return {scope:"paths",operations:["edit_file"],paths:["note.txt"],protected_paths:["protected.txt"],reason:"The source limits edits to note.txt"};}];
    const read=(file:string)=>()=>({tool_calls:[{name:"read_file",arguments:{path:file}}]});
    const edit=(file:string,source:string)=>()=>({tool_calls:[{name:"edit_file",arguments:{path:file,expected_digest:createHash("sha256").update(source).digest("hex"),replacements:[{old:"source",new:"content"}]}}]});
    replies=[()=>interpretation("change",request),read("note.txt"),edit("note.txt","saved source\n"),read("protected.txt"),edit("protected.txt","keep source\n")];
    const {result,runId,approve}=await run(request);
    expect(result.stopReason,result.text).toBe("action_outside_task");expect(scopeCalls).toBe(1);expect(approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(runId)?.agentProgress?.fileScopes).toHaveLength(1);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved content\n");expect(readFileSync(path.join(root,"protected.txt"),"utf8")).toBe("keep source\n");
  });
  it("rejects fabricated scope paths before concrete approval",async()=>{
    const request="Repair note.txt";
    fileScopeReplies=[()=>({scope:"paths",operations:["edit_file"],paths:["invented.txt"],protected_paths:[],reason:"Unsupported path claim"})];
    replies=[()=>interpretation("change",request),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]})];
    const {result,runId,approve}=await run(request);
    expect(result.stopReason,result.text).toBe("action_scope_unverified");expect(approve).not.toHaveBeenCalled();expect(getExecutionLedger(runId)?.agentProgress?.fileScopes).toHaveLength(0);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it("rejects new external dependencies before semantic scope assessment or approval",async()=>{
    const request="Create app.js. Do not add dependencies.";
    const proposal=()=>({tool_calls:[{name:"write_file",arguments:{path:"app.js",content:'import dependency from "new-package";\n'}}]});
    replies=[()=>({disposition:"continue",requirements:[{kind:"change",description:"Create app.js",source_id:"s1",checks:[{description:"Create app.js",kind:"review",operation:"semantic",path:null}]},{kind:"preserve",description:"Do not add dependencies",source_id:"s2",checks:[{description:"No added dependencies",kind:"review",operation:"semantic",path:null}]}],updates:[],full_suite:false}),proposal,proposal];
    const {result,runId,approve}=await run(request);
    expect(result.outcome).toBe("partial");expect(approve).not.toHaveBeenCalled();expect(existsSync(path.join(root,"app.js"))).toBe(false);
    const records=new RunResultStore(runId).listResults({limit:50});
    expect(records.some(record=>record.producer.tool === "agent_file_scope_input")).toBe(false);
    expect(getExecutionLedger(runId)?.agentProgress?.actions.every(action=>action.status === "failed")).toBe(true);
  });
  it("does not approve or count an unchanged existing-file replacement as a saved change",async()=>{
    const request="Replace note.txt with the required saved source";
    const proposal=()=>({tool_calls:[{name:"write_file",arguments:{path:"note.txt",content:"saved source\n",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replace_existing:true}}]});
    replies=[()=>interpretation("change",request),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),proposal,proposal];
    const {result,runId,approve}=await run(request);
    expect(result.stopReason,result.text).toBe("repeated_action");expect(approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(runId)?.completedOperations.some(operation=>operation.tool === "write_file")).toBe(false);
    expect(existsSync(path.join(root,".harness_backups"))).toBe(false);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it("blocks a malformed file scope assessment before requesting approval",async()=>{
    fileScopeReplies=[()=>"invalid scope response"];
    replies=[()=>interpretation("change","Repair note.txt"),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]})];
    const {result,approve}=await run("Repair note.txt");expect(result.stopReason).toBe("action_scope_unverified");expect(approve).not.toHaveBeenCalled();
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it("binds command approval to the shown source and stops when it changes during approval", async () => {
    const text = "Inspect note.txt with a command";
    replies = [() => interpretation("inspect", text), () => ({ tool_calls: [{ name: "run_command", arguments: { command: "cat note.txt" } }] })];
    const { result, runId, approve } = await run(text, false, async preview => {
      expect(JSON.parse(preview.split("\n\n")[0])).toMatchObject({ operation: "run_command", sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/) });
      writeFileSync(path.join(root,"note.txt"),"EXTERNAL");
      return true;
    });
    expect(result.outcome).toBe("partial"); expect(result.text).toContain("changed while approval was pending");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(runId)?.operationAttempts).toHaveLength(0);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("EXTERNAL");
  });
  it("corrects literal delivery from saved evidence without another read and audits scope separately", async () => {
    const text = "Read note.txt and report its exact content.";
    replies = [() => ({ disposition: "continue", requirements: [{ kind: "inspect", description: text, source_id: "request", checks: [{ description: text, kind: "inspection", operation: "verbatim_source", path: "note.txt" }] }], updates: [], full_suite: false }),
      () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "saved source", () => "```\nsaved source\n```", payload => {
        const input = packetState(payload.messages[1].content);
        expect(input.hostVerifiedChecks).toContainEqual(expect.objectContaining({ passed: true, path: "note.txt" }));
        return { covered: true, missing: [] };
      }];
    const { result, runId, approve } = await run(text);
    expect(result.outcome, result.text).toBe("completed"); expect(approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(runId)?.agentProgress?.actions.map(action => action.operation)).toEqual(["read_file"]);
    expect(getExecutionLedger(runId)?.agentProgress?.deliveryAttempts).toHaveLength(2);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeLessThanOrEqual(8);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeGreaterThan(0);
  });
  it("stops a repeated literal delivery proposal without repeatedly reading unchanged source", async () => {
    const text = "Read note.txt and report its exact content.";
    replies = [() => ({ disposition: "continue", requirements: [{ kind: "inspect", description: text, source_id: "request", checks: [{ description: text, kind: "inspection", operation: "verbatim_source", path: "note.txt" }] }], updates: [], full_suite: false }),
      () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }), () => "wrong content", () => "wrong content"];
    const { result, runId } = await run(text);
    expect(result.outcome).toBe("partial"); expect(result.stopReason).toBe("repeated_delivery");
    expect(getExecutionLedger(runId)?.agentProgress?.actions).toHaveLength(1);
  });
  it("keeps an approved observed edit and returns Partial when mandatory project tests are unavailable", async () => {
    const text = "Read note.txt, replace source with content, and run existing tests.";
    const digest = createHash("sha256").update("saved source\n").digest("hex");
    replies = [() => ({ disposition: "continue", requirements: ["inspect", "change", "execute"].map(kind => ({ kind, description: kind, source_id: "request", checks: [{ description: kind, kind: kind === "execute" ? "execution" : "inspection", operation: "semantic", path: null }] })), updates: [], full_suite: false }),
      () => ({ tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }] }),
      () => ({ tool_calls: [{ name: "edit_file", arguments: { path: "note.txt", expected_digest: digest, replacements: [{ old: "source", new: "content" }] } }] }),
      () => ({ tool_calls: [{ name: "finish", arguments: { text: "The edit is saved. Tests are still required." } }] })];
    const { result, runId, approve } = await run(text);
    expect(result.outcome, result.text).toBe("partial"); expect(result.stopReason).toBe("checks_unavailable");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(root, "note.txt"), "utf8")).toBe("saved content\n");
    expect(getExecutionLedger(runId)?.completedOperations.some(item => item.tool === "edit_file")).toBe(true);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements).toHaveLength(3);
  });
  it("permits an approved edit when Node is missing and does not retry the unchanged unavailable test command",async()=>{
    const {workspace}=failingWorkspace(),text="Repair value.cjs and run existing tests.";
    const original=childProcesses.executeProcess;
    const commands:string[]=[];
    vi.spyOn(childProcesses,"executeProcess").mockImplementation(async(binary,args,options)=>{
      const command=String(args.at(-1));commands.push(command);
      if(command === "node --version")throw new Error("node not found");
      return original(binary,args,options);
    });
    const source=readFileSync(path.join(workspace,"value.cjs"),"utf8");
    replies=[()=>({disposition:"continue",requirements:["change","execute"].map(kind=>({kind,description:kind,source_id:"request",checks:[{description:kind,kind:kind === "execute"?"execution":"review",operation:"semantic",path:null}]})),updates:[],full_suite:false}),
      ()=>({tool_calls:[{name:"read_file",arguments:{path:"value.cjs"}}]}),
      ()=>({tool_calls:[{name:"edit_file",arguments:{path:"value.cjs",expected_digest:createHash("sha256").update(source).digest("hex"),replacements:[{old:source,new:"exports.readValue = () => 42;\n"}]}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"Applied the code edit; tests need Node."}}]})];
    const saved=await run(text,false,async()=>true,undefined,workspace);
    expect(saved.result.outcome,saved.result.text).toBe("partial");expect(saved.result.stopReason).toBe("checks_unavailable");
    expect(commands.filter(command=>command === "node --version")).toHaveLength(1);
    expect(commands.some(command=>command.startsWith("npm test"))).toBe(false);
    expect(readFileSync(path.join(workspace,"value.cjs"),"utf8")).toBe("exports.readValue = () => 42;\n");
    expect(getExecutionLedger(saved.runId)?.agentProgress?.baseline).toMatchObject({status:"stop",reason:"test_runtime_unavailable"});
    expect(getExecutionLedger(saved.runId)?.verification?.repairCount).toBe(0);
    expect(saved.approve).toHaveBeenCalledTimes(2);
  });
  it("carries applied changes into a follow-up without forcing another edit or importing old tests", async () => {
    const text="Read note.txt, replace source with content, and run existing tests.";
    replies=[()=>({disposition:"continue",requirements:["change","execute"].map(kind=>({kind,description:kind,source_id:"request",checks:[{description:kind,kind:kind === "execute"?"execution":"review",operation:"semantic",path:null}]})),updates:[],full_suite:false}),
      ()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),
      ()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"Saved; tests unavailable."}}]})];
    const first=await run(text);expect(first.result.stopReason).toBe("checks_unavailable");
    replies=[()=>({disposition:"evidence",requirements:[],updates:[],full_suite:false}),payload=>{
      const state=packetState(payload.messages[1].content);
      expect(state.appliedOperations).toContainEqual(expect.objectContaining({path:"note.txt",originRunId:first.runId,historical:true}));
      expect(payload.response_format.json_schema.schema.properties.tool_calls.items.anyOf.flatMap((tool:any)=>tool.properties.name.enum)).toContain("finish");
      return {tool_calls:[{name:"finish",arguments:{text:"The earlier edit is saved. Required tests remain unavailable."}}]};
    }];
    const next=await run("The tests are still unavailable.");
    expect(next.result.stopReason,next.result.text).toBe("checks_unavailable");expect(next.approve).not.toHaveBeenCalled();
    expect(next.result.text).toContain("earlier attempt");
    const facts=savedAgentTaskFacts(getCurrentAgentTask(chatId)!);
    expect(facts.changesApplied).toContainEqual(expect.objectContaining({path:"note.txt",originRunId:first.runId,historical:true}));
    expect(facts.checksPassed).toEqual([]);expect(facts.checksUnavailable.length).toBeGreaterThan(0);
    expect(facts.remainingRequirements).toHaveLength(2);
    expect(getExecutionLedger(next.runId)?.completedOperations).toEqual([]);
    expect(getExecutionLedger(next.runId)?.verification?.evidence.some(check=>check.status === "passed")).toBe(false);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved content\n");
  });
  it("tracks approved command-published files across attempts and checks their current bytes",async()=>{
    const request="Repair note.txt using a command", workspace=path.join(root,"project");
    mkdirSync(workspace);writeFileSync(path.join(workspace,"note.txt"),"saved source\n");
    replies=[()=>interpretation("change",request),()=>({tool_calls:[{name:"run_command",arguments:{command:"printf 'saved content\\n' > note.txt"}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"The requested change is saved."}}]}),payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The command saved the repair."}))};}];
    const first=await run(request,false,undefined,undefined,workspace);
    expect(first.result.outcome,first.result.text).toBe("completed");expect(first.approve).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(workspace,"note.txt"),"utf8")).toBe("saved content\n");
    const operation=getExecutionLedger(first.runId)!.completedOperations.find(item=>item.tool === "run_command")!;
    const record=new RunResultStore(first.runId).getResult(operation.resultIds[0]);
    const published=JSON.parse(new RunResultStore(first.runId).readResultPayload(record.resultId)).publishedChanges;
    expect(published).toEqual([expect.objectContaining({path:"note.txt",beforeDigest:createHash("sha256").update("saved source\n").digest("hex"),afterDigest:createHash("sha256").update("saved content\n").digest("hex"),backupPath:expect.stringContaining(".harness_backups")})]);
    replies=[()=>({disposition:"evidence",requirements:[],updates:[],full_suite:false}),payload=>{
      expect(packetState(payload.messages[1].content).appliedOperations).toContainEqual(expect.objectContaining({path:"note.txt",originRunId:first.runId,historical:true}));
      return {tool_calls:[{name:"finish",arguments:{text:"The earlier command change remains saved."}}]};
    },payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Saved command result"}))};}];
    const next=await run("Continue",false,undefined,undefined,workspace);expect(next.result.outcome,next.result.text).toBe("completed");expect(next.approve).not.toHaveBeenCalled();
    expect(getExecutionLedger(next.runId)?.completedOperations).toEqual([]);
    expect(savedAgentTaskFacts(getCurrentAgentTask(chatId)!).changesApplied).toContainEqual(expect.objectContaining({path:"note.txt",originRunId:first.runId,historical:true}));
    replies=[()=>({disposition:"evidence",requirements:[],updates:[],full_suite:false}),()=>({tool_calls:[{name:"finish",arguments:{text:"The command change remains saved."}}]}),payload=>{
      const state=packetState(payload.messages[1].content);chmodSync(path.join(workspace,"note.txt"),0o600);
      return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Saved command result"}))};
    },payload=>{expect(packetState(payload.messages[1].content).feedback.text).toContain("changed during review");return {tool_calls:[{name:"finish",arguments:{text:"The command change remains saved."}}]};}];
    const stale=await run("Continue again",false,undefined,undefined,workspace);
    expect(stale.result.outcome).toBe("partial");expect(stale.approve).not.toHaveBeenCalled();
  });
  it("blocks replay when command publication has an uncertain outcome",async()=>{
    const workspace=path.join(root,"project");mkdirSync(workspace);writeFileSync(path.join(workspace,"note.txt"),"saved source\n");
    vi.spyOn(commandExecutor,"runCommand").mockRejectedValue({code:"persistence_failure",retryable:false,message:"Command publication may be incomplete."});
    const request="Repair note.txt using a command";
    replies=[()=>interpretation("change",request),()=>({tool_calls:[{name:"run_command",arguments:{command:"printf repaired > note.txt"}}]})];
    const attempted=await run(request,false,undefined,undefined,workspace);
    expect(attempted.result.stopReason).toBe("uncertain_mutation");
    expect(getExecutionLedger(attempted.runId)?.agentProgress?.actions).toContainEqual(expect.objectContaining({operation:"run_command",status:"uncertain"}));
    updateExecutionLedgerState(attempted.runId,"partial");
    expect(()=>assertExecutionCanResume(attempted.runId)).toThrow("uncertain Agent mutation");
  });
  it("reviews a prior task change against current bytes and rejects changes during review", async () => {
    const request="Repair note.txt";
    replies=[()=>interpretation("change",request),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),
      ()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"Saved the edit."}}]}),payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Saved change"}))};}];
    const first=await run(request);expect(first.result.outcome,first.result.text).toBe("completed");
    replies=[()=>({disposition:"evidence",requirements:[],updates:[],full_suite:false}),()=>({tool_calls:[{name:"finish",arguments:{text:"The edit remains saved."}}]}),payload=>{
      const state=packetState(payload.messages[1].content);
      expect(state.results.items).toContainEqual(expect.objectContaining({tool:"edit_file",originRunId:first.runId,historical:true}));
      writeFileSync(path.join(root,"note.txt"),"external change\n");
      return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Saved change"}))};
    },payload=>{expect(packetState(payload.messages[1].content).feedback.text).toContain("changed during review");return {tool_calls:[{name:"finish",arguments:{text:"The edit remains saved."}}]};}];
    const next=await run("Continue");
    expect(next.result.outcome).toBe("partial");expect(next.approve).not.toHaveBeenCalled();
    expect(next.result.stopReason).toBe("repeated_action");
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("external change\n");
  });
  it("requires action while a repair is pending and checks delivery before spending another test attempt", async () => {
    const text = "Repair note.txt and run existing tests.";
    replies = [()=>({disposition:"continue",requirements:["change","execute"].map(kind=>({kind,description:kind,source_id:"request",checks:[{description:kind,kind:kind === "execute"?"execution":"review",operation:"semantic",path:null}]})),updates:[],full_suite:false}),
      payload=>{
        const schema = payload.response_format.json_schema.schema.properties.tool_calls;
        expect(schema.minItems).toBe(1);expect(schema.items.anyOf.flatMap((tool:any)=>tool.properties.name.enum)).not.toContain("finish");
        return "I will repair the file and run tests.";
      },()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),
      ()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]}),
      payload=>{expect(payload.response_format.json_schema.schema.properties.tool_calls.items.anyOf.flatMap((tool:any)=>tool.properties.name.enum)).toContain("finish");return {tool_calls:[{name:"finish",arguments:{text:"The edit is saved; testing remains unavailable."}}]};}];
    const {result,runId,approve} = await run(text);
    expect(result.stopReason,result.text).toBe("checks_unavailable");expect(approve).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved content\n");
    expect(getExecutionLedger(runId)?.verification?.repairCount).toBe(0);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeLessThanOrEqual(8);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeGreaterThan(0);
  });
  it("provides complete structured directory observations without nested JSON text", async () => {
    const text = "Inspect note.txt";
    replies = [()=>interpretation("inspect",text),()=>({tool_calls:[{name:"list_dir",arguments:{path:"."}}]}),payload=>{
      const input = packetState(payload.messages[1].content);
      expect(input.latestResult.completeResult).toBe(true);
      expect(input.latestResult.value.entries).toContainEqual(expect.objectContaining({name:"note.txt"}));
      expect(input.latestResult.content).toBeUndefined();
      return {tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]};
    },()=>"The source was inspected.",payload=>{const input=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:input.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Source evidence saved."}))};}];
    const {result} = await run(text);
    expect(result.outcome,result.text).toBe("completed");
  });
  it("carries active capability state and directory evidence across a later fresh request", async()=>{
    const text="Inspect note.txt";
    replies=[()=>interpretation("inspect",text),()=>({tool_calls:[{name:"list_dir",arguments:{path:"."}}]}),()=>({tool_calls:[{name:"request_capability",arguments:{capability:"document_processing"}}]}),payload=>{
      const input=packetState(payload.messages[1].content);
      expect(input.activeCapabilities).toContain("document_processing");
      expect(input.availableCapabilities.some((item:any)=>item.name === "document_processing")).toBe(false);
      expect(input.directoryEvidence.entries).toContainEqual(expect.objectContaining({name:"note.txt",type:"file"}));
      const choice=payload.response_format.json_schema.schema.properties.tool_calls.items.anyOf.find((item:any)=>item.properties.name.enum[0] === "request_capability");
      expect(choice.properties.arguments.properties.capability.enum).not.toContain("document_processing");
      return {tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]};
    },()=>"Source inspected.",payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Source read"}))};}];
    const {result,approve}=await run(text);
    expect(result.outcome,result.text).toBe("completed");expect(approve).not.toHaveBeenCalled();
  });
  it("keeps a partial source eligible, then reopens a fully observed source after an edit",async()=>{
    const text="Repair the head of note.txt",source="head\n"+"x".repeat(180)+"\nend\n";
    writeFileSync(path.join(root,"note.txt"),source);
    const readChoice=(payload:any)=>payload.response_format.json_schema.schema.properties.tool_calls.items.anyOf.find((tool:any)=>tool.properties.name.enum[0] === "read_file").properties.arguments.properties.path.enum;
    replies=[()=>interpretation("change",text),()=>({tool_calls:[{name:"list_dir",arguments:{path:"."}}]}),()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt",max_bytes:64}}]}),payload=>{
      expect(readChoice(payload)).toContain("note.txt");
      const state=packetState(payload.messages[1].content);
      return {tool_calls:[{name:"read_file",arguments:{path:"note.txt",cursor:state.latestResult.nextCursor}}]};
    },payload=>{
      expect(readChoice(payload)).not.toContain("note.txt");
      return {tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update(source).digest("hex"),replacements:[{old:"head",new:"fixed"}]}}]};
    },payload=>{expect(readChoice(payload)).toContain("note.txt");return {tool_calls:[{name:"finish",arguments:{text:"The requested head edit is saved."}}]};},
    payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The inspected head edit is saved."}))};}];
    const {result}=await run(text);
    expect(result.outcome,result.text).toBe("completed");expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe(source.replace("head","fixed"));
  });
  it("retains earlier source bytes across another read and removes stale pages after an edit",async()=>{
    const first="saved source\n", second="café 🛠️\nsecond source\n";
    writeFileSync(path.join(root,"other.txt"),second);
    const digest=createHash("sha256").update(first).digest("hex");
    replies=[()=>interpretation("change","Repair note.txt and preserve other.txt"),
      ()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),
      ()=>({tool_calls:[{name:"read_file",arguments:{path:"other.txt"}}]}),payload=>{
        const state=packetState(payload.messages[1].content);
        expect(state.latestResult.content).toBe(second);
        expect(state.selectedSources.pages).toContainEqual(expect.objectContaining({path:"note.txt",content:first,digest,complete:true,startByte:0,endByte:Buffer.byteLength(first)}));
        return {tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:digest,replacements:[{old:"source",new:"content"}]}}]};
      },payload=>{
        const state=packetState(payload.messages[1].content);
        expect(state.selectedSources.pages.map((page:any)=>page.path)).not.toContain("note.txt");
        expect(state.selectedSources.pages).toContainEqual(expect.objectContaining({path:"other.txt",content:second}));
        expect(state.latestResult.value.afterDigest).not.toBe(digest);
        return {tool_calls:[{name:"finish",arguments:{text:"The text edit is saved; other.txt is preserved."}}]};
      },payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The inspected text edit is saved."}))};}];
    const {result,runId}=await run("Repair note.txt and preserve other.txt");
    expect(result.outcome,result.text).toBe("completed");
    expect(getExecutionLedger(runId)?.agentProgress?.reads.filter(read=>read.path === "note.txt")).toHaveLength(2);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved content\n");
    expect(readFileSync(path.join(root,"other.txt"),"utf8")).toBe(second);
  });
  it("removes whole optional source pages after context rejection without consuming a model call or losing requirements",async()=>{
    writeFileSync(path.join(root,"other.txt"),"other source\n");
    const original=ModelGateway.prototype.chatWithTools;
    const rejected:any[]=[],dispatched:any[]=[];
    vi.spyOn(ModelGateway.prototype,"chatWithTools").mockImplementation(async function(this:ModelGateway,modelId,messages,tools,options){
      const state=packetState(messages[1]?.content ?? "{}");
      if (state.selectedSources?.totalEligiblePages) {
        if (state.selectedSources.pages.length) {
          rejected.push(state);
          return {ok:false,error:{kind:"ai-error",code:"agent_context_limit",message:"Exact prepared request exceeds context",retryable:false}};
        }
        dispatched.push(state);
      }
      return original.call(this,modelId,messages,tools,options);
    });
    replies=[()=>interpretation("change","Repair note.txt and preserve other.txt"),
      ()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),
      ()=>({tool_calls:[{name:"read_file",arguments:{path:"other.txt"}}]}),
      ()=>({tool_calls:[{name:"edit_file",arguments:{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}}]}),
      ()=>({tool_calls:[{name:"finish",arguments:{text:"Edit saved."}}]}),
      payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Text edit saved."}))};}];
    const {result,runId}=await run("Repair note.txt and preserve other.txt");
    expect(result.outcome,result.text).toBe("completed");
    expect(rejected).toHaveLength(4);expect(dispatched).toHaveLength(2);
    expect(dispatched[0].latestResult).toEqual(rejected[0].latestResult);
    expect(dispatched[0].obligations).toEqual(rejected[0].obligations);
    expect(dispatched[0].originalRequest).toEqual(rejected[0].originalRequest);
    expect(dispatched[0].selectedSources).toMatchObject({pages:[],complete:false,totalEligiblePages:1});
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeLessThanOrEqual(12);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeGreaterThan(0);
    // The omitted old page was supplied on its own earlier request, never forged by packing.
    expect(getExecutionLedger(runId)?.agentProgress?.reads.filter(read=>read.path === "note.txt")).toHaveLength(1);
  });
  it("repages the latest source after admission rejection and cannot authorize its omitted edit anchor",async()=>{
    const source="top\n"+"é".repeat(1200)+"\nTAIL_ANCHOR\n"+"z".repeat(1800)+"\nend\n";
    writeFileSync(path.join(root,"large.txt"),source);
    const digest=createHash("sha256").update(source).digest("hex"),original=ModelGateway.prototype.chatWithTools;
    let rejected=0;
    vi.spyOn(ModelGateway.prototype,"chatWithTools").mockImplementation(async function(this:ModelGateway,modelId,messages,tools,options){
      const state=packetState(messages[1]?.content ?? "{}");
      if(state.latestResult?.sourcePage && state.latestResult.endByte-state.latestResult.startByte>2000){rejected++;return {ok:false,error:{kind:"ai-error",code:"agent_context_limit",message:"Prepared source page exceeds the input budget",retryable:false}};}
      return original.call(this,modelId,messages,tools,options);
    });
    const edit=()=>({tool_calls:[{name:"edit_file",arguments:{path:"large.txt",expected_digest:digest,replacements:[{old:"TAIL_ANCHOR",new:"REPAIRED"}]}}]});
    replies=[()=>interpretation("change","Repair the tail anchor in large.txt"),()=>({tool_calls:[{name:"read_file",arguments:{path:"large.txt",max_bytes:4000}}]}),payload=>{
      const state=packetState(payload.messages[1].content);
      expect(state.latestResult).toMatchObject({startByte:0,endByte:2000,complete:false,digest});
      expect(state.latestResult.content).not.toContain("TAIL_ANCHOR");
      return edit();
    },payload=>{
      const state=packetState(payload.messages[1].content);
      expect(state.feedback.text).toContain("outside the source ranges");expect(readFileSync(path.join(root,"large.txt"),"utf8")).toBe(source);
      return {tool_calls:[{name:"read_file",arguments:{path:"large.txt",cursor:state.latestResult.nextCursor,max_bytes:4000}}]};
    },payload=>{
      const state=packetState(payload.messages[1].content);
      expect(state.latestResult).toMatchObject({startByte:2000,endByte:4000,complete:false,digest});
      expect(state.latestResult.content).toContain("TAIL_ANCHOR");return edit();
    },()=>({tool_calls:[{name:"finish",arguments:{text:"The exact tail replacement is saved."}}]}),payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The observed tail anchor was replaced."}))};}];
    const {result,runId,approve}=await run("Repair the tail anchor in large.txt");
    expect(result.outcome,result.text).toBe("completed");expect(rejected).toBe(9);expect(approve).toHaveBeenCalledTimes(1);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeLessThanOrEqual(12);
    expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeGreaterThan(0);
    expect(getExecutionLedger(runId)?.agentProgress?.reads.map(read=>[read.startByte,read.endByte])).toEqual([[0,2000],[0,2000],[2000,4000]]);
    expect(readFileSync(path.join(root,"large.txt"),"utf8")).toBe(source.replace("TAIL_ANCHOR","REPAIRED"));
  });
  it("repacks actual counted requests under a smaller verified server window before accepting any action",async()=>{
    runContextLimit=4096;
    const source="x ".repeat(1300)+"TAIL_ANCHOR\n"+"y ".repeat(100),digest=createHash("sha256").update(source).digest("hex");
    writeFileSync(path.join(root,"large.txt"),source);
    let attemptedUnseen=false,sawReduced=false,reviewCalls=0;const finalFeedback:string[]=[];
    const edit=()=>({tool_calls:[{name:"edit_file",arguments:{path:"large.txt",expected_digest:digest,replacements:[{old:"TAIL_ANCHOR",new:"REPAIRED"}]}}]});
    const next:Reply=payload=>{
      const state=packetState(payload.messages[1].content);
      if(state.proposedAnswer !== undefined){reviewCalls++;return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"The observed text edit is saved."}))};}
      if(state.latestResult?.tool === "edit_file"){finalFeedback.push(state.feedback.text);return {tool_calls:[{name:"finish",arguments:{text:"The observed tail replacement is saved."}}]};}
      const page=state.latestResult;
      expect(page.sourcePage).toBe(true);
      if(!attemptedUnseen){attemptedUnseen=true;sawReduced=page.endByte<4000;expect(page.content).not.toContain("TAIL_ANCHOR");return edit();}
      if(page.content.includes("TAIL_ANCHOR"))return edit();
      return {tool_calls:[{name:"read_file",arguments:{path:"large.txt",cursor:page.nextCursor,max_bytes:4000}}]};
    };
    replies=[()=>interpretation("change","Repair the tail in large.txt"),()=>({tool_calls:[{name:"read_file",arguments:{path:"large.txt",max_bytes:4000}}]}),...Array.from({length:12},()=>next)];
    const {result,runId,approve}=await run("Repair the tail in large.txt");
    expect(result.outcome,result.text+JSON.stringify({reviewCalls,finalFeedback})).toBe("completed");expect(sawReduced).toBe(true);expect(approve).toHaveBeenCalledTimes(1);
    const ledger=getExecutionLedger(runId)!;
    expect(ledger.agentTask?.modelCalls).toBe(ledger.agentAdmissions.length);
    expect(ledger.agentAdmissions.every(admission=>admission.status === "usage_verified" && admission.contextLimit === 4096 && admission.inputTokens+admission.outputTokens+admission.safetyTokens<=4096)).toBe(true);
    expect(ledger.agentProgress?.actions).toContainEqual(expect.objectContaining({operation:"edit_file",status:"failed"}));
    expect(reviewCalls).toBe(1);
    expect(readFileSync(path.join(root,"large.txt"),"utf8")).toBe(source.replace("TAIL_ANCHOR","REPAIRED"));
  });
  it("retains all essential task text and stops before dispatch when that state cannot fit",async()=>{
    runContextLimit=4096;
    const request="Inspect note.txt with this context: "+"context ".repeat(400);
    replies=[()=>interpretation("inspect",request)];
    const {result,runId,approve}=await run(request);
    expect(result.stopReason,result.text).toBe("context_limit");expect(result.text).toContain("Narrow the task");
    expect(approve).not.toHaveBeenCalled();expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeLessThanOrEqual(4);expect(getExecutionLedger(runId)?.agentTask?.modelCalls).toBeGreaterThan(0);
    expect(getExecutionLedger(runId)?.agentProgress?.actions).toEqual([]);
    expect(getCurrentAgentTask(chatId)?.snapshot.messages[0].content).toBe(request);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements[0].description).toBe(request);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved source\n");
  });
  it("rejects repeated capability activation without executing it and permits the one protocol correction",async()=>{
    const text="Inspect note.txt";
    const cap=()=>({tool_calls:[{name:"request_capability",arguments:{capability:"document_processing"}}]});
    replies=[()=>interpretation("inspect",text),cap,cap,()=>({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),()=>"Source inspected.",payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:state.requirements.map((item:any)=>({id:item.id,satisfied:true,reason:"Source read"}))};}];
    const {result,runId,emit}=await run(text);
    expect(result.outcome,result.text).toBe("completed");
    expect(emit.mock.calls.filter(([event])=>event.type === "capability_expanded")).toHaveLength(1);
    expect(getExecutionLedger(runId)?.agentTask?.protocolCorrections).toBe(1);
    expect(getExecutionLedger(runId)?.agentProgress?.actions.filter(action=>action.operation === "request_capability")).toHaveLength(1);
  });
  it("retains a repair focus across reads and several edits without consuming its test repair cycles", async () => {
    const text = "Inspect the sources, repair both notes, and run existing tests.";
    writeFileSync(path.join(root,"other.txt"),"other source\n");
    const edit = (filename: string, source: string) => ({ tool_calls: [{ name: "edit_file", arguments: { path: filename,
      expected_digest: createHash("sha256").update(source).digest("hex"), replacements: [{ old: "source", new: "content" }] } }] });
    const repairTurn = (answer: unknown) => (payload: any) => {
      const state = packetState(payload.messages[1].content);
      expect(state.currentRequirement.kind).toBe("change");
      expect(state.obligations.map((item: any) => item.kind)).toEqual(["inspect","change","execute"]);
      expect(state.unresolvedRequirementIds).toHaveLength(3);
      expect(state.sourceObservations.items).toContainEqual(expect.objectContaining({path:"note.txt",startByte:0,endByte:13,sizeBytes:13}));
      return answer;
    };
    replies = [() => ({ disposition: "continue", requirements: ["inspect","change","execute"].map(kind => ({kind,description:kind,source_id:"request",checks:[{description:kind,kind:kind === "execute" ? "execution" : "inspection",operation:"semantic",path:null}]})),updates:[],full_suite:false }),
      () => ({tool_calls:[{name:"read_file",arguments:{path:"note.txt"}}]}),
      repairTurn(edit("note.txt","saved source\n")),
      repairTurn({tool_calls:[{name:"read_file",arguments:{path:"other.txt"}}]}),
      repairTurn(edit("other.txt","other source\n")),
      repairTurn({tool_calls:[{name:"finish",arguments:{text:"Both edits are saved. Tests remain unavailable."}}]})];
    const {result,runId,approve} = await run(text);
    expect(result.outcome).toBe("partial"); expect(result.stopReason).toBe("checks_unavailable");
    expect(approve).toHaveBeenCalledTimes(2);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("saved content\n");
    expect(readFileSync(path.join(root,"other.txt"),"utf8")).toBe("other content\n");
    expect(getExecutionLedger(runId)?.verification?.repairCount).toBe(0);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements.every(item => item.state === "active")).toBe(true);
  });
  it("uses a separate coverage review to focus an unresolved repair while retaining all obligations", async () => {
    const text = "Repair note.txt. Repair other.txt.";
    writeFileSync(path.join(root,"other.txt"),"other source\n");
    let remainingId: string;
    const action = (name: string, args: object) => ({tool_calls:[{name,arguments:args}]});
    const edit = (filename: string, source: string) => action("edit_file",{path:filename,expected_digest:createHash("sha256").update(source).digest("hex"),replacements:[{old:"source",new:"content"}]});
    const remainingTurn = (answer: unknown) => (payload: any) => {
      const state = packetState(payload.messages[1].content);
      expect(state.currentRequirement.id).toBe(remainingId);
      expect(state.obligations).toHaveLength(2);
      return answer;
    };
    replies = [() => ({disposition:"continue",requirements:["Repair note.txt.","Repair other.txt."].map(quote => ({kind:"change",description:quote,source_id:"request",checks:[{description:quote,kind:"review",operation:"semantic",path:null}]})),updates:[],full_suite:false}),
      () => action("read_file",{path:"note.txt"}), () => edit("note.txt","saved source\n"), () => action("finish",{text:"First repair saved."}),
      payload => { const state = packetState(payload.messages[1].content); expect(state.requirements).toHaveLength(1); return {covered:true,missing:[],requirements:[{id:state.requirements[0].id,satisfied:true,reason:"First edit saved."}]}; },
      payload => {
        const state = packetState(payload.messages[1].content); expect(state.requirements).toHaveLength(1); remainingId = state.requirements[0].id;
        return {covered:false,missing:["Second repair remains."],requirements:[{id:remainingId,satisfied:false,reason:"Inspect and edit the second file."}]};
      }, remainingTurn(action("read_file",{path:"other.txt"})), remainingTurn(edit("other.txt","other source\n")), remainingTurn(action("finish",{text:"Both text repairs are saved."})),
      ...Array.from({length:2},()=> (payload:any) => { const state = packetState(payload.messages[1].content); expect(state.requirements).toHaveLength(1); return {covered:true,missing:[],requirements:state.requirements.map((item: any)=>({id:item.id,satisfied:true,reason:"Observed direct edit is saved."}))}; })];
    const {result,runId} = await run(text);
    expect(result.outcome,result.text).toBe("completed");
    expect(getExecutionLedger(runId)?.agentProgress?.remainingRequirementIds).toEqual([]);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements).toHaveLength(2);
    expect(readFileSync(path.join(root,"other.txt"),"utf8")).toBe("other content\n");
  });
  it.each(["write_file","delete_file"] as const)("checks the saved final revision for %s",async operation=>{
    const target=operation === "write_file" ? "new.txt" : "note.txt";
    const calls:Reply[]=[];
    if(operation === "delete_file")calls.push(()=>({tool_calls:[{name:"read_file",arguments:{path:target}}]}));
    calls.push(()=>({tool_calls:[{name:operation,arguments:operation === "write_file" ? {path:target,content:"new content\n"} : {path:target,expected_digest:createHash("sha256").update("saved source\n").digest("hex")}}]}));
    calls.push(()=>({tool_calls:[{name:"finish",arguments:{text:"The requested change is saved."}}]}));
    calls.push(payload=>{const state=packetState(payload.messages[1].content);return {covered:true,missing:[],requirements:[{id:state.requirements[0].id,satisfied:true,reason:"The requested file change is saved."}]};});
    replies=[()=>interpretation("change",`${operation} ${target}`),...calls];
    const {result,runId,approve}=await run(`${operation} ${target}`);
    expect(result.outcome,result.text).toBe("completed");expect(approve).toHaveBeenCalledTimes(1);
    const store=new RunResultStore(runId),record=store.listResults({limit:50}).find(record=>record.producer.tool === operation)!;
    const expected=operation === "delete_file" ? null : createHash("sha256").update("new content\n").digest("hex");
    expect(store.retrieveResultSlice(record.resultId,{mode:"json",pointer:"/afterDigest"}).content).toBe(expected ?? "null");
  });
  it("rejects text changed after the approved edit even when the reviewer says satisfied", async()=>{
    const action=(name:string,args:object)=>({tool_calls:[{name,arguments:args}]});
    replies=[()=>interpretation("change","Repair note.txt"),()=>action("read_file",{path:"note.txt"}),()=>action("edit_file",{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}),()=>action("finish",{text:"The edit is saved."}),payload=>{
      const state=packetState(payload.messages[1].content); expect(state.requirements).toHaveLength(1);
      writeFileSync(path.join(root,"note.txt"),"external update\n");
      return {covered:true,missing:[],requirements:[{id:state.requirements[0].id,satisfied:true,reason:"Edit is saved."}]};
    },payload=>{const state=packetState(payload.messages[1].content);expect(state.feedback.text).toContain("changed during review");return action("finish",{text:"The edit is saved."});}];
    const {result,approve}=await run("Repair note.txt");
    expect(result.outcome).toBe("partial"); expect(result.stopReason).toBe("repeated_action"); expect(approve).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(root,"note.txt"),"utf8")).toBe("external update\n");
  });
  it("does not review a text edit whose saved post-edit digest is already stale",async()=>{
    const action=(name:string,args:object)=>({tool_calls:[{name,arguments:args}]});
    replies=[()=>interpretation("change","Repair note.txt"),()=>action("read_file",{path:"note.txt"}),()=>action("edit_file",{path:"note.txt",expected_digest:createHash("sha256").update("saved source\n").digest("hex"),replacements:[{old:"source",new:"content"}]}),()=>{writeFileSync(path.join(root,"note.txt"),"external update\n");return action("finish",{text:"The edit is saved."});},payload=>{
      const state=packetState(payload.messages[1].content);expect(state.feedback.text).toContain("no longer current");return action("finish",{text:"The edit is saved."});
    }];
    const {result,runId}=await run("Repair note.txt");
    expect(result.outcome).toBe("partial");expect(result.stopReason).toBe("repeated_action");
    expect(new RunResultStore(runId).listResults({limit:50}).some(record=>record.producer.tool === "agent_requirement_review")).toBe(false);
  });
  it("reduces review source pages after exact rejection without dropping the requirement",async()=>{
    const source="text ".repeat(700)+"ANCHOR\n",digest=createHash("sha256").update(source).digest("hex");
    writeFileSync(path.join(root,"large.txt"),source);
    const original=ModelGateway.prototype.chatWithTools;let rejections=0;
    vi.spyOn(ModelGateway.prototype,"chatWithTools").mockImplementation(async function(this:ModelGateway,modelId,messages,tools,options){
      const input=packetState(messages[1]?.content ?? "{}");
      if(input.proposedAnswer !== undefined && input.evidenceSlices.some((slice:any)=>slice.sourceText?.length>1000)){
        expect(input.requirements).toHaveLength(1);expect(input.originalRequests[0].content).toBe("Repair large.txt");rejections++;
        return {ok:false,error:{kind:"ai-error",code:"agent_context_limit",message:"Prepared review exceeds context",retryable:false}};
      }
      return original.call(this,modelId,messages,tools,options);
    });
    replies=[()=>interpretation("change","Repair large.txt"),()=>({tool_calls:[{name:"read_file",arguments:{path:"large.txt",max_bytes:4000}}]}),()=>({tool_calls:[{name:"edit_file",arguments:{path:"large.txt",expected_digest:digest,replacements:[{old:"ANCHOR",new:"REPAIRED"}]}}]}),()=>({tool_calls:[{name:"finish",arguments:{text:"Edit saved."}}]}),payload=>{
      const input=packetState(payload.messages[1].content);expect(input.requirements).toHaveLength(1);
      expect(input.evidenceSlices).toContainEqual(expect.objectContaining({kind:"source",completeFile:false,byteRange:[0,1000]}));
      return {covered:true,missing:[],requirements:[{id:input.requirements[0].id,satisfied:true,reason:"Observed edit saved."}]};
    }];
    const {result,runId}=await run("Repair large.txt");expect(result.outcome,result.text).toBe("completed");expect(rejections).toBe(2);
    const ledger=getExecutionLedger(runId)!;expect(ledger.agentTask?.modelCalls).toBeLessThanOrEqual(9);expect(ledger.agentAdmissions).toHaveLength(ledger.agentTask?.modelCalls ?? 9);
  });
  it("permits one malformed-action correction and never executes either multi-action response", async () => {
    const text = "Inspect note.txt", calls = { tool_calls: [{ name: "read_file", arguments: { path: "note.txt" } }, { name: "write_file", arguments: { path: "other.txt", content: "bad" } }] };
    replies = [() => interpretation("inspect", text), () => calls, () => calls, () => calls];
    const { result, emit } = await run(text);
    expect(result.stopReason).toBe("malformed_action"); expect(emit.mock.calls.some(([event]) => event.type === "tool_call")).toBe(false);
  });
  it("retains mixed requirement kinds and rejects unknown source references", () => {
    const text = "Inspect, reproduce, repair both bugs, preserve behavior, and run the full suite.";
    const parsed = parseTaskInterpretation(JSON.stringify({ disposition: "continue", requirements: ["inspect", "execute", "change", "preserve", "deliver"].map(kind => ({ kind, description: kind, source_id: "request", checks: [{ description: kind, kind: "review", operation: "semantic", path: null }] })), updates: [], full_suite: true }), "11111111-1111-4111-8111-111111111111", text);
    expect(parsed.updates).toHaveLength(5); expect(parsed.fullSuite).toBe(true);
    const forged = interpretation("change", "Invented instruction"); forged.requirements[0].source_id = "s999999";
    expect(() => parseTaskInterpretation(JSON.stringify(forged), "11111111-1111-4111-8111-111111111111", text)).toThrow("source reference is unknown");
  });
});
