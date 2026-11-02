import { agentEvidenceStore, agentEvidenceRecords } from "./task-evidence.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentRequirement, SourceReadReceipt } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { getExecutionLedger, updateAgentProgress } from "../run/execution-ledger.js";
import { fileDigest, readAgentSourceBytes } from "../harness/tools/edit-file.js";
import { captureAgentVerificationManifest, isAgentTestPath, type AgentFailureLocation } from "./test-verification.js";
import type { ToolDispatcher } from "./tool-dispatcher.js";
import { assertRuntimeActive } from "../run/runtime-scope.js";
import { sourcePageCursor } from "./workspace-actions.js";

/** Incomplete literal import hints. They select contained reads, never executable code or authority. */
function relativeSourceImports(root:string,filename:string,manifest:Record<string,string>):string[] {
  let content:string;
  try { content=readAgentSourceBytes(root,filename).subarray(0,32768).toString(); } catch {return [];}
  const imported=new Set<string>();
  for(const match of content.matchAll(/\b(?:from\s*|import\s*|require\s*\(\s*)["'](\.[^"'\r\n]+)["']/g)){
    const base=path.posix.normalize(path.posix.join(path.posix.dirname(filename),match[1]));
    if(base.startsWith("../") || path.posix.isAbsolute(base))continue;
    const resolved=[base,...[".js",".mjs",".cjs",".ts",".tsx",".jsx"].map(ext=>base+ext),...["index.js","index.ts"].map(name=>path.posix.join(base,name))].find(candidate=>Object.hasOwn(manifest,candidate));
    if(resolved)imported.add(resolved);
    if(imported.size>=16)break;
  }
  return [...imported];
}

/** Obtain source from the saved failed check; failed test imports can identify missing modules. */
export async function obtainAgentFailureSources(context: ToolExecutionContext, dispatcher: ToolDispatcher, hints: AgentFailureLocation[] = []): Promise<void> {
  const ledger=getExecutionLedger(context.runId);
  const failed=[...(ledger?.verification?.evidence ?? [])].reverse().find(check=>check.status === "failed" && check.sourceManifest && check.revision);
  if(!failed?.sourceManifest || !failed.revision)return;
  const manifest=Object.fromEntries(Object.entries(failed.sourceManifest).filter((entry):entry is [string,string]=>typeof entry[1] === "string" && /^[a-f0-9]{64}$/.test(entry[1])));
  const locations=[...new Map(hints.filter(hint=>Object.hasOwn(manifest,hint.path)).map(hint=>[hint.path,hint])).values()].slice(0,16);
  const testPaths=locations.filter(location=>isAgentTestPath(location.path)).map(location=>location.path);
  const imports=new Map<string,string[]>();
  for(const testPath of testPaths)for(const file of relativeSourceImports(context.workspaceRoot,testPath,manifest)){
    const users=imports.get(file) ?? [];users.push(testPath);imports.set(file,users);
  }
  const direct=locations.filter(location=>!isAgentTestPath(location.path));
  const uniqueImports=[...imports].filter(([file,users])=>users.length === 1 && !isAgentTestPath(file) && !direct.some(location=>location.path === file));
  const targets=[
    ...direct.map(location=>({...location,role:"implementation" as const,testPaths:imports.get(location.path) ?? []})),
    ...uniqueImports.map(([file,users])=>({path:file,line:1,role:"implementation" as const,testPaths:users})),
    ...locations.filter(location=>isAgentTestPath(location.path)).map(location=>({...location,role:"test" as const,testPaths:[location.path]})),
    ...[...imports].filter(([file])=>!direct.some(location=>location.path === file) && !uniqueImports.some(([name])=>name === file)).map(([file,users])=>({path:file,line:1,role:"dependency" as const,testPaths:users})),
  ].slice(0,16).map(location=>({...location,digest:manifest[location.path]}));
  const observed:Array<typeof targets[number] & {resultId?:string}>=[];
  for(const location of targets.slice(0,4)){
    assertRuntimeActive();context.assertAuthority?.();
    let startLine=Math.max(1,location.line-8);
    try { const bytes=readAgentSourceBytes(context.workspaceRoot,location.path);if(fileDigest(bytes)!==location.digest)continue;if(bytes.length<=2000)startLine=1; }
    catch {continue;}
    const [result]=await dispatcher.dispatchConcurrent([{id:randomUUID(),name:"read_file",arguments:{path:location.path,start_line:startLine,max_bytes:2000}}],context);
    assertRuntimeActive();
    observed.push({...location,...(result.result.ok && result.result.resultRef ? {resultId:result.result.resultRef.resultId} : {})});
  }
  updateAgentProgress(context.runId,progress=>{
    progress.sourceResultIds=[...new Set([...progress.sourceResultIds,...observed.flatMap(location=>location.resultId ?? [])])].slice(-16);
    progress.failure={revision:failed.revision!,resultIds:failed.evidence.filter(ref=>ref.kind === "result").map(ref=>ref.id).slice(0,16),
      targets:targets.map(location=>({...location,...(observed.find(item=>item.path === location.path)?.resultId ? {resultId:observed.find(item=>item.path === location.path)!.resultId!} : {})}))};
  });
}

/** Host work focus. A changed digest retires a failure hint, not a requirement or a test failure. */
export function selectAgentFailureStep(context:ToolExecutionContext){
  const ledger=getExecutionLedger(context.runId),failure=ledger?.agentProgress?.failure;
  if(!failure)return;
  const accepted=ledger.verification?.evidence.find(check=>check.criterionId === "acceptance:validate-written-code" && check.status === "passed" && check.revision === captureAgentVerificationManifest(context.workspaceRoot).sha256);
  if(accepted)return;
  const unchanged=failure.targets.filter(target=>{
    try{return fileDigest(readAgentSourceBytes(context.workspaceRoot,target.path)) === target.digest;}catch{return false;}
  });
  const implementations=failure.targets.filter(target=>target.role === "implementation");
  const target=unchanged.find(target=>target.role === "implementation") ?? (!implementations.length ? unchanged.find(target=>target.role === "test") : undefined);
  return {phase:target ? "address_failure" as const : "check_changes" as const,failedRevision:failure.revision,executionResultIds:failure.resultIds,
    ...(target ? {target,relatedPaths:[target.path,...target.testPaths]} : {}),
    rule:target ? "The host has already reproduced failed tests. Address this candidate source and its test evidence. Read only additional source needed for this step. Propose an edit only when the user requested it. The host checks scope, inspected ranges, and concrete approval. Import and failure paths are incomplete hints, not permission or proof." : "The candidate implementation revisions changed. Propose verification or delivery when ready; the host must check current tests and every requirement. Changed bytes alone do not prove a repair."};
}

const pageSchema = z.object({
  sourcePage: z.literal(true), path: z.string(), digest: z.string(),
  startByte: z.number().int().nonnegative(), endByte: z.number().int().nonnegative(), sizeBytes: z.number().int().nonnegative(),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  content: z.string(), complete: z.boolean(), nextCursor: z.string().optional(),
}).strict();
export type AgentSourcePage = z.infer<typeof pageSchema> & { resultId: string };

/** Repage immutable evidence, without rereading a changing file or granting unseen ranges. */
export function sliceAgentSourcePage(page: AgentSourcePage, maxBytes: number): AgentSourcePage {
  z.number().int().min(64).max(4000).parse(maxBytes);
  const bytes=Buffer.from(page.content);
  if(bytes.length<=maxBytes)return page;
  let length=maxBytes;
  while(length>0 && (bytes[length]&0xc0) === 0x80)length--;
  const content=bytes.subarray(0,length).toString(),endByte=page.startByte+length;
  return {...page,content,endByte,endLine:page.startLine+content.split("\n").length-1,complete:false,
    nextCursor:sourcePageCursor(page.path,page.digest,endByte)};
}

/** Read complete stored pages only. Partial JSON is never source authority. */
export function loadAgentSourcePage(context: ToolExecutionContext, resultId: string): AgentSourcePage | undefined {
  const store = agentEvidenceStore(context,resultId), record = store.getResult(resultId);
  if (record.producer.tool !== "read_file" || record.origin !== "source_extracted" || record.storage.encoding !== "json") return;
  const first = store.retrieveResultSlice(resultId, { mode: "text", maxChars: 3000 });
  if (first.totalChars > 12000) return;
  let content = first.content, offset = first.nextOffset;
  while (offset !== undefined) {
    const next = store.retrieveResultSlice(resultId, { mode: "text", offset, maxChars: 3000 });
    content += next.content; offset = next.nextOffset;
  }
  const parsed = pageSchema.safeParse(JSON.parse(content));
  if (!parsed.success) return;
  const page = parsed.data;
  if (page.endByte > page.sizeBytes || page.endByte - page.startByte !== Buffer.byteLength(page.content) ||
      page.complete !== (page.startByte === 0 && page.endByte === page.sizeBytes)) throw new Error("Stored source page has inconsistent byte coverage.");
  return { ...page, resultId };
}

export function sourcePageReceipt(page: AgentSourcePage): Omit<SourceReadReceipt, "requestId"> {
  return { path: page.path, digest: page.digest, startByte: page.startByte, endByte: page.endByte, sizeBytes: page.sizeBytes, resultId: page.resultId };
}

export function sourcePageIsCurrent(context: ToolExecutionContext, page: AgentSourcePage): boolean {
  try { return fileDigest(readAgentSourceBytes(context.workspaceRoot, page.path)) === page.digest; }
  catch { return false; }
}

/** Selection hints affect context only. They establish neither acceptance nor authority. */
export function selectAgentSourcePages(context: ToolExecutionContext, requirement: AgentRequirement, latest: AgentSourcePage | undefined, focus: string, maxChars: number, preferredPaths: string[] = []) {
  const progress = getExecutionLedger(context.runId)?.agentProgress;
  const ids = [...new Set([
    ...agentEvidenceRecords(context,"source_extracted").filter(record=>record.producer.tool === "read_file").map(record=>record.resultId),
    ...(progress?.sourceResultIds ?? []),
    ...(progress?.reads.map(read => read.resultId) ?? []),
    ...(progress?.actions.filter(action => action.operation === "read_file" && action.status === "completed").flatMap(action => action.resultId ?? []) ?? []),
  ])].reverse().filter(id => id !== latest?.resultId);
  const currentDigests = new Map<string, string | null>();
  const candidates = ids.flatMap((id, index) => {
    const page = loadAgentSourcePage(context, id);
    if (!page) return [];
    if (!currentDigests.has(page.path)) {
      try { currentDigests.set(page.path, fileDigest(readAgentSourceBytes(context.workspaceRoot, page.path))); }
      catch { currentDigests.set(page.path, null); }
    }
    if (currentDigests.get(page.path) !== page.digest || (latest && page.path === latest.path && page.digest === latest.digest && page.startByte === latest.startByte && page.endByte === latest.endByte)) return [];
    const explicit = requirement.acceptance.some(check => check.path === page.path) || requirement.source.quote.includes(page.path) || requirement.description.includes(page.path);
    const relative = latest ? path.posix.relative(path.posix.dirname(latest.path), page.path) : "";
    const referenced = !!latest && [page.path, relative.startsWith(".") ? relative : `./${relative}`].some(name => latest.content.includes(`"${name}"`) || latest.content.includes(`'${name}'`));
    const sameRequirement = progress?.actions.some(action => action.resultId === id && action.requirementId === requirement.id);
    const priority=preferredPaths.indexOf(page.path);
    return [{ page, index, score: (priority >= 0 ? (preferredPaths.length-priority)*32 : 0) + (explicit ? 8 : 0) + (referenced || focus.includes(page.path) ? 4 : 0) + (sameRequirement ? 1 : 0) }];
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const pages: AgentSourcePage[] = []; let usedChars = 0;
  const ranges = new Set<string>();
  for (const { page } of candidates) {
    const key = `${page.path}:${page.digest}:${page.startByte}:${page.endByte}`;
    if (ranges.has(key)) continue;
    ranges.add(key);
    const size = JSON.stringify(page).length;
    if (pages.length >= 3 || usedChars + size > maxChars) continue;
    pages.push(page); usedChars += size;
  }
  return { pages, totalEligiblePages: ranges.size, complete: pages.length === ranges.size,
    ...(pages.length < ranges.size ? { omittedPagesVia: { tool: "retrieve_result", action: "list", scope:"task", origin:"source_extracted" } } : {}),
    rule: "These are complete observed pages of currently matching source revisions. Page coverage is explicit. Selection does not prove requirement coverage; retrieve omitted pages when needed." };
}
