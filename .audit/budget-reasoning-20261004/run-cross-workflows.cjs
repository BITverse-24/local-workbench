const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'isolated-project');
const hook=path.join(__dirname,'telemetry-hook.cjs');
const outRoot=path.join(__dirname,'cross-workflow');
const profiles={A0:'bounded',A1:'a1',A3:'a3',A4:'default'};
const workflows={
  'flow-a':{script:'test-flow-a.cjs',order:['A0','A1','A3','A4']},
  'flow-c':{script:'test-flow-c.cjs',order:['A1','A3','A4','A0']},
  financial:{script:'test-financial-reconciliation.cjs',order:['A3','A4','A0','A1']},
};
function readRows(file){if(!fs.existsSync(file))return [];const v=fs.readFileSync(file,'utf8');return file.endsWith('.json')?JSON.parse(v):v.split('\n').filter(Boolean).map(x=>JSON.parse(x));}
const sum=(a,f)=>a.reduce((n,x)=>n+(Number(f(x))||0),0);
const selectedWorkflows=process.env.WORKFLOW_FILTER?process.env.WORKFLOW_FILTER.split(',').map(x=>x.trim()):Object.keys(workflows);
async function runOne(profile,workflow,script){
 const dir=path.join(outRoot,workflow,profile);fs.mkdirSync(dir,{recursive:true});
 const log=fs.createWriteStream(path.join(dir,`${workflow}.log`));const start=Date.now();let tail='';
 const child=spawn(process.execPath,[path.join(root,'scripts',script)],{cwd:root,env:{...process.env,SW_AGENT_EXPERIMENTAL_BUDGET_PROFILE:profiles[profile],FLOW_AUDIT_OUTDIR:dir,NODE_OPTIONS:[process.env.NODE_OPTIONS,`--require=${hook}`].filter(Boolean).join(' ')},stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{const s=b.toString();log.write(s);tail=(tail+s).slice(-24000);for(const line of s.split(/\r?\n/))if(/Run reached terminal state|PASS:|FAIL:|Summary:/.test(line))process.stdout.write(`[${workflow}/${profile}] ${line.trim()}\n`);});
 const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});log.end();
 const rows=readRows(path.join(dir,'requests.jsonl'));const events=readRows(path.join(dir,'events.json'));const tools=rows.flatMap(x=>(x.toolCalls||[]).map(c=>c.name).filter(Boolean));
 const checksPassed=(tail.match(/✅ PASS:/g)||[]).length,checksFailed=(tail.match(/❌ FAIL:/g)||[]).length;
 const summary={workflow,profile,caps:profile==='A0'?[1024,768]:profile==='A1'?[1280,1024]:profile==='A3'?[2048,1280]:[4096,4096],exitCode,accepted:exitCode===0,wallMs:Date.now()-start,flowWallSeconds:Number(tail.match(/Run reached terminal state: .*? in ([\d.]+)s/)?.[1]??NaN),outcome:tail.match(/Run reached terminal state: (\w+)/)?.[1]??null,acceptance:{passed:checksPassed,failed:checksFailed,total:checksPassed+checksFailed},calls:{working:rows.filter(x=>String(x.purpose).startsWith('working_')).length,classification:rows.filter(x=>x.purpose==='classification').length,delegated:rows.filter(x=>x.purpose==='delegated').length,total:rows.length},tokens:{input:sum(rows,x=>x.usage?.prompt_tokens),completion:sum(rows,x=>x.usage?.completion_tokens),reasoning:sum(rows,x=>x.usage?.completion_tokens_details?.reasoning_tokens),nonReasoning:sum(rows,x=>Math.max(0,(x.usage?.completion_tokens||0)-(x.usage?.completion_tokens_details?.reasoning_tokens||0)))},lengthStopCount:rows.filter(x=>x.finishReason==='length').length,toolSequence:tools,toolExecutionDurationMs:sum(events.filter(x=>x.type==='tool_result'),x=>x.durationMs),failedTools:events.filter(x=>x.type==='tool_result'&&x.ok===false).map(x=>x.tool),repeatedTools:[...new Set(tools.filter((t,i)=>tools.indexOf(t)!==i))],perCall:rows.map(x=>({purpose:x.purpose,durationMs:x.durationMs,ttftMs:x.ttftMs,finishReason:x.finishReason,inputTokens:x.usage?.prompt_tokens,completionTokens:x.usage?.completion_tokens,reasoningTokens:x.usage?.completion_tokens_details?.reasoning_tokens,maxTokens:x.generation?.max_tokens,toolCalls:x.toolCalls,cacheUsage:x.usage?.prompt_tokens_details??null}))};
 fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));process.stdout.write(`[${workflow}/${profile}] DONE ${summary.outcome??'unknown'} wall=${summary.flowWallSeconds}s accepted=${summary.accepted} length=${summary.lengthStopCount}\n`);return summary;
}
(async()=>{fs.mkdirSync(outRoot,{recursive:true});const out=[];for(const [workflow,cfg] of Object.entries(workflows))if(selectedWorkflows.includes(workflow))for(const profile of cfg.order)out.push(await runOne(profile,workflow,cfg.script));const resultPath=path.join(__dirname,'cross-workflow-results.json');const previous=fs.existsSync(resultPath)?JSON.parse(fs.readFileSync(resultPath,'utf8')):[];const merged=[...previous.filter(x=>!selectedWorkflows.includes(x.workflow)),...out];fs.writeFileSync(resultPath,JSON.stringify(merged,null,2));})().catch(e=>{console.error(e);process.exitCode=1;});
