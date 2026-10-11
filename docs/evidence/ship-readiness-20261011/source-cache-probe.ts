import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../../backend/src/main/persistence/db.js';
import { createChat } from '../../../backend/src/main/persistence/chats.js';
import { createRun } from '../../../backend/src/main/run/store.js';
import { setDataDir, createRunDirectories, writeRunFile } from '../../../backend/src/main/run/filesystem.js';
import { prepareSources } from '../../../backend/src/main/run/source-preparation.js';
import { extractDocumentTool } from '../../../backend/src/main/tools/specialist-tools.js';
import { buildRegistryFromRows } from '../../../backend/src/main/gateway/registry.js';

async function main(){
 const root=mkdtempSync(path.join(tmpdir(),'workbench-ship-source-cache-'));setDataDir(root);initDb(path.join(root,'test.db'));
 const bytes=Buffer.from('mock-visual-bytes-'+randomUUID());let count=0;
 const original=extractDocumentTool.execute;
 extractDocumentTool.execute=async args=>{count++;return {output:'Mock extraction for query: '+args.query,summary:'Mocked visual extraction'};};
 try{
  const evidence=[];
  for(const query of ['Describe colors only','Read the serial number']){
   const runId=createRun(createChat(),query);createRunDirectories(runId);
   const relativePath=writeRunFile(runId,'input','image.png',bytes);
   const attachment={attachmentId:randomUUID(),runId,filename:'image.png',relativePath,mediaType:'image/png',sizeBytes:bytes.length};
   evidence.push(await prepareSources([attachment],query,{runId,workspaceRoot:path.join(root,'runs',runId,'input'),gateway:{} as any}));
  }
  const rows=buildRegistryFromRows([{role:'coding',modelName:'text-only-audit-model',host:'127.0.0.1',port:1234,contextLength:8192}]);
  const result={root,extractionCallCount:count,queries:['Describe colors only','Read the serial number'],evidence,
   secondRunUsedFirstQueryResult:evidence[1].includes('Describe colors only'),
   unprofiledCodingModelAdvertisesVision:rows[0].capabilities.includes('image-input'),capabilities:rows[0].capabilities};
  writeFileSync('/tmp/workbench-ship-source-cache-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{extractDocumentTool.execute=original;closeDb();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
