import path from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { RunManager } from '../../backend/src/main/run/manager.js';
import { ModelGateway } from '../../backend/src/main/gateway/model-gateway.js';
import { configurePersistence, initDb, closeDb } from '../../backend/src/main/persistence/db.js';
import { setDataDir, createRunDirectories } from '../../backend/src/main/run/filesystem.js';
import { createChat } from '../../backend/src/main/persistence/chats.js';
import { createRun } from '../../backend/src/main/run/store.js';
import { addMessage } from '../../backend/src/main/persistence/messages.js';
import { readInferenceTelemetry } from '../../backend/src/main/gateway/telemetry.js';
import { withRuntimeScope } from '../../backend/src/main/run/runtime-scope.js';
import type { RunEvent } from '../../backend/src/shared/contracts.js';
const main=async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'workbench-mode-benchmark-'));
 configurePersistence({dataDir:root,schemaPath:path.resolve('backend/src/main/persistence/schema.sql')});
 setDataDir(path.join(root,'data'));initDb(path.join(root,'workbench.db'));
 const gateway=new ModelGateway();const observations=new Map<string,{start:number;first:number|null;resolve:(value:any)=>void;condition:string;prompt:string}>();const samples:any[]=[];
 let cancelFirstToken:((id:string)=>void)|undefined;
 const manager=new RunManager(gateway,(event:RunEvent)=>{
  const sample=observations.get(event.runId);if(!sample)return;
  if(event.type==='assistant_message_chunk'&&sample.first===null){sample.first=Date.now()-sample.start;cancelFirstToken?.(event.runId);}
  if(event.type==='run_state'&&['completed','partial','failed','cancelled','limit_exceeded'].includes(event.state))sample.resolve({runId:event.runId,state:event.state,visibleTtftMs:sample.first,totalMs:Date.now()-sample.start,condition:sample.condition,prompt:sample.prompt});
 });
 const submit=async(prompt:string,condition:string)=>{
  const cid=createChat('Benchmark');addMessage({chat_id:cid,role:'user',content:prompt});
  const id=createRun(cid,prompt);let resolve!:(v:any)=>void;const terminal=new Promise<any>(r=>resolve=r);
  observations.set(id,{start:Date.now(),first:null,resolve,condition,prompt});
  await manager.start({chatId:cid,runId:id,userText:prompt,mode:'chat',temperature:0,selectedModel:'primary-model'});
  const timer=setTimeout(()=>manager.cancel(id),300000);const sample=await terminal;clearTimeout(timer);
  const calls=readInferenceTelemetry(id);const snapshot=manager.getRunSnapshot({runId:id})!;
  const completed={...sample,calls:Number(snapshot.metrics?.modelCallCount??calls.length),providerTtftMs:calls.map(c=>c.ttftMs),queueWaitMs:snapshot.metrics?.queueWaitMs??0,cancellationResourceMs:snapshot.metrics?.cancellationResourceMs,answer:snapshot.draft?.text??''};samples.push(completed);save();return completed;
 };
 const percentile=(values:number[],percent:number)=>values.sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*percent)-1)]??null;
 const save=()=>{
  const conditions=[...new Set(samples.map(s=>s.condition))];const summary=Object.fromEntries(conditions.map(condition=>{const subset=samples.filter(s=>s.condition===condition);return [condition,{count:subset.length,visibleTtftP50:percentile(subset.filter(s=>s.visibleTtftMs!==null).map(s=>s.visibleTtftMs),.5),visibleTtftP95:percentile(subset.filter(s=>s.visibleTtftMs!==null).map(s=>s.visibleTtftMs),.95),totalP50:percentile(subset.map(s=>s.totalMs),.5),totalP95:percentile(subset.map(s=>s.totalMs),.95),queueP50:percentile(subset.map(s=>s.queueWaitMs),.5)}];}));
  writeFileSync(process.argv[2],JSON.stringify({hardware:{cpu:cpus()[0].model,memoryBytes:totalmem()},model:'config/models.json',coldMeasurement:'Not measured. No model residency control was used.',quality:'Answers retained for manual review; speed does not establish answer quality.',samples,summary,root},null,2));
 };
 const prompts=['Explain thermal expansion in fewer than 60 words.','What is the difference between mass and weight? Use fewer than 60 words.','Explain why unit tests are useful in fewer than 60 words.','Give three checks for reading a CSV file. Use fewer than 60 words.'];
 for(let round=0;round<2;round++)for(const prompt of prompts){console.log(JSON.stringify(await submit(prompt,samples.length?'warm-idle':'initial-residency-unknown')));}
 // Real background inference, through the same resource scheduler as Work stages.
 for(let trial=0;trial<3;trial++){
  const runId=createRun(createChat('Background Work'),'Write an explanation');createRunDirectories(runId);let ready!:()=>void;const began=new Promise<void>(resolve=>ready=resolve);
  const background=withRuntimeScope({runId,mode:'work',signal:new AbortController().signal},()=>gateway.chatWithTools('primary-model',[{role:'user',content:'Explain heat transfer in exactly 120 words.'}],[],{runId,maxTokens:300,temperature:0,onChunk:()=>ready()}));
  await Promise.race([began,background.then(()=>ready())]);console.log(JSON.stringify(await submit(prompts[trial],'warm-busy')));await background;
 }
 let cancellationStarted=0;cancelFirstToken=id=>{cancelFirstToken=undefined;cancellationStarted=Date.now();manager.cancel(id);};
 const cancelled=await submit('Explain thermodynamics in 1000 words.','active-cancellation');
 const next=await submit('Reply with OK.','after-cancellation');
 cancelled.nextResponseMs=Date.now()-cancellationStarted;cancelled.nextVisibleMs=next.visibleTtftMs;cancelled.cancellationResourceMs=manager.getRunSnapshot({runId:cancelled.runId})?.metrics?.cancellationResourceMs;
 save();closeDb();
};main().catch(error=>{console.error(error);process.exitCode=1;});
