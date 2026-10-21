import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SourcePageSelection } from '../../shared/contracts.js';
import { currentRuntimeScope } from './runtime-scope.js';

const pending = new Map<string, { selection: SourcePageSelection; file: string; resolve:(pages:number[])=>void; reject:(error:Error)=>void; cleanup:()=>void }>();
export function pendingSourcePages(runId:string):SourcePageSelection|undefined {return pending.get(runId)?.selection;}
export function expireSourcePageSelections():void {
  for(const item of [...pending.values()]){item.cleanup();item.reject(new Error('Page selection expired after restart. Resume the run and select pages again.'));}
}
export function selectSourcePages(input:{runId:string;selectionId:string;sourceDigest:string;pages:number[]}):void {
  const item=pending.get(input.runId);
  if(!item||item.selection.selectionId!==input.selectionId)throw new Error('Page selection expired.');
  const digest=createHash('sha256').update(readFileSync(item.file)).digest('hex');
  if(digest!==input.sourceDigest||digest!==item.selection.sourceDigest){item.cleanup();item.reject(new Error('Source changed. Submit a new review.'));throw new Error('Source changed.');}
  const pages=[...new Set(input.pages)].sort((a,b)=>a-b);
  if(!pages.length||pages.length>item.selection.maxPages||pages.some(p=>!Number.isInteger(p)||p<1||p>item.selection.pageCount)||pages.reduce((n,p)=>n+item.selection.pageViewCounts[p-1],0)>item.selection.maxViews)throw new Error('Select pages within the displayed page and view limits.');
  item.cleanup();item.resolve(pages);
}
export async function requestSourcePages(selection:Omit<SourcePageSelection,'selectionId'>,file:string,emit:(event:any)=>void):Promise<number[]> {
  if(pending.has(selection.runId))throw new Error('Another source is waiting for a page selection.');
  const signal=currentRuntimeScope()?.signal;
  if(signal?.aborted)throw new Error('Run cancelled.');
  return new Promise((resolve,reject)=>{
    const request={...selection,selectionId:randomUUID()};
    const cleanup=()=>{signal?.removeEventListener('abort',abort);pending.delete(selection.runId);};
    const abort=()=>{cleanup();reject(new Error('Run cancelled.'));};
    pending.set(selection.runId,{selection:request,file,resolve,reject,cleanup});
    signal?.addEventListener('abort',abort,{once:true});
    emit({type:'source_page_selection',runId:selection.runId,selection:request});
  });
}
