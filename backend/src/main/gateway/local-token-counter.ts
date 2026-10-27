import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { fileProcessingSlots } from "./inference-scheduler.js";
import { abortError, currentRuntimeScope } from "../run/runtime-scope.js";

export interface LocalPromptCount {
  inputTokens: number;
  renderedDigest: string;
  assetDigests: Record<string, string>;
  templateDigest: string;
  counterIdentity: "huggingface-tokenizers-0.2.0/jinja-0.5.11";
}

// Same bounded-worker pattern as file-worker. Templates are data, never JavaScript.
const workerSource = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
try {
  const {Tokenizer}=require(workerData.tokenizerModule),{Template}=require(workerData.jinjaModule);
  const root=fs.realpathSync(workerData.assetsDir), digests={};
  const read=(name,maxBytes,optional=false)=>{
    const candidate=path.join(root,name);
    if(optional&&!fs.existsSync(candidate))return undefined;
    const file=fs.realpathSync(candidate);
    if(path.dirname(file)!==root)throw new Error('Tokenizer asset leaves its selected directory.');
    const fd=fs.openSync(file,'r');
    try {
      const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>maxBytes)throw new Error('Tokenizer asset exceeds its size limit.');
      const bytes=fs.readFileSync(fd);if(bytes.length>maxBytes)throw new Error('Tokenizer asset exceeds its size limit.');
      digests[name]=hash(bytes);return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    } finally {fs.closeSync(fd);}
  };
  const tokenizerJson=JSON.parse(read('tokenizer.json',64*1024*1024));
  const config=JSON.parse(read('tokenizer_config.json',2*1024*1024));
  // These files can affect the server tokenizer binding even when their values
  // are already incorporated in tokenizer.json/config. A change invalidates verification.
  read('special_tokens_map.json',1024*1024,true);read('added_tokens.json',2*1024*1024,true);
  const separateTemplate=read('chat_template.jinja',256*1024,true);
  const source=workerData.activeTemplate ?? separateTemplate ?? config.chat_template;
  if(typeof source!=='string'||!source.length||source.length>256*1024)throw new Error('Select one explicit supported chat template.');
  const token=value=>typeof value==='string'?value:value?.content??'';
  const payload=workerData.payload;
  // The prepared payload is the source of messages and tools. No history is added here.
  const variables={messages:payload.messages,tools:payload.tools??[],
    bos_token:token(config.bos_token),eos_token:token(config.eos_token),
    add_generation_prompt:true};
  if(payload.enable_thinking!==undefined)variables.enable_thinking=payload.enable_thinking;
  const rendered=new Template(source).render(variables);
  if(Buffer.byteLength(rendered)>2*1024*1024)throw new Error('Rendered prompt exceeds the counting limit.');
  const tokenizer=new Tokenizer(tokenizerJson,config);
  const count=tokenizer.encode(rendered,{add_special_tokens:false}).ids.length;
  if(!Number.isSafeInteger(count)||count<1)throw new Error('Tokenizer returned an invalid count.');
  parentPort.postMessage({value:{inputTokens:count,renderedDigest:hash(rendered),assetDigests:digests,
    templateDigest:hash(source),counterIdentity:'huggingface-tokenizers-0.2.0/jinja-0.5.11'}});
} catch(error) {parentPort.postMessage({error:error.message});}
`;

/** Local count only. Admission also requires a verified match to the active server profile. */
export async function countLocalAgentRequest(options: {
  assetsDir: string;
  payload: Record<string, unknown>;
  activeTemplate?: string;
  signal?: AbortSignal;
}): Promise<LocalPromptCount> {
  const assetsDir = z.string().min(1).max(4096).parse(options.assetsDir);
  const activeTemplate = z.string().min(1).max(256 * 1024).optional().parse(options.activeTemplate);
  const payload = z.object({
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().nullable() }).passthrough()).min(1),
    tools: z.array(z.unknown()).optional(),
  }).passthrough().parse(options.payload);
  if (Buffer.byteLength(JSON.stringify(payload)) > 2 * 1024 * 1024) throw new Error("Prepared request exceeds the counting limit.");
  const signal = options.signal ?? currentRuntimeScope()?.signal;
  return fileProcessingSlots.run("agent", async () => {
    signal?.throwIfAborted();
    const require = createRequire(typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json"));
    return new Promise<LocalPromptCount>((resolve, reject) => {
      const worker = new Worker(workerSource, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }, workerData: {
        assetsDir, activeTemplate, payload, tokenizerModule: require.resolve("@huggingface/tokenizers"), jinjaModule: require.resolve("@huggingface/jinja"),
      } });
      let settled = false;
      const finish = async (value?: LocalPromptCount, error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        await worker.terminate(); error ? reject(error) : resolve(value!);
      };
      const abort = () => { void finish(undefined, abortError()); };
      const timer = setTimeout(() => { void finish(undefined, new Error("Tokenizer or template processing timed out.")); }, 30000);
      worker.once("message", message => { void finish(message.value, message.error ? new Error(message.error) : undefined); });
      worker.once("error", error => { void finish(undefined, error instanceof Error ? error : new Error(String(error))); });
      worker.once("exit", code => { if (!settled) void finish(undefined, new Error(`Tokenizer worker stopped without a count (${code}).`)); });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }, signal, "file-processing");
}
