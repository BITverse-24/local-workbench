import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { createCanvas,loadImage } from 'canvas';
import { inspectSource,loadSourceInspections,requiresVisualInspection,inspectionGaps } from '../src/main/run/source-inspection.js';
import { requestSourcePages,selectSourcePages,pendingSourcePages,expireSourcePageSelections } from '../src/main/run/source-page-selection.js';
import { createRunDirectories,resolveRunPath,absoluteDataPath } from '../src/main/run/filesystem.js';
import { withRuntimeScope } from '../src/main/run/runtime-scope.js';
import { readFileTool } from '../src/main/tools/workspace-tools.js';
import { ModelGateway } from '../src/main/gateway/model-gateway.js';
import { testModelRegistry } from './helpers/test-model-registry.js';
import type { ToolExecutionContext } from '../src/main/tools/types.js';
import { parsePageRange } from '../src/shared/source-pages.js';

const observed={sourceText:'TAG-A: CLASS 200',findings:[{findingId:'f1',title:'Visible rating plate',value:'CLASS 200',pageReferenceIds:['p1'],confidence:'high',evidence:'CLASS 200'}],pageReferences:[{id:'p1',page:1,text:'CLASS 200',location:'rating plate'}],warnings:[]};
describe('Required visual source inspection',()=>{
  let root:string,runId:string,context:ToolExecutionContext,events:any[],controller:AbortController;
  beforeEach(()=>{
    root=mkdtempSync(path.join(tmpdir(),'inspection-'));process.env.WORKBENCH_DATA_ROOT=root;runId=randomUUID();createRunDirectories(runId);events=[];controller=new AbortController();
    context={runId,workspaceRoot:resolveRunPath(runId,'input','input'),originalUserRequest:'Review this drawing',emitRunEvent:event=>events.push(event),gateway:{registry:new Map(testModelRegistry().map(m=>[m.id,m])),execute:vi.fn(async()=>({ok:true,value:{result:structuredClone(observed)}})),chatWithTools:vi.fn(async()=>({ok:true,value:{content:'{"conflicts":[],"unresolved":[]}',finishReason:'stop'}}))} as any};
  });
  afterEach(()=>{vi.restoreAllMocks();delete process.env.WORKBENCH_DATA_ROOT;rmSync(root,{recursive:true,force:true});});
  const svg=(text='TAG-A',width=600)=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="300"><rect width="100%" height="100%" fill="white"/><rect x="100" y="100" width="100" height="80" fill="red"/><text x="20" y="40">${text}</text></svg>`);
  function file(bytes:Buffer,name='drawing.svg'){const target=resolveRunPath(runId,'input/'+name,'input');writeFileSync(target,bytes);return target;}
  function read(target:string,name='drawing.svg',budget?:number){return withRuntimeScope({runId,mode:'work',signal:controller.signal,remainingModelCalls:budget},()=>inspectSource(target,name,'Extract text only',context));}
  function pdf(count:number,text=false){const canvas=createCanvas(150,100,'pdf'),ctx=canvas.getContext('2d');for(let page=1;page<=count;page++){if(page>1)(ctx as any).addPage();ctx.fillStyle='red';ctx.fillRect(5,5,50,40);if(text){(ctx as any).textDrawingMode='glyph';ctx.fillStyle='black';ctx.fillText('A readable technical document with sufficient ordinary text content.',5,80);}}return canvas.toBuffer();}
  it('does not let a tool query downgrade a text-rich drawing',async()=>{
    const result=await read(file(svg('TAG-A and readable source text')));
    expect(result.record.status).toBe('complete');expect(context.gateway.execute).toHaveBeenCalledOnce();
    expect(result.text).toContain('DIGITAL TEXT');expect(result.text).toContain('VISUAL OBSERVATIONS');expect(result.text).toContain('CLASS 200');
    expect(result.record.digitalText).not.toContain('CLASS 200');expect(loadSourceInspections(runId)[0].views).toHaveLength(1);
  });
  it('sends saved pixels unchanged through the real gateway transport',async()=>{
    const sent:Buffer[]=[];
    context.gateway=new ModelGateway({async request(_url,init){const body=JSON.parse(init.body!);const images=body.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content.filter((p:any)=>p.type==='image_url'):[]);for(const part of images)sent.push(Buffer.from(part.image_url.url.split(',')[1],'base64'));return {status:200,async text(){return JSON.stringify({choices:[{message:{content:JSON.stringify(images.length?observed:{conflicts:[],unresolved:[]})},finish_reason:'stop'}]});}};}},testModelRegistry());
    const result=await read(file(svg()));expect(result.record.status).toBe('complete');expect(sent).toHaveLength(1);
    const view=result.record.views[0];expect(sent[0].equals(readFileSync(absoluteDataPath(view.relativePath)))).toBe(true);
    expect(createHash('sha256').update(sent[0]).digest('hex')).toBe(view.sha256);
    const image=await loadImage(sent[0]),canvas=createCanvas(image.width,image.height);canvas.getContext('2d').drawImage(image,0,0);
    const pixel=canvas.getContext('2d').getImageData(150,140,1,1).data;expect(pixel[0]).toBeGreaterThan(200);expect(pixel[1]).toBeLessThan(60);
  });
  it('preserves overview and close views instead of losing detail on reduction',async()=>{
    const result=await read(file(svg('TAG-A',1800)));expect(result.record.views).toHaveLength(3);
    expect(result.record.views.map(view=>view.location)).toEqual(['overview','pixels 0,0,1280,300 at source resolution','pixels 520,0,1280,300 at source resolution']);
    for(const view of result.record.views){const image=await loadImage(readFileSync(absoluteDataPath(view.relativePath)));expect(Math.max(image.width,image.height)).toBeLessThanOrEqual(1280);}
  });
  it('requires Vision for a digital PDF when the original request is visual',async()=>{
    const result=await read(file(pdf(1,true),'drawing.pdf'),'drawing.pdf');expect(result.record.visualRequired).toBe(true);expect(context.gateway.execute).toHaveBeenCalled();
  });
  it('keeps an ordinary digital PDF on the text path',async()=>{
    context.originalUserRequest='Summarize this report';const result=await read(file(pdf(1,true),'report.pdf'),'report.pdf');expect(result.record.status).toBe('complete');expect(context.gateway.execute).not.toHaveBeenCalled();
  });
  it.each(['model','render','invalid','uncertain','conflict','budget'])('cannot complete when %s evidence fails',async fault=>{
    if(fault==='model')context.gateway.registry.clear();
    if(fault==='invalid')vi.mocked(context.gateway.execute).mockResolvedValue({ok:true,value:{result:{...observed,findings:[{...observed.findings[0],pageReferenceIds:['absent']}]}}} as any);
    if(fault==='uncertain')vi.mocked(context.gateway.execute).mockResolvedValue({ok:true,value:{result:{...observed,warnings:['Rating plate is unreadable']}}} as any);
    if(fault==='conflict')vi.mocked(context.gateway.chatWithTools).mockResolvedValue({ok:true,value:{content:'{"conflicts":["TAG-A rating has incompatible readings"],"unresolved":[]}',finishReason:'stop'}} as any);
    const result=await read(file(fault==='render'?Buffer.from('not an SVG'):svg()),'drawing.svg',fault==='budget'?8:undefined);
    expect(result.record.status).toBe('partial');expect([...result.record.failures,...result.record.warnings].length).toBeGreaterThan(0);
  });
  it('reuses evidence only for the same run, request, source, and model',async()=>{
    const target=file(svg());await read(target);await read(target);expect(context.gateway.execute).toHaveBeenCalledTimes(1);
    context.originalUserRequest='Read drawing dimensions';await read(target);expect(context.gateway.execute).toHaveBeenCalledTimes(2);
    context.gateway.registry.get('vision-fallback')!.model='different-version';await read(target);expect(context.gateway.execute).toHaveBeenCalledTimes(3);
    writeFileSync(target,svg('TAG-B'));await read(target);expect(context.gateway.execute).toHaveBeenCalledTimes(4);
  });
  it('rejects SVG resource reads outside the supplied source',async()=>{
    const bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image href="file:///private/secret.png"/></svg>');const result=await read(file(bytes));expect(result.record.status).toBe('partial');expect(result.record.failures.join(' ')).toMatch(/self-contained/);expect(context.gateway.execute).not.toHaveBeenCalled();
  });
  it('invalidates completed inspection when the source or a saved view changes',async()=>{
    const target=file(svg()),result=await read(target);expect(inspectionGaps(runId)).toEqual([]);writeFileSync(absoluteDataPath(result.record.views[0].relativePath),Buffer.from('changed'));expect(inspectionGaps(runId).join(' ')).toMatch(/integrity/);writeFileSync(target,svg('changed source'));expect(inspectionGaps(runId).join(' ')).toMatch(/source changed/);
  });
  it('selects an explicit page range and preserves original page numbers',async()=>{
    const target=file(pdf(11),'long.pdf'),reading=read(target,'long.pdf');
    await vi.waitFor(()=>expect(pendingSourcePages(runId)).toBeDefined());const selection=pendingSourcePages(runId)!;
    expect(()=>selectSourcePages({...selection,pages:[12]})).toThrow();expect(()=>selectSourcePages({...selection,pages:[]})).toThrow();
    selectSourcePages({...selection,pages:[11]});const result=await reading;
    expect(result.record.requestedPages).toEqual([11]);expect(result.record.inspectedPages).toEqual([11]);expect(result.record.visualText).toContain('"page":11');expect(result.text).toContain('excluded pages 1, 2');expect(pendingSourcePages(runId)).toBeUndefined();
  });
  it('rejects a changed source during page selection',async()=>{
    const target=file(pdf(11),'long.pdf'),reading=read(target,'long.pdf');await vi.waitFor(()=>expect(pendingSourcePages(runId)).toBeDefined());const selection=pendingSourcePages(runId)!;writeFileSync(target,Buffer.from('changed'));
    expect(()=>selectSourcePages({...selection,pages:[1]})).toThrow(/changed/);expect((await reading).record.status).toBe('partial');
  });
  it('cancels a pending selection without sending any images',async()=>{
    const reading=read(file(pdf(11),'long.pdf'),'long.pdf');const stopped=expect(reading).rejects.toThrow();await vi.waitFor(()=>expect(pendingSourcePages(runId)).toBeDefined());controller.abort();await stopped;expect(pendingSourcePages(runId)).toBeUndefined();expect(context.gateway.execute).not.toHaveBeenCalled();
  });
  it('expires pending selections on restart and rejects old replies',async()=>{
    const reading=read(file(pdf(11),'long.pdf'),'long.pdf');await vi.waitFor(()=>expect(pendingSourcePages(runId)).toBeDefined());const selection=pendingSourcePages(runId)!;expireSourcePageSelections();expect((await reading).record.status).toBe('partial');expect(pendingSourcePages(runId)).toBeUndefined();expect(()=>selectSourcePages({...selection,pages:[1]})).toThrow(/expired/);
  });
  it('inspects Agent workspace drawings and rejects path escapes',async()=>{
    file(svg());await readFileTool.execute({path:'drawing.svg'},context);expect(context.gateway.execute).toHaveBeenCalled();await expect(readFileTool.execute({path:'../outside.svg'},context)).rejects.toThrow();
  });
  it('keeps authorized run attachment fallback for Agent visual reads',async()=>{
    file(svg());context.workspaceRoot=path.join(root,'workspace');mkdirSync(context.workspaceRoot);const result=await readFileTool.execute({path:'drawing.svg'},context);expect(result.output).toContain('CLASS 200');expect(context.gateway.execute).toHaveBeenCalled();
  });
  it('parses user page ranges and rejects malformed or excessive ranges',()=>{
    expect(parsePageRange('1, 3-5, 3',9)).toEqual([1,3,4,5]);for(const input of ['','0','4-2','2-99','abc','1-30'])expect(()=>parsePageRange(input,30)).toThrow();
    expect(requiresVisualInspection('drawing.svg','Extract text')).toBe(true);expect(requiresVisualInspection('document.pdf','Read annotations')).toBe(true);
  });
});
