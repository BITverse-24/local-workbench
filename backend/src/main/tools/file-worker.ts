import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileProcessingSlots } from "../gateway/inference-scheduler.js";
import { currentRuntimeScope, abortError } from "../run/runtime-scope.js";

export interface ParsedFile {
  text: string;
  headings: string[];
  sheets: string[];
  columns: string[][];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  formulas: number;
  pages?: Array<{ pageNumber: number; text: string }>;
  annotations?:Array<{text:string;page:number}>;
  json?: unknown;
}

// This is a standalone worker program. It does not import the Electron main bundle.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const parseCsv = text => {
  const rows=[]; let row=[], field='', quoted=false, after=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) { if(c==='"' && text[i+1]==='"') {field+='"';i++;} else if(c==='"'){quoted=false;after=true;} else field+=c; continue; }
    if(after && c!==',' && c!=='\r' && c!=='\n') throw new Error('Invalid characters after CSV quote');
    if(c==='"') {if(field) throw new Error('Quote in unquoted CSV field');quoted=true;after=false;}
    else if(c===','){row.push(field);field='';after=false;}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);rows.push(row);row=[];field='';after=false;}
    else field+=c;
  }
  if(quoted) throw new Error('Unclosed CSV field');
  if(field || row.length || after) {row.push(field);rows.push(row);}
  if(rows.length && rows.some(row=>row.length!==rows[0].length)) throw new Error('CSV row widths differ');
  return rows;
};
const main=async()=>{
  const {file,kind,zipModule,xmlModule,pdfModule}=workerData;
  const stat=fs.statSync(file); if(!stat.isFile()||stat.size>64*1024*1024)throw new Error('Input is not a bounded file');
  const bytes=fs.readFileSync(file);
  const out={text:'',headings:[],sheets:[],columns:[],rows:[],rowCount:0,formulas:0};
  if(kind==='pdf') {
    const canvas=require(workerData.canvasModule);globalThis.DOMMatrix??=canvas.DOMMatrix;globalThis.ImageData??=canvas.ImageData;
    const pdfjs=await import(require('node:url').pathToFileURL(pdfModule).href);
    const loading=pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true,isEvalSupported:false,disableFontFace:true});
    const doc=await loading.promise;
    out.pages=[];out.annotations=[];
    try {for(let pageNumber=1;pageNumber<=doc.numPages;pageNumber++) {
      const page=await doc.getPage(pageNumber); const content=await page.getTextContent();
      const text=content.items.map(item=>(item.str??'')+(item.hasEOL?'\n':' ')).join('').trim();
      out.pages.push({pageNumber,text});
      for(const annotation of await page.getAnnotations()){const content=annotation.contentsObj?.str??annotation.contents;if(typeof content==='string'&&content.trim())out.annotations.push({text:content.trim(),page:pageNumber});}
    }} finally {await loading.destroy();}
    out.text=out.pages.map(p=>'--- Page '+p.pageNumber+' ---\n'+p.text).join('\n\n');return out;
  }
  if(kind!=='docx'&&kind!=='xlsx') {
    out.text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(kind==='json')out.json=JSON.parse(out.text);
    if(kind==='csv'){out.rows=parseCsv(out.text);out.columns=[out.rows[0]??[]];out.rowCount=Math.max(0,out.rows.length-1);}
    if(kind==='md')out.headings=out.text.split(/\r?\n/).filter(line=>/^#{1,6}\s/.test(line)).map(line=>line.replace(/^#{1,6}\s+/,''));
    return out;
  }
  const JSZip=require(zipModule), {SaxesParser}=require(xmlModule);
  let zip=await JSZip.loadAsync(bytes,{checkCRC32:false});
  if(Object.values(zip.files).reduce((n,f)=>n+(f._data?.uncompressedSize??0),0)>64*1024*1024)throw new Error('Office package exceeds extraction limit');
  zip=await JSZip.loadAsync(bytes,{checkCRC32:true});
  const xml=async(name,onOpen,onText,onClose)=>{
    const entry=zip.file(name);if(!entry)throw new Error('Missing Office entry '+name);
    const parser=new SaxesParser({xmlns:false}); let failure;
    parser.on('error',e=>{failure=e;});parser.on('opentag',onOpen??(()=>{}));parser.on('text',onText??(()=>{}));parser.on('closetag',onClose??(()=>{}));
    parser.write(await entry.async('string')).close();if(failure)throw failure;
  };
  if(kind==='docx'){
    let paragraph='',inText=false,heading=false,table=false,row=[],cell='',tableRows=[];
    await xml('word/document.xml',tag=>{
      if(tag.name==='w:tbl'){table=true;tableRows=[];}
      if(tag.name==='w:tr')row=[];
      if(tag.name==='w:tc')cell='';
      if(tag.name==='w:p'){paragraph='';heading=false;}
      if(tag.name==='w:pStyle'&&/heading/i.test(tag.attributes['w:val']??''))heading=true;
      if(tag.name==='w:t')inText=true;
      if(tag.name==='w:br')paragraph+='\n';
    },text=>{if(inText)paragraph+=text;},tag=>{
      if(tag.name==='w:t')inText=false;
      if(tag.name==='w:p'){if(paragraph)out.text+=paragraph+'\n';if(table)cell+=(cell?'\n':'')+paragraph;if(heading)out.headings.push(paragraph);}
      if(tag.name==='w:tc')row.push(cell);
      if(tag.name==='w:tr')tableRows.push(row);
      if(tag.name==='w:tbl'){out.columns.push(tableRows[0]??[]);out.rows.push(...tableRows);out.rowCount+=Math.max(0,tableRows.length-1);table=false;}
    });
    if(!out.text.trim())throw new Error('DOCX contains no readable text');
  }else{
    const shared=[];let value='',inText=false;
    if(zip.file('xl/sharedStrings.xml'))await xml('xl/sharedStrings.xml',tag=>{if(tag.name==='si')value='';if(tag.name==='t')inText=true;},text=>{if(inText)value+=text;},tag=>{if(tag.name==='t')inText=false;if(tag.name==='si')shared.push(value);});
    const relationships={};
    await xml('xl/_rels/workbook.xml.rels',tag=>{if(tag.name==='Relationship')relationships[tag.attributes.Id]=tag.attributes.Target;});
    const sheets=[];
    await xml('xl/workbook.xml',tag=>{if(tag.name==='sheet')sheets.push({name:tag.attributes.name,target:relationships[tag.attributes['r:id']]});});
    if(!sheets.length)throw new Error('XLSX has no sheets');
    for(const sheet of sheets){
      out.sheets.push(sheet.name);let row=[],cell=null,inValue=false;
      const rows=[];const target=sheet.target?.replace(/^\//,'');
      if(!target||target.includes('..'))throw new Error('Invalid worksheet relationship');
      await xml(target.startsWith('xl/')?target:'xl/'+target,tag=>{
        if(tag.name==='row')row=[];
        if(tag.name==='c'){const ref=tag.attributes.r??'';let index=0;for(const c of ref.replace(/[0-9]/g,''))index=index*26+c.charCodeAt(0)-64;cell={index:index-1,type:tag.attributes.t,text:''};}
        if(tag.name==='f')out.formulas++;
        if(tag.name==='v'||tag.name==='t')inValue=true;
      },text=>{if(inValue&&cell)cell.text+=text;},tag=>{
        if(tag.name==='v'||tag.name==='t')inValue=false;
        if(tag.name==='c'&&cell){let value=cell.type==='s'?shared[Number(cell.text)]:cell.type==='b'?cell.text==='1':cell.type==='inlineStr'||cell.type==='str'?cell.text:cell.text===''?null:Number(cell.text);
          if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Invalid XLSX numeric cell');
          if(value===undefined)throw new Error('Invalid XLSX shared string');
          row[cell.index]=value;cell=null;}
        if(tag.name==='row'&&row.some(v=>v!==null&&v!==undefined))rows.push(Array.from(row,v=>v??null));
      });
      out.columns.push((rows[0]??[]).map(v=>String(v??'')));
      out.rowCount+=Math.max(0,rows.length-1);out.rows.push(...rows);
    }
    if(!out.rows.length)throw new Error('XLSX has no data');
    out.text=out.rows.map(r=>r.join(' | ')).join('\n');
  }
  return out;
};main().then(value=>parentPort.postMessage({value}),error=>parentPort.postMessage({error:error.message}));
`;

export async function parseFileIndependently(file: string, kind: string, signal = currentRuntimeScope()?.signal): Promise<ParsedFile> {
  return fileProcessingSlots.run("work", async () => {
    signal?.throwIfAborted();
    const require = createRequire(typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url));
    return new Promise<ParsedFile>((resolve, reject) => {
      const worker = new Worker(workerSource, { eval: true, resourceLimits:{maxOldGenerationSizeMb:256,stackSizeMb:4}, workerData: { file, kind,
        zipModule: require.resolve("jszip"), xmlModule: require.resolve("saxes"),
        pdfModule: require.resolve("pdfjs-dist/legacy/build/pdf.mjs"), canvasModule: require.resolve("canvas"),
      } });
      let settling=false;
      const finish=async(value?:ParsedFile,error?:Error)=>{
        if(settling)return;settling=true;cleanup();
        await worker.terminate();
        error?reject(error):resolve(value!);
      };
      const abort = () => { void finish(undefined,abortError()); };
      const timer = setTimeout(() => { void finish(undefined,new Error("File processing timed out.")); }, 60000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", message => { void finish(message.value,message.error?new Error(message.error):undefined); });
      worker.once("error", error => { void finish(undefined,error instanceof Error?error:new Error(String(error))); });
      worker.once("exit", code => { if(!settling)void finish(undefined,new Error(`File worker ended without a result (code ${code}).`)); });
      if (signal?.aborted) abort();
    });
  }, signal, "file-processing");
}
