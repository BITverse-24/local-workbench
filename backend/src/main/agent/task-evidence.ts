import { getDb } from "../persistence/db.js";
import { z } from "zod";
import type { AgentTask, AgentTaskFacts, IntermediateResultRecord, ResultOrigin } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { getAgentTaskBinding, listAgentTaskRuns, listTaskEvidence, taskEvidenceStore } from "../run/agent-task-store.js";
import { getExecutionLedger } from "../run/execution-ledger.js";
import { existsSync } from "node:fs";
import { resolveSafe } from "../harness/path-guard.js";
import { fileDigest, readAgentSourceBytes } from "../harness/tools/edit-file.js";

/** Existing unbound tool callers retain run-only access. Bound v3 calls use the task owner. */
export function agentEvidenceStore(context: ToolExecutionContext, resultId: string) {
  context.assertAuthority?.();
  return getAgentTaskBinding(context.runId) ? taskEvidenceStore(context.runId,resultId) : context.resultStore!;
}

export function agentEvidenceRecords(context: ToolExecutionContext, origin?: ResultOrigin): IntermediateResultRecord[] {
  context.assertAuthority?.();
  const bound=!!getAgentTaskBinding(context.runId), records:IntermediateResultRecord[]=[];
  for(let offset=0;;offset+=50) {
    const page=bound ? listTaskEvidence(context.runId,{limit:50,offset,origin}) : context.resultStore!.listResults({limit:50,offset,origin});
    records.push(...page);
    if(page.length<50)return records;
  }
}

/** Saved mutation outcomes remain in their original ledgers. Never import them as new operations. */
export function agentAppliedChanges(context: ToolExecutionContext) {
  const runIds=getAgentTaskBinding(context.runId) ? listAgentTaskRuns(context.runId) : [context.runId];
  return appliedChangesFromRuns(runIds);
}

function appliedChangesFromRuns(runIds:string[]) {
  const latest=new Map<string,{path:string;originRunId:string;callId:string;tool:string;summary:string}>();
  for(const runId of runIds) {
    const ledger=getExecutionLedger(runId);
    for(const operation of ledger?.completedOperations ?? []) {
      const attempt=ledger!.operationAttempts.find(item=>item.callId === operation.callId && item.status === "completed");
      if(attempt?.targetPath && ["write_file","edit_file","delete_file"].includes(operation.tool)) latest.set(attempt.targetPath,{path:attempt.targetPath,originRunId:runId,callId:operation.callId,tool:operation.tool,summary:operation.summary});
    }
  }
  return [...latest.values()];
}

/** A saved change is current only when its immutable outcome matches the live target. */
export function currentAgentChange(context: ToolExecutionContext, change: ReturnType<typeof agentAppliedChanges>[number], records: IntermediateResultRecord[]) {
  context.assertAuthority?.();
  const record=records.find(item=>item.runId === change.originRunId && item.producer.callId === change.callId && item.producer.tool === change.tool && item.status === "complete" && item.origin === "execution");
  if(!record || record.storage.sizeBytes>32768)return {ok:false as const,reason:`The applied change lacks saved evidence: ${change.path}.`};
  const store=agentEvidenceStore(context,record.resultId);
  let text="",offset:number|undefined=0;
  while(offset!==undefined) { const page=store.retrieveResultSlice(record.resultId,{mode:"text",offset,maxChars:3000});text+=page.content;offset=page.nextOffset; }
  const applied=z.object({afterDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).safeParse(JSON.parse(text));
  const current=existsSync(resolveSafe(context.workspaceRoot,change.path)) ? fileDigest(readAgentSourceBytes(context.workspaceRoot,change.path)) : null;
  if(!applied.success || current!==applied.data.afterDigest)return {ok:false as const,reason:`The saved change is no longer current: ${change.path}. Read it again before delivery.`};
  return {ok:true as const,digest:current,resultId:record.resultId};
}

/** Saved UI/status facts only. This does not inspect files or accept historical checks. */
export function savedAgentTaskFacts(task: AgentTask): AgentTaskFacts {
  const rows=getDb().prepare("SELECT run_id FROM agent_task_runs WHERE task_id=? AND task_revision<=? ORDER BY task_revision").all(task.taskId,task.snapshot.revision) as Array<{run_id:string}>;
  const runIds=rows.map(row=>row.run_id), latest=getExecutionLedger(task.latestRunId ?? runIds.at(-1) ?? "");
  const checks=runIds.flatMap(runId=>(getExecutionLedger(runId)?.verification?.evidence ?? []).map(check=>({runId,check})));
  const checkFact=({runId,check}:typeof checks[number])=>({reason:check.reason,originRunId:runId,historical:runId !== task.latestRunId,...(check.revision ? {revision:check.revision} : {})});
  const active=task.snapshot.requirements.filter(item=>item.state === "active" && item.mandatory);
  const remaining=latest?.agentProgress?.remainingRequirementIds ?? [];
  return {changesApplied:appliedChangesFromRuns(runIds).map(item=>({path:item.path,summary:item.summary,originRunId:item.originRunId,historical:item.originRunId !== task.latestRunId})),
    checksPassed:checks.filter(item=>item.check.status === "passed").map(checkFact),
    checksUnavailable:checks.filter(item=>item.check.status === "unverified").map(checkFact),
    checksFailed:checks.filter(item=>item.check.status === "failed").map(checkFact),
    checksSkipped:[...checks.filter(item=>item.check.status === "skipped").map(checkFact),...runIds.flatMap(runId=>{const waiver=getExecutionLedger(runId)?.verification?.userSkip;return waiver ? [{reason:`Tests skipped by user instruction: ${waiver.basis}`,originRunId:runId,historical:runId !== task.latestRunId}] : [];})],
    remainingRequirements:task.status === "completed" ? [] : active.filter(item=>!remaining.length || remaining.includes(item.id)).map(item=>({id:item.id,description:item.description})),
    stopReason:latest?.agentProgress?.stopReason};
}
