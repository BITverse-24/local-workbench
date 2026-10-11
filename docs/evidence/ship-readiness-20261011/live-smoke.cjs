const fs=require('fs'),path=require('path');
const {FlowRunner,ROOT}=require('../../../scripts/run-demo-flows.cjs');
const root=path.join(ROOT,'tests/.runtime/ship-audit/live-'+new Date().toISOString().replace(/[:.]/g,'-'));
const scenarios=[
 {id:'agent-write',mode:'agent',prompt:'Replace smoke.txt in the workspace with exactly AFTER. Do not create any document or downloadable artifact. Do not run commands.',file:'smoke.txt',expected:'AFTER'},
 {id:'work-general-draft',mode:'work',prompt:'Create welcome.docx as a short welcome letter to a new team member. Include the exact sentence Welcome to the team. Do not include a table.',artifact:'welcome.docx'},
 {id:'chat-stop',mode:'chat',prompt:'Write a long, detailed explanation of heat transfer with many worked examples.',cancel:true}
];
class RestrictedRunner extends FlowRunner {
 handleWorkerMessage(msg) {
  if(msg.kind==='event'&&msg.event.type==='confirmation_required') {
   this.events.push(msg.event); this.logEvent(msg.event);
   const action=msg.event.action;
   const approved=this.flowName==='agent-write'&&action.kind==='plan_approval'&&action.prompt.includes('smoke.txt')&&!/generate_deliverable|run_command|execute_python|delete_file/.test(action.prompt);
   console.log('APPROVAL '+approved+' '+action.prompt);
   this.callCommand('invoke',{channel:'workbench:confirmAction',input:{runId:msg.event.runId,actionId:action.actionId,approved}}).catch(console.error);return;
  }
  if(msg.kind==='event'&&msg.event.type==='assistant_message_chunk'&&this.flowName==='chat-stop'&&!this.cancelSent) {
   this.cancelSent=Date.now(); this.cancelRunId=msg.event.runId;
   this.callCommand('invoke',{channel:'workbench:cancelRun',input:{runId:msg.event.runId}}).catch(console.error);
  }
  super.handleWorkerMessage(msg);
 }
}
(async()=>{
 const results=[];
 for(const scenario of scenarios){
  const runner=new RestrictedRunner(scenario.id,path.join(root,scenario.id));const boot=runner.setupSandbox();
  fs.writeFileSync(path.join(runner.sandboxDir,'workspace/smoke.txt'),'BEFORE');
  try{
   await runner.startWorker(boot);
   const started=Date.now();const {runId}=await runner.callCommand('send',{chat:scenario.id,mode:scenario.mode,text:scenario.prompt,files:[],groundingEnabled:false});
   let state;try{state=await runner.waitForTerminalState(runId,180000);}catch{await runner.callCommand('invoke',{channel:'workbench:cancelRun',input:{runId}});state='timeout';}
   const inspection=await runner.callCommand('inspect');
   const terminal=runner.events.find(e=>e.type==='run_state'&&e.state==='cancelled'&&e.runId===runId);
   const result={...scenario,runId,state,latencyMs:Date.now()-started,inspection,events:runner.events,
    workspaceFile:fs.readFileSync(path.join(runner.sandboxDir,'workspace/smoke.txt'),'utf8'),
    workspaceFiles:fs.readdirSync(path.join(runner.sandboxDir,'workspace')),
    cancellationRequested:!!runner.cancelSent,cancellationReachedTerminal:!!terminal};
   result.passed=scenario.cancel?state==='cancelled'&&result.cancellationRequested:scenario.mode==='agent'?['completed','partial'].includes(state)&&result.workspaceFile===scenario.expected&&inspection.artifacts.length===0:inspection.artifacts.some(a=>a.filename===scenario.artifact)&&['completed','partial'].includes(state);
   results.push(result);fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({root,results},null,2));console.log('SMOKE '+scenario.id+' '+result.passed+' '+state);
  }finally{await runner.shutdown();}
 }
 console.log('SMOKE evidence '+root);process.exitCode=results.every(r=>r.passed)?0:1;
})().catch(error=>{console.error(error);process.exitCode=2;});
