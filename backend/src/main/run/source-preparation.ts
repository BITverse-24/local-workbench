import { extractAttributedDocumentNotes, readDocumentContent } from "../tools/document-reader.js";
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AttachmentReference } from '../../shared/contracts.js';
import { resolveRunPath } from './filesystem.js';
import { assertRuntimeActive, currentRuntimeScope } from './runtime-scope.js';
import { parseFileIndependently } from '../tools/file-worker.js';
import { ToolDispatcher } from '../agent/tool-dispatcher.js';
import { extractDocumentTool } from '../tools/specialist-tools.js';
import type { ToolExecutionContext } from '../tools/types.js';
const cache = new Map<string, {text:string;pages:number[]}>();

export function selectExcerpts(text: string, query: string, limit: number): string {
  if (text.length <= limit) return text;
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])];
  const blocks = text.match(/[\s\S]{1,1600}/g) ?? [];
  const ranked = blocks.map((block, i) => ({ block, i, score: terms.reduce((n,t) => n + (block.toLowerCase().includes(t) ? 1 : 0),0) }))
    .sort((a,b) => b.score-a.score || a.i-b.i);
  const selected: typeof ranked = []; let used=0;
  for (const block of ranked) if (used+block.block.length <= limit) { selected.push(block); used+=block.block.length; }
  return selected.sort((a,b)=>a.i-b.i).map(b=>`[Excerpt ${b.i+1}]\n${b.block}`).join('\n') + '\n[Coverage limited: only selected excerpts are included. State missing evidence.]';
}

export async function prepareSources(attachments: AttachmentReference[], text: string, context: ToolExecutionContext, limit=16000): Promise<string> {
  const parts: string[]=[];
  for (const attachment of attachments) {
    assertRuntimeActive();
    const prefix=`runs/${context.runId}/`;
    if(!attachment.relativePath.startsWith(prefix))throw new Error('Source belongs to another run.');
    const file=resolveRunPath(context.runId,attachment.relativePath.slice(prefix.length),'input');
    const ext=path.extname(attachment.filename).slice(1).toLowerCase();
    const bytes=readFileSync(file);
    const key=createHash('sha256').update(bytes).update('independent-reader-v4').digest('hex');
    const cached=cache.get(key);
    let content=cached?.text;let pages=cached?.pages??[1];
    if (content===undefined) {
      let needsVisual=false;let annotationEvidence='';
      if (ext==='svg') {
        const source=await readDocumentContent(file);
        if(source.hasText)content=source.text;
      }
      if (!['png','jpg','jpeg','bmp','tif','tiff','svg'].includes(ext)) {
        try { const parsed=await parseFileIndependently(file,ext); content=parsed.text;needsVisual=ext==='pdf'&&!parsed.pages?.some(page=>page.text.trim());const annotations=[...(parsed.annotations??[]),...extractAttributedDocumentNotes(parsed.text)];if(annotations.length){annotationEvidence='\nSource annotations preceding reviewer/inspector attribution (verbatim evidence): '+JSON.stringify(annotations);content+=annotationEvidence;}
          pages=(parsed.pages??[{pageNumber:1}]).map(page=>page.pageNumber); } catch (e) { assertRuntimeActive(); if (!['pdf','docx','xlsx'].includes(ext)) throw e; }
      }
      if ((!content?.trim()||needsVisual) && ['pdf','svg','png','jpg','jpeg','bmp','tif','tiff'].includes(ext)) {
        const [result]=await new ToolDispatcher([extractDocumentTool]).dispatchConcurrent([{ id: key, name:'extract_document', arguments:{filename:attachment.filename,query:text} }],context);
        if (!result.result.ok) throw new Error(result.result.error.message);
        content=result.result.output+annotationEvidence;
      }
      if (content===undefined) throw new Error(`Cannot read ${attachment.filename}.`);
      if (cache.size>=64) cache.delete(cache.keys().next().value!);
      if (content.length<=2_000_000) cache.set(key,{text:content,pages});
    }
    context.sourceReferences??=[];context.sourceReferences.push(...pages.map(page=>({filename:attachment.filename,page})));
    const budget=Math.max(1000,Math.floor(limit/Math.max(attachments.length,1)));
    if(context.resultStore){context.resultStore.registerResult({type:'document',status:'complete',origin:'source_extracted',producer:{tool:'extract_document',callId:key},summary:`Read ${attachment.filename}`,payload:{sourceText:content},sources:[{filename:attachment.filename,page:1,relation:'source'}]});}
    parts.push(`--- ATTACHED FILE: ${attachment.filename} ---\nSource ID: ${attachment.attachmentId}\n${selectExcerpts(content,text,budget)}\n--- END ATTACHED FILE: ${attachment.filename} ---`);
  }
  currentRuntimeScope()?.signal.throwIfAborted();
  return parts.join('\n\n');
}
