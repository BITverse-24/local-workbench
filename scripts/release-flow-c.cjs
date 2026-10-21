/** Real-model release gate. Oracles never enter the application sandbox. */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const JSZip=require('jszip');
const {FlowRunner,ROOT}=require('./run-demo-flows.cjs');
const {drawing}=require('./build-flow-c-fixtures.cjs');
const {taskText}=require('./demo-prompt.cjs');
const cases=JSON.parse(fs.readFileSync(path.join(ROOT,'tests/fixtures/demo/oracles/flow_c/release-cases.json'),'utf8'));
const definitions={
  1:{mode:'chat',source:'pump-skid-P204.svg',kb:'piping-spec-SOP-220.md'},
  2:{mode:'work',source:'relief-valve-register.csv',kb:'process-safety-standard.md'},
  3:{mode:'agent',source:'utility-manifold-U18.svg',kb:'utility-standard-UT-9.md'},
};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function subjectText(text,subject){
  const lines=text.split('\n'),matching=[];
  for(let i=0;i<lines.length;i++)if(lines[i].toLowerCase().includes(subject.toLowerCase())){
    matching.push(lines[i]);
    if(!lines[i].includes('|'))for(let next=i+1;next<Math.min(lines.length,i+4)&&!/^\s*(?:#|\|)/.test(lines[next]);next++)matching.push(lines[next]);
  }
  return matching.join('\n');
}
function decision(text,expected){
  const fail=/non[\s-]?compliant|not compliant|does not meet|doesn.t meet|exceeds (?:the )?(?:upper |maximum )?(?:maximum|limit)|violat(?:es|ion)|outside (?:the )?(?:range|limit)|\bfail(?:s|ed)?\b|above (?:the )?(?:maximum|limit)|below (?:the )?minimum/i;
  if(expected==='fail')return fail.test(text);
  if(expected==='unknown')return /unknown|missing|absent|not (?:recorded|available)|unverified/i.test(text)&&/out of service|withhold|withheld|pending|not (?:release|approved)|until/i.test(text);
  return /\bcompliant\b|\bapproved\b|\bacceptable\b|\bpass(?:es|ed)?\b|\bmeets\b|within (?:the )?(?:range|limit)/i.test(text)&&!fail.test(text);
}
async function run(test,campaign){
  const def=definitions[test.scenario],input=path.join(ROOT,`demo/flow_c/scenario-${test.scenario}`),sandbox=path.join(campaign,test.id),runner=new FlowRunner(test.id,sandbox);
  const boot=runner.setupSandbox([{path:def.kb,kind:'markdown'}]);
  let source=fs.readFileSync(path.join(input,test.scenario===3?'workspace':'',def.source));
  if(test.drawing)source=Buffer.from(drawing(test.scenario,test.drawing));
  if(test.register)source=Buffer.from('equipment,mawp_bar,valve_id,set_pressure_bar,last_bench_test\nV-301,10.0,RV-301,9.5,2026-08-11\nV-302,10.0,RV-302,10.0,2026-08-12\nV-303,10.0,RV-303,9.5,2026-01-18\n');
  let spec=fs.readFileSync(path.join(input,def.kb),'utf8');
  if(test.spec==='relaxed')spec=spec.replace(/Class 300/g,'Class 150').replace(/DN100/g,'DN80');
  if(test.spec==='stricter')spec=spec.replace(/Class 300/g,'Class 600');
  const prompt=taskText(fs.readFileSync(path.join(input,'prompt.md'),'utf8'));
  fs.writeFileSync(path.join(sandbox,test.scenario===3?'workspace':'attachments',def.source),source);
  fs.writeFileSync(path.join(sandbox,'kb',def.kb),spec);
  const config=JSON.parse(fs.readFileSync(boot,'utf8'));
  if(test.negative==='no-vision'){config.registry=config.registry.filter(model=>!model.capabilities?.includes('image-input'));fs.writeFileSync(boot,JSON.stringify(config,null,2));}
  const attempt={runtimeBundleSha256:hash(fs.readFileSync(path.join(ROOT,'tests/.runtime/build/worker.cjs'))),gateSha256:hash(fs.readFileSync(__filename)),id:test.id,startedAt:new Date().toISOString(),prompt,hashes:{prompt:hash(prompt),source:hash(source),spec:hash(spec)},modelConfiguration:config.registry};
  fs.writeFileSync(path.join(sandbox,'release-attempt.json'),JSON.stringify(attempt,null,2));
  try{
    await runner.startWorker(boot);
    const {runId}=await runner.callCommand('send',{mode:def.mode,chat:test.id,text:prompt,files:test.scenario===3?[]:[def.source],groundingEnabled:true});
    let outcome;
    try{outcome=await runner.waitForTerminalState(runId,Number(process.env.FLOW_C_TIMEOUT_MS)||600000);}catch(error){outcome='timeout';await runner.callCommand('invoke',{channel:'workbench:cancelRun',input:{runId}});}
    const inspection=await runner.callCommand('inspect');
    const sourceRecords=path.join(sandbox,'data/runs',runId,'intermediate/source-inspections.json');
    const records=fs.existsSync(sourceRecords)?JSON.parse(fs.readFileSync(sourceRecords,'utf8')):[];
    const chatText=inspection.messages.filter(m=>m.role==='assistant'&&(!m.run_id||m.run_id===runId)).map(m=>m.content).join('\n');
    const artifact=inspection.artifacts.find(a=>a.filename.endsWith('.docx'));
    let documentText='';
    if(artifact){const zip=await JSZip.loadAsync(fs.readFileSync(path.join(sandbox,'data',artifact.relativePath??artifact.relative_path)));documentText=(await zip.file('word/document.xml').async('string')).replace(/<w:tc>[\s\S]*?<\/w:tc>/g,cell=>cell.replace(/<\/w:p>/g,' ')).replace(/<\/w:tr>/g,'\n').replace(/<\/w:tc>/g,' | ').replace(/<\/w:p>/g,'\n').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
    const reviewed=test.scenario===2?documentText:chatText;
    const checks={};
    if(test.negative){
      checks.incomplete=outcome==='partial'||outcome==='failed';
      checks.coverageFailure=records.some(record=>record.visualRequired&&record.status!=='complete');
      checks.explained=/unreadable|uncertain|unknown|incomplete|requires|image-input|configure|Vision|inspection/i.test(chatText+'\n'+JSON.stringify(records));
    }else{
      checks.completed=outcome==='completed';checks.response=reviewed.trim().length>100;
      checks.knowledgeUsed=runner.events.some(event=>event.type==='tool_result'&&event.tool==='retrieve_knowledge'&&event.ok);
      checks.savedNote=test.scenario!==2||Boolean(artifact);
      checks.visualEvidence=test.scenario===2||records.some(record=>record.visualRequired&&record.status==='complete'&&record.inspectedPages.length===record.requestedPages.length&&record.views.every(view=>view.resultId));
      for(const [subject,expected]of Object.entries(test.expect)){
        const content=[subject,...(test.aliases?.[subject]??[])].map(name=>subjectText(reviewed,name)).filter(Boolean).join("\n");
        checks[subject]=decision(content,expected);
        checks[subject+'-observations']=(test.observed?.[subject]??[]).every(value=>new RegExp('(?:^|[^0-9])'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/DN/g,'DN\\s*')+'(?![0-9])','i').test(content));
      }
      checks.noInventedScaleRule=test.scenario!==1||!/must.{0,20}(?:be to scale|scaled)|scale.{0,20}(?:non.?compliant|requirement)/i.test(reviewed);
      checks.citations=test.scenario===1?/SOP.?220/i.test(reviewed)&&/4\.2/.test(reviewed)&&/4\.3/.test(reviewed):test.scenario===2?/PS.?14/i.test(reviewed)&&/6\.1/.test(reviewed)&&/6\.2/.test(reviewed):/UT.?9/i.test(reviewed)&&/5\.1/.test(reviewed)&&/5\.2/.test(reviewed);
    }
    checks.sourceUnchanged=hash(fs.readFileSync(path.join(sandbox,test.scenario===3?'workspace':'attachments',def.source)))===attempt.hashes.source;
    const result={...attempt,runId,outcome,checks,passed:Object.values(checks).every(Boolean),chatText,documentText,sourceInspections:records,finishedAt:new Date().toISOString()};
    fs.writeFileSync(path.join(sandbox,'events.json'),JSON.stringify(runner.events,null,2));fs.writeFileSync(path.join(sandbox,'inspection.json'),JSON.stringify(inspection,null,2));fs.writeFileSync(path.join(sandbox,'evaluation.json'),JSON.stringify(result,null,2));
    return result;
  }catch(error){const result={...attempt,passed:false,error:String(error)};fs.writeFileSync(path.join(sandbox,'evaluation.json'),JSON.stringify(result,null,2));return result;}
  finally{fs.writeFileSync(path.join(sandbox,'events.json'),JSON.stringify(runner.events,null,2));await runner.shutdown();}
}
async function main(){
  const requested=process.env.FLOW_C_CASES?.split(',');const selected=requested?cases.filter(test=>requested.includes(test.id)):cases;
  if(!selected.length||requested&&selected.length!==requested.length)throw new Error('Unknown release case.');
  const campaign=path.join(ROOT,'tests/.runtime/flow-c-release',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(campaign,{recursive:true});const results=[];
  for(const test of selected){const result=await run(test,campaign);results.push(result);fs.writeFileSync(path.join(campaign,'results.json'),JSON.stringify(results,null,2));console.log(`${test.id}: ${result.passed?'PASS':'FAIL'} (${result.outcome??result.error}); ${Object.entries(result.checks??{}).filter(([,ok])=>!ok).map(([key])=>key).join(', ')}`);}
  const passed=results.every(result=>result.passed);console.log(`Flow C release gate: ${passed?'PASS':'FAIL'}. Evidence: ${campaign}`);process.exitCode=passed?0:1;
}
module.exports={subjectText,decision};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
