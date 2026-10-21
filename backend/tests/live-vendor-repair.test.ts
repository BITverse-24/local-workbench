import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRegistryFromRows, loadRegistry } from '../src/main/gateway/registry.js';
import { ModelGateway } from '../src/main/gateway/model-gateway.js';
import { closeDb, initDb } from '../src/main/persistence/db.js';
import { createChat } from '../src/main/persistence/chats.js';
import { RunManager } from '../src/main/run/manager.js';
import { setDataDir, resolveRunPath, runRoot } from '../src/main/run/filesystem.js';
import type { ModelConfigRow, RunEvent } from '../src/shared/contracts.js';

describe.skipIf(process.env.WORKBENCH_LIVE_TESTS !== '1')('Reported vendor parser repair with configured local model', () => {
  let temporary = '';
  afterEach(() => { closeDb(); if (temporary) rmSync(temporary, {recursive:true,force:true}); });

  it('completes the exact request and verifies the inclusive boundary and malformed rows', async () => {
    let registry;
    if (process.env.WORKBENCH_LIVE_MODELS_PATH) registry = [...loadRegistry(process.env.WORKBENCH_LIVE_MODELS_PATH).values()];
    else {
      const db = new Database(process.env.WORKBENCH_LIVE_DB_PATH ?? path.resolve('data/data/workbench.db'), {readonly:true,fileMustExist:true});
      try {
        const row = db.prepare('SELECT value FROM settings WHERE key=?').get('configured_models') as {value:string};
        registry = buildRegistryFromRows(JSON.parse(row.value) as ModelConfigRow[]);
      } finally { db.close(); }
    }
    const model = registry.find(entry => entry.enabled && !entry.fallbackOnly && entry.capabilities.includes('text'));
    expect(model).toBeDefined();
    temporary = mkdtempSync(path.join(tmpdir(),'vendor-repair-live-'));
    setDataDir(path.join(temporary,'data')); initDb(path.join(temporary,'test.sqlite'));
    const events:RunEvent[]=[];
    const gateway = new ModelGateway(undefined,registry);
    const manager = new RunManager(gateway,event => {
      events.push(event);
      if(event.type==='confirmation_required') void manager.confirm({runId:event.runId,actionId:event.action.actionId,approved:true});
    });
    const chatId=createChat('Vendor parser regression');
    const fixtures=path.resolve('demo/flow_b/scenario-1');
    const attachments=['broken-vendor-log-parser.py','vendor-maintenance-log.csv'].map(filename=>{
      const content=readFileSync(path.join(fixtures,filename));
      return manager.registerAttachment({chatId,filename,mediaType:filename.endsWith('.py')?'text/x-python':'text/csv',sizeBytes:content.length,base64OrBuffer:content}).attachment.attachmentId;
    });
    const started=await manager.start({mode:'work',chatId,selectedModel:model!.id,userText:readFileSync(path.join(fixtures,'prompt.md'),'utf8').trim(),attachmentTokens:attachments,groundingEnabled:false});
    try {
      await expect.poll(()=>manager.getRunSnapshot({runId:started.runId})?.state,{timeout:420000,interval:500}).toMatch(/^(completed|partial|failed|cancelled|limit_exceeded)$/);
      const snapshot=manager.getRunSnapshot({runId:started.runId})!;
      expect(snapshot.state,JSON.stringify(snapshot.verification)).toBe('completed');
      expect(snapshot.verification?.checks.filter(check=>check.mandatory).every(check=>check.status==='passed')).toBe(true);
      const saved=resolveRunPath(started.runId,'output/fixed-vendor-log-parser.py','output');
      const csv=resolveRunPath(started.runId,'input/vendor-maintenance-log.csv','input');
      expect(readFileSync(csv)).toEqual(readFileSync(path.join(fixtures,'vendor-maintenance-log.csv')));
      expect(execFileSync('python3',['-B',saved,csv],{timeout:5000,encoding:'utf8'}).trim()).toBe("{'ok': 4, 'malformed': 1, 'high': 2}");
      const edge=path.join(temporary,'edge.csv');
      writeFileSync(edge,'id,temperature_c\n1,349.9\n2,350.0\n3,350.1\n4,\n5,invalid\n6\n');
      execFileSync('python3',['-B','-c','import runpy,sys; m=runpy.run_path(sys.argv[1]); assert m["summarize"](sys.argv[2]) == {"ok":3,"malformed":3,"high":2}',saved,edge],{timeout:5000});
      expect(events.filter(event=>event.type==='tool_call'&&event.tool==='execute_python')).toHaveLength(1);
    } finally {
      // Keep proof from successful and failed live checks outside temporary storage.
      const reportDir=path.resolve('tests/.runtime/reports/vendor-parser-repair');
      mkdirSync(reportDir,{recursive:true});
      const {cpSync}=await import('node:fs');
      cpSync(runRoot(started.runId),path.join(reportDir,started.runId),{recursive:true});
      writeFileSync(path.join(reportDir,`${started.runId}.json`),JSON.stringify({model:model!.model,transport:model!.toolCallingFormat??'native',snapshot:manager.getRunSnapshot({runId:started.runId}),events},null,2));
    }
  },450000);
});
