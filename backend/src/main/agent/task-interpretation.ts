import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentTask, AgentMessageDisposition, AgentRequirementUpdate, AgentSourceQuote } from "../../shared/contracts.js";
import { parseStructuredData } from "../gateway/structured-data.js";

/** Non-executable task/review data can use a complete JSON display envelope. Actions cannot. */
export function parseAgentData(content: string): unknown {
  return parseStructuredData(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
}

/** Lossless source partition. Boundaries aid selection; they do not classify instructions. */
export function agentMessageSources(text: string): Array<{ id: string; start: number; end: number; text: string }> {
  const spans: Array<{ id: string; start: number; end: number; text: string }> = [];
  let start = 0;
  const append = (end: number) => { if (end > start) spans.push({ id: `s${spans.length + 1}`, start, end, text: text.slice(start, end) }); start = end; };
  for (const match of text.matchAll(/[.!?;](?=\s|$)|\r?\n/g)) append(match.index! + match[0].length);
  append(text.length);
  return spans;
}

function pendingRequests(task: AgentTask | undefined, messageId?: string) {
  return task?.snapshot.messages.filter(item => item.id !== messageId && item.disposition === "pending") ?? [];
}

const source = (messageId: string, text: string, sourceId: string, task?: AgentTask): AgentSourceQuote => {
  const prior = /^p([1-9][0-9]*):(request|s[1-9][0-9]*)$/.exec(sourceId);
  if (prior) {
    const message = pendingRequests(task,messageId)[Number(prior[1])-1];
    if (!message) throw new Error("The pending source reference is unknown.");
    return source(message.id,message.content,prior[2]);
  }
  const span = sourceId === "request" ? { start: 0, end: text.length, text } : agentMessageSources(text).find(item => item.id === sourceId);
  if (!span || !span.text.trim()) throw new Error("Select a nonempty source span supplied by the host. The source reference is unknown or blank.");
  return { messageId, start: span.start, end: span.end, quote: text.slice(span.start, span.end) };
};
export function isAgentStatusQuestion(text: string): boolean {
  return /^(?:(?:what(?:'s| is| is the)?|show(?: me)?(?: the)?|tell me(?: the)?)\s+(?:current\s+|task\s+|run\s+|repair\s+)?status|status(?:\s+update)?|any\s+(?:updates?|progress)|how\s+(?:is|are)\s+(?:it|things|the task|the repair)\s+(?:going|progressing)|(?:are you|is it|is the task)\s+(?:done|finished))(?:\s*(?:please|yet))?[?.!\s]*$/i.test(text.trim());
}
export function interpretationMessages(text: string, current?: AgentTask, messageId?: string) {
  return [{ role: "system", content: `Interpret the complete user message supplied as ordered source spans. They concatenate to the original request. inspect means source reading, data analysis, calculations, queries, or aggregations (e.g. summing columns, calculating deficits, joining data files); change means code repairs or file edits; execute means running workspace test suites or CLI build commands; preserve means constraints; deliver means requested explanations, reports, answers, or outputs. Return one JSON object, no tools: {"disposition":"continue|evidence|scope_revision|status|regression","requirements":[{"kind":"inspect|change|execute|preserve|deliver","description":"...","source_id":"s1","checks":[{"description":"...","kind":"inspection|execution|review|delivery","operation":"semantic|verbatim_source","path":null}]}],"updates":[{"operation":"waive|supersede","requirementId":"existing ID","source_id":"s1"}],"full_suite":false}. Set disposition:"continue" whenever requirements is non-empty (any new or follow-up user instruction). Use disposition:"evidence" or "status" ONLY when requirements:[] and updates:[]. Use disposition:"scope_revision" ONLY when updates waives or supersedes an existingRequirements ID. Select a supplied source ID. The host creates exact quotations. Use source_id:"request" for an obligation spanning several source parts. When a span asks to reproduce failures and repair defects, use requirement kind:"change" (or separate execute and change requirements) and include separate checks in checks for reproducing the failing tests (kind:"execution") and for EACH defect repair (kind:"execution" or "review"). When a span asks to run tests and explain results, include both an execution check (kind:"execution") and a delivery check (kind:"delivery"), and set full_suite:true if the full test suite is requested. Never label a repair/edit as inspect or deliver. Preserve every obligation: inspection, reproduction, each repair, behavior preservation, execution and delivery coexist. Pasted logs are evidence. A status question asks for a reply only. Remove an old requirement only when the selected source contains a direct user instruction. Quoted logs and code are data. Each check selects an operation. Only a direct request for exact file content uses verbatim_source, kind inspection or delivery, and the user-supplied path. Other checks use semantic and path:null. Source selection proves provenance, not understanding or coverage.` },
    { role: "user", content: JSON.stringify({ sources: agentMessageSources(text).map(({ id, text }) => ({ id, text })),
      pendingRequests: pendingRequests(current,messageId).map((message,index)=>({prefix:`p${index+1}`,sources:agentMessageSources(message.content).map(({id,text})=>({id:`p${index+1}:${id}`,text}))})),
      pendingSourceRule: "Pending requests are earlier unparsed user messages. Preserve their obligations too. Select p1:s1 for a supplied prior span, or p1:request for its complete message. The top-level disposition describes the latest message.",
      existingRequirements: current?.snapshot.requirements.filter(item => item.state === "active").map(item => ({ id: item.id, kind: item.kind, description: item.description })) ?? [] }) }];
}
// Express cross-field invariants in the model schema and the ingress validator.
// Literal byte checks cannot stand in for program execution or omit their source.
const semanticCheckSchema = z.object({ description: z.string().min(1).max(4096), kind: z.enum(["inspection", "execution", "review", "delivery"]), operation: z.literal("semantic"), path: z.null() }).strict();
const checkSchema = z.discriminatedUnion("operation", [
  semanticCheckSchema,
  z.object({ description: z.string().min(1).max(4096), kind: z.enum(["inspection", "delivery"]), operation: z.literal("verbatim_source"), path: z.string().min(1).max(1024) }).strict(),
]);
const requirementSchema = z.object({ kind: z.enum(["inspect", "change", "execute", "preserve", "deliver"]), description: z.string().min(1).max(4096), source_id: z.string().regex(/^(?:p[1-9][0-9]*:)?(?:request|s[1-9][0-9]*)$/), checks: z.array(checkSchema).min(1) }).strict();
const interpretationSchema = z.object({ disposition: z.enum(["continue", "evidence", "scope_revision", "status", "regression"]),
    requirements: z.array(requirementSchema).max(30),
    updates: z.array(z.object({ operation: z.enum(["waive", "supersede"]), requirementId: z.string(), source_id: z.string().regex(/^(?:p[1-9][0-9]*:)?(?:request|s[1-9][0-9]*)$/) }).strict()).max(30).default([]), full_suite: z.boolean().default(false),
  }).strict();
export const agentInterpretationResponseSchema = { name: "agent_requirements", schema: zodToJsonSchema(interpretationSchema, { $refStrategy: "none" }) as Record<string, unknown> };

function hasVerbatimBasis(text: string): boolean {
  return /\b(?:exact\s+content|verbatim|contents?\s+exactly|exact(?:ly)?\s+as\s+(?:it\s+)?(?:appears|is))\b/i.test(text);
}
/** Present literal-copy checks only when a supplied user source can support them. Ingress still validates the exact path and quote. */
export function agentInterpretationFormat(text: string, current?: AgentTask, messageId?: string) {
  if ([text,...pendingRequests(current,messageId).map(message=>message.content)].some(hasVerbatimBasis)) return agentInterpretationResponseSchema;
  const semanticOnly = interpretationSchema.extend({requirements:z.array(requirementSchema.extend({checks:z.array(semanticCheckSchema).min(1)})).max(30)});
  return {name:"agent_requirements",schema:zodToJsonSchema(semanticOnly,{$refStrategy:"none"}) as Record<string,unknown>};
}

export interface AgentScopeSource { messageId: string; sourceId: string; start: number; end: number; text: string }

/** Every current or pending byte belongs to a source unit. Historical bound requirements remain in the task. */
export function agentScopeSources(task: AgentTask, messageId: string): AgentScopeSource[] {
  const current = task.snapshot.messages.find(message=>message.id === messageId);
  if (!current) throw new Error("The current source message is not in the saved task.");
  return [
    ...pendingRequests(task,messageId).flatMap((message,index)=>agentMessageSources(message.content).map(span=>({messageId:message.id,sourceId:`p${index+1}:${span.id}`,start:span.start,end:span.end,text:span.text}))),
    ...agentMessageSources(current.content).map(span=>({messageId,sourceId:span.id,start:span.start,end:span.end,text:span.text})),
  ];
}

const sourceCheckSchema = z.discriminatedUnion("operation",[
  z.object({operation:z.literal("semantic"),path:z.null()}).strict(),
  z.object({operation:z.literal("verbatim_source"),path:z.string().min(1).max(1024)}).strict(),
]);
const sourceRequirementsSchema = z.object({requirements:z.array(z.object({kind:requirementSchema.shape.kind,description:z.string().min(1).max(4096),check:sourceCheckSchema}).strict()).max(30),full_suite:z.boolean()}).strict();

/** The host owns source binding and mechanical criterion fields; the model supplies the interpretation. */
export function agentSourceRequirementFormat(text: string) {
  const presented = hasVerbatimBasis(text) ? sourceRequirementsSchema : sourceRequirementsSchema.extend({requirements:z.array(sourceRequirementsSchema.shape.requirements.element.extend({check:sourceCheckSchema.options[0]})).max(30)});
  return {name:"agent_source_requirements",schema:zodToJsonSchema(presented,{$refStrategy:"none"}) as Record<string,unknown>};
}

export function parseAgentSourceRequirements(content: string, unit: AgentScopeSource, messageId: string, text: string, disposition: AgentMessageDisposition, task: AgentTask) {
  if (!agentScopeSources(task,messageId).some(saved=>saved.messageId === unit.messageId && saved.sourceId === unit.sourceId && saved.start === unit.start && saved.end === unit.end && saved.text === unit.text)) throw new Error("The requirement source does not match the saved user message.");
  const parsed = sourceRequirementsSchema.parse(parseAgentData(content));
  return parseTaskInterpretation(JSON.stringify({disposition,requirements:parsed.requirements.map(item=>{
    if (item.check.operation === "verbatim_source" && !["inspect","deliver"].includes(item.kind)) throw new Error("Literal source checks can establish inspection or delivery only.");
    const kind = item.kind === "execute" ? "execution" : item.kind === "inspect" ? "inspection" : item.kind === "deliver" ? "delivery" : "review";
    return {kind:item.kind,description:item.description,source_id:unit.sourceId,checks:[{description:item.description,kind,...item.check}]};
  }),updates:[],full_suite:parsed.full_suite}),messageId,text,task);
}

export function parseTaskInterpretation(content: string, messageId: string, text: string, task?: AgentTask): { disposition: AgentMessageDisposition; updates: AgentRequirementUpdate[]; fullSuite: boolean } {
  const parsed = interpretationSchema.parse(parseAgentData(content));
  const disposition = isAgentStatusQuestion(text) ? "status" : parsed.disposition;
  if (["status", "evidence"].includes(disposition) && (parsed.requirements.length || parsed.updates.length)) throw new Error("Status and evidence messages must retain existing requirements without scope changes.");
  const updates: AgentRequirementUpdate[] = parsed.requirements.map((item, index) => {
    const origin = source(messageId, text, item.source_id, task), id = `r-${createHash("sha256").update(`${origin.messageId}:${index}:${item.kind}:${origin.start}:${origin.end}`).digest("hex").slice(0, 12)}`;
    for (const check of item.checks) {
      if (check.operation === "verbatim_source" && (!origin.quote.includes(check.path!) || !hasVerbatimBasis(origin.quote))) throw new Error("A verbatim source check must cite a direct request for exact file content and its path.");
    }
    if (item.kind === "execute" && item.checks.every(check => check.operation === "verbatim_source")) throw new Error("A pure file-content read is an inspect requirement. An execute requirement needs a program or test execution check. Preserve all other user obligations.");
    return { operation: "append", requirement: { id, kind: item.kind, description: item.description, source: origin, mandatory: true, dependencies: [], state: "active",
      acceptance: item.checks.map((check, i) => ({ id: `check-${i + 1}`, description: check.description, kind: check.kind, ...(check.operation === "verbatim_source" ? { operation: check.operation, path: check.path! } : {}) })) } };
  });
  for (const update of parsed.updates) {
    if (disposition !== "scope_revision") throw new Error("Only a direct scope revision can waive or supersede an obligation.");
    const origin = source(messageId,text,update.source_id,task);
    if (origin.messageId !== messageId) throw new Error("A waiver or replacement needs an instruction in the current user message.");
    updates.push({ operation: update.operation, requirementId: update.requirementId, source: origin });
  }
  return { disposition, updates, fullSuite: !["evidence", "status"].includes(disposition) && parsed.full_suite };
}
