import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { ChatHistoryData, ChatMessageData, LLMTool } from "@lmstudio/sdk";
import { isAllowedLocalModelEndpoint } from "../../shared/local-network.js";
import { abortError } from "../run/runtime-scope.js";

const callSchema = z.object({ id: z.string(), type: z.literal("function"), function: z.object({ name: z.string().min(1), arguments: z.string() }).strict() }).strict();
const messageSchema = z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().nullable(), tool_calls: z.array(callSchema).optional(), tool_call_id: z.string().optional() }).strict();
const toolSchema = z.object({ type: z.literal("function"), function: z.object({ name: z.string().min(1), description: z.string().optional(), parameters: z.object({ type: z.literal("object"), properties: z.record(z.unknown()) }).passthrough().optional() }).strict() }).strict();

/** Lossless conversion for prepared text requests. Unsupported prompt options fail closed. */
export function lmStudioCountingInput(payload: Record<string, unknown>): { chat: ChatHistoryData; tools: LLMTool[] } {
  for (const option of ["chat_template", "chat_template_kwargs", "documents"])
    if (payload[option] !== undefined) throw new Error(`LM Studio counting does not support prompt option: ${option}`);
  const messages = z.array(messageSchema).min(1).parse(payload.messages);
  const tools = z.array(toolSchema).parse(payload.tools ?? []) as LLMTool[];
  const chat: ChatHistoryData = { messages: messages.map((message): ChatMessageData => {
    if (message.role === "tool") {
      if (!message.tool_call_id || message.tool_calls) throw new Error("Tool results require one matching call ID.");
      return { role: "tool", content: [{ type: "toolCallResult", toolCallId: message.tool_call_id, content: message.content ?? "" }] };
    }
    if (message.tool_call_id || (message.tool_calls && message.role !== "assistant")) throw new Error("Tool call metadata is invalid for this message role.");
    if (message.role === "assistant") return { role: "assistant", content: [
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      ...(message.tool_calls ?? []).map(call => ({ type: "toolCallRequest" as const, toolCallRequest: {
        type: "function" as const, id: call.id, name: call.function.name, arguments: z.record(z.unknown()).parse(JSON.parse(call.function.arguments)),
      } })),
    ] };
    return { role: message.role, content: [{ type: "text", text: message.content ?? "" }] };
  }) };
  return { chat, tools };
}

export interface LMStudioPromptCount {
  inputTokens: number;
  renderedDigest: string;
  instanceReference: string;
  modelPath: string;
  contextLimit: number;
  counterIdentity: "lmstudio-sdk-1.5.0";
  supportsNativeTools?: boolean;
}
const resultSchema = z.object({ inputTokens: z.number().int().positive(), renderedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  instanceReference: z.string().min(1), modelPath: z.string().min(1), contextLimit: z.number().int().positive(),
  counterIdentity: z.literal("lmstudio-sdk-1.5.0"), supportsNativeTools: z.boolean().optional() }).strict();
const workerSource = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {createHash}=require('node:crypto');
(async()=>{
  const {LMStudioClient}=require(workerData.sdkModule);
  const client=new LMStudioClient({baseUrl:workerData.endpoint});
  // Dynamic handles never load a model. Pin this count to the observed loaded instance.
  const dynamic=client.llm.createDynamicHandle(workerData.model);
  const before=await dynamic.getModelInfo();
  if(!before?.instanceReference)throw new Error('The counting model is not loaded.');
  const handle=client.llm.createDynamicHandleFromInstanceReference(before.instanceReference);
  const rendered=await handle.applyPromptTemplate(workerData.chat,{toolDefinitions:workerData.tools});
  if(Buffer.byteLength(rendered)>2*1024*1024)throw new Error('Rendered server prompt exceeds the counting limit.');
  const inputTokens=await handle.countTokens(rendered);
  const after=await dynamic.getModelInfo();
  if(after?.instanceReference!==before.instanceReference)throw new Error('Model changed while counting.');
  parentPort.postMessage({value:{inputTokens,renderedDigest:createHash('sha256').update(rendered).digest('hex'),
    instanceReference:before.instanceReference,modelPath:before.path,contextLimit:await handle.getContextLength(),counterIdentity:'lmstudio-sdk-1.5.0',supportsNativeTools:before.trainedForToolUse===true}});
})().catch(error=>parentPort.postMessage({error:error.message}));
`;

/** Count the server's rendered prompt, without generation, model loading, or task side effects. */
export async function countLMStudioPreparedRequest(options: { endpoint: string; payload: Record<string, unknown>; signal?: AbortSignal }): Promise<LMStudioPromptCount> {
  if (!isAllowedLocalModelEndpoint(options.endpoint)) throw new Error("Counting requires a local or private model endpoint.");
  const endpoint = new URL(options.endpoint);
  if (endpoint.search || endpoint.hash || !["", "/", "/v1", "/v1/"].includes(endpoint.pathname)) throw new Error("Select an LM Studio server root or /v1 endpoint for counting.");
  endpoint.pathname = "/"; endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const model = z.string().min(1).max(1024).parse(options.payload.model);
  if (Buffer.byteLength(JSON.stringify(options.payload)) > 2 * 1024 * 1024) throw new Error("Prepared request exceeds the counting limit.");
  const input = lmStudioCountingInput(options.payload);
  options.signal?.throwIfAborted();
  const require = createRequire(typeof __filename === "string" ? __filename : path.join(process.cwd(), "package.json"));
  const result = await new Promise<LMStudioPromptCount>((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }, workerData: {
      ...input, model, endpoint: endpoint.href.replace(/\/$/, ""), sdkModule: require.resolve("@lmstudio/sdk"),
    } });
    let settled = false;
    const finish = async (value?: LMStudioPromptCount, error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      await worker.terminate(); error ? reject(error) : resolve(value!);
    };
    const abort = () => { void finish(undefined, abortError()); };
    const timer = setTimeout(() => { void finish(undefined, new Error("LM Studio prompt counting timed out.")); }, 15000);
    worker.once("message", message => { void finish(message.value, message.error ? new Error(message.error) : undefined); });
    worker.once("error", error => { void finish(undefined, error instanceof Error ? error : new Error(String(error))); });
    worker.once("exit", code => { if (!settled) void finish(undefined, new Error(`LM Studio counting stopped without a result (${code}).`)); });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
  return resultSchema.parse(result);
}
