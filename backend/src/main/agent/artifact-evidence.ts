import { statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolExecutionContext } from "../tools/types.js";
import { getDb } from "../persistence/db.js";
import { getExecutionLedger } from "../run/execution-ledger.js";
import { getAgentTaskBinding, listAgentTaskRuns } from "../run/agent-task-store.js";
import { resolveRunPath, sha256File } from "../run/filesystem.js";
import { parseFileIndependently } from "../tools/file-worker.js";
import { agentEvidenceRecords, agentEvidenceStore } from "./task-evidence.js";

const artifactSchema = z.object({ artifactId:z.string().uuid(), filename:z.string().min(1), relativePath:z.string().min(1), kind:z.enum(["docx","xlsx","pdf","csv","json","md","txt"]), sizeBytes:z.number().int().positive().max(64*1024*1024), sha256:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const outcomeSchema = z.object({ requirementId:z.string().min(1), output:z.string(), artifacts:z.array(artifactSchema).min(1).max(8) }).strict();
type Artifact = z.infer<typeof artifactSchema> & {runId:string; requirementId:string; resultId:string};

export function hasAgentArtifactAction(context: ToolExecutionContext): boolean {
  const runs = getAgentTaskBinding(context.runId) ? listAgentTaskRuns(context.runId) : [context.runId];
  return runs.some(runId => getExecutionLedger(runId)?.completedOperations.some(operation => operation.artifactRefs.length));
}

/** Only completed operations in this task can contribute an artifact. */
export function agentArtifactOutcomes(context: ToolExecutionContext): Artifact[] {
  const runs = getAgentTaskBinding(context.runId) ? listAgentTaskRuns(context.runId) : [context.runId];
  const records = agentEvidenceRecords(context, "execution");
  const outcomes:Artifact[] = [];
  for (const runId of runs) for (const operation of getExecutionLedger(runId)?.completedOperations ?? []) {
    if (!operation.artifactRefs.length) continue;
    const record = records.find(item => item.runId === runId && item.producer.callId === operation.callId && item.producer.tool === operation.tool && item.status === "complete" && operation.resultIds.includes(item.resultId));
    if (!record) throw new Error("A completed artifact action has no saved execution evidence.");
    const store = agentEvidenceStore(context, record.resultId);
    if (!store.verifyIntegrity(record.resultId).valid) throw new Error("Artifact execution evidence failed its integrity check.");
    const outcome = outcomeSchema.parse(JSON.parse(store.readResultPayload(record.resultId)));
    if (outcome.artifacts.length !== operation.artifactRefs.length || outcome.artifacts.some(item => !operation.artifactRefs.some(ref => ref.artifactId === item.artifactId && ref.relativePath === item.relativePath && ref.filename === item.filename))) throw new Error("Artifact execution evidence does not match the completed action.");
    outcomes.push(...outcome.artifacts.map(item => ({...item,runId,requirementId:outcome.requirementId,resultId:record.resultId})));
  }
  return outcomes;
}

export function currentAgentArtifact(artifact:Artifact): string {
  const prefix=`runs/${artifact.runId}/output/`;
  if (!artifact.relativePath.startsWith(prefix)) throw new Error("Artifact is outside its run output.");
  const row=getDb().prepare("SELECT kind,filename,relative_path,size_bytes,sha256 FROM artifacts WHERE run_id=? AND artifact_id=?").get(artifact.runId,artifact.artifactId) as {kind:string;filename:string;relative_path:string;size_bytes:number;sha256:string|null}|undefined;
  if (!row || row.kind !== artifact.kind || row.filename !== artifact.filename || row.relative_path !== artifact.relativePath || row.size_bytes !== artifact.sizeBytes || row.sha256 !== artifact.sha256) throw new Error(`Artifact registration is missing or changed: ${artifact.filename}.`);
  const file=resolveRunPath(artifact.runId, artifact.relativePath.slice(`runs/${artifact.runId}/`.length), "output"), stat=statSync(file);
  if (!stat.isFile() || stat.size !== artifact.sizeBytes || sha256File(file) !== artifact.sha256) throw new Error(`Artifact bytes changed: ${artifact.filename}.`);
  const extension=path.extname(artifact.filename).slice(1).toLowerCase();
  const accepted:Record<string,string[]>={docx:["docx"],xlsx:["xlsx"],pdf:["pdf"],csv:["csv"],json:["json"],md:["md"],txt:["txt","py","sh","sql","log","ts","tsx","js","jsx","c","cpp","h","java","rs"]};
  if (!accepted[artifact.kind].includes(extension)) throw new Error(`Artifact format does not match its filename: ${artifact.filename}.`);
  return file;
}

/** Parse the current saved file independently. A bounded excerpt is review input, not proof of semantic completeness. */
export async function inspectAgentArtifacts(context: ToolExecutionContext) {
  const artifacts=agentArtifactOutcomes(context), inspected=[];
  for (const artifact of artifacts) {
    const file=currentAgentArtifact(artifact);
    const parsed=await parseFileIndependently(file, artifact.kind, context.signal);
    currentAgentArtifact(artifact);
    inspected.push({...artifact, text:parsed.text, headings:parsed.headings, sheets:parsed.sheets, rowCount:parsed.rowCount});
  }
  return inspected;
}
