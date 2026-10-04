const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, 'isolated-project');
const outRoot = path.join(__dirname, 'trials');
const hook = path.join(__dirname, 'telemetry-hook.cjs');
const baseOrder = ['A0','A1','A2','A3','A4'];
const envProfile = { A0:'bounded', A1:'a1', A2:'a2', A3:'a3', A4:'default' };
const caps = { A0:[1024,768], A1:[1280,1024], A2:[1536,1024], A3:[2048,1280], A4:[4096,4096] };
const rounds = Number(process.env.BENCH_ROUNDS || 5);
const startRound = Number(process.env.BENCH_START_ROUND || 1);
const selectedProfiles = (process.env.BENCH_PROFILES || baseOrder.join(',')).split(',').map(x=>x.trim()).filter(Boolean);
function readRows(file) { if (!fs.existsSync(file)) return []; const raw=fs.readFileSync(file,'utf8'); return file.endsWith('.json') ? JSON.parse(raw) : raw.split('\n').filter(Boolean).map(x=>JSON.parse(x)); }
function sum(rows, fn) { return rows.reduce((n,x)=>n+(Number(fn(x))||0),0); }
async function runOne(profile, round) {
  const name = `${profile}-${String(round).padStart(2,'0')}`;
  const dir = path.join(outRoot,name);
  fs.mkdirSync(dir,{recursive:true});
  const logPath=path.join(dir,'flow.log');
  const existingTrace=fs.existsSync(logPath)&&fs.existsSync(path.join(dir,'requests.jsonl'));
  let tail=''; let exitCode=1; let durationMs=0;
  if(existingTrace){tail=fs.readFileSync(logPath,'utf8').slice(-24000);exitCode=tail.includes('ALL CHECKS PASSED')?0:1;durationMs=Number(tail.match(/Run reached terminal state: .*? in ([\d.]+)s/)?.[1]||0)*1000;}
  else {
    const log=fs.createWriteStream(logPath);
    const started=Date.now();
    const child=spawn(process.execPath,[path.join(root,'scripts/test-flow-b.cjs')],{
      cwd:root,
      env:{...process.env,SW_AGENT_EXPERIMENTAL_BUDGET_PROFILE:envProfile[profile],FLOW_AUDIT_OUTDIR:dir,NODE_OPTIONS:[process.env.NODE_OPTIONS,`--require=${hook}`].filter(Boolean).join(' ')},
      stdio:['ignore','pipe','pipe']
    });
    for(const stream of [child.stdout,child.stderr]) stream.on('data',buf=>{const s=buf.toString();log.write(s);tail=(tail+s).slice(-24000);for(const line of s.split(/\r?\n/))if(/STARTING FLOW B|Run reached terminal state|PASS:|FAIL:/.test(line))process.stdout.write(`[${name}] ${line.trim()}\n`);});
    exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    log.end();durationMs=Date.now()-started;
  }
  const rows=readRows(path.join(dir,'requests.jsonl'));
  const working=rows.filter(x=>String(x.purpose).startsWith('working_'));
  const classifiers=rows.filter(x=>x.purpose==='classification');
  const delegates=rows.filter(x=>x.purpose==='delegated');
  const events=readRows(path.join(dir,'events.json'));
  const toolResults=events.filter(x=>x.type==='tool_result');
  const allTools=working.flatMap(x=>(x.toolCalls||[]).map(c=>c.name).filter(Boolean));
  const checksPassed=(tail.match(/✅ PASS:/g)||[]).length;
  const checksFailed=(tail.match(/❌ FAIL:/g)||[]).length;
  const summary={profile,trial:round,caps:{actionValidation:caps[profile][0],postValidation:caps[profile][1]},exitCode,accepted:exitCode===0,wallMs:durationMs,wallClockSource:existingTrace?'terminal event elapsed; runner overhead not captured':'outer process elapsed',flowWallSeconds:Number(tail.match(/Run reached terminal state: .*? in ([\d.]+)s/)?.[1]??NaN),outcome:tail.match(/Run reached terminal state: (\w+)/)?.[1]??null,acceptance:{passed:checksPassed,failed:checksFailed,total:checksPassed+checksFailed},calls:{working:working.length,classification:classifiers.length,delegated:delegates.length,total:rows.length},tokens:{input:sum(rows,x=>x.usage?.prompt_tokens),completion:sum(rows,x=>x.usage?.completion_tokens),reasoning:sum(rows,x=>x.usage?.completion_tokens_details?.reasoning_tokens),nonReasoning:sum(rows,x=>Math.max(0,(x.usage?.completion_tokens||0)-(x.usage?.completion_tokens_details?.reasoning_tokens||0)) )},lengthStopCount:rows.filter(x=>x.finishReason==='length').length,toolSequence:allTools,toolExecutionDurationMs:sum(toolResults,x=>x.durationMs),failedTools:toolResults.filter(x=>x.ok===false).map(x=>({tool:x.tool,summary:x.summary})),repeatedTools:[...new Set(allTools.filter((t,i)=>allTools.indexOf(t)!==i))],acceptanceLog:tail.split(/\r?\n/).filter(x=>/✅ PASS:|❌ FAIL:/.test(x)),perCall:rows.map(x=>({purpose:x.purpose,model:x.model,durationMs:x.durationMs,ttftMs:x.ttftMs,decodeMs:x.durationMs==null||x.ttftMs==null?null:Math.max(0,x.durationMs-x.ttftMs),finishReason:x.finishReason,inputTokens:x.usage?.prompt_tokens??null,completionTokens:x.usage?.completion_tokens??null,reasoningTokens:x.usage?.completion_tokens_details?.reasoning_tokens??null,nonReasoningTokens:x.usage?.completion_tokens==null?null:Math.max(0,x.usage.completion_tokens-(x.usage?.completion_tokens_details?.reasoning_tokens||0)),toolSchemaChars:x.toolSchemaChars,estimatedToolSchemaTokens:Math.ceil((x.toolSchemaChars||0)/4),generation:x.generation,cacheUsage:x.usage?.prompt_tokens_details??null,toolCalls:x.toolCalls})),unsafeOrUnexpectedTools:allTools.filter(x=>!['read_file','write_file','run_command','list_dir','search'].includes(x))};
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
  process.stdout.write(`[${name}] DONE ${summary.outcome??'unknown'} wall=${summary.flowWallSeconds}s accepted=${summary.accepted} calls=${summary.calls.working} length=${summary.lengthStopCount}\n`);
  return summary;
}
(async()=>{
  fs.mkdirSync(outRoot,{recursive:true});
  const schedule=[];
  for(let round=startRound;round<=rounds;round++)for(let i=0;i<baseOrder.length;i++){const p=baseOrder[(i+2*(round-1))%baseOrder.length];if(selectedProfiles.includes(p))schedule.push([p,round]);}
  const all=[];
  for(let i=0;i<schedule.length;i++){
    const [p,n]=schedule[i];
    process.stdout.write(`\n=== Round ${n}/${rounds}: ${p} trial ${n} ===\n`);
    all.push(await runOne(p,n));
    fs.writeFileSync(path.join(__dirname,'budget-results.partial.json'),JSON.stringify(all,null,2));
  }
  fs.writeFileSync(path.join(__dirname,'budget-results.json'),JSON.stringify(all,null,2));
  process.stdout.write(`Saved ${all.length} trials.\n`);
})().catch(e=>{console.error(e);process.exitCode=1;});
