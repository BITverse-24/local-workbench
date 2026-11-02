import { z } from "zod";
import { getDb } from "../persistence/db.js";
import { listAgentTaskRuns } from "../run/agent-task-store.js";
import type { ToolExecutionContext } from "../tools/types.js";

const aliasSchema=z.object({id:z.string().min(1).max(256),filename:z.string().min(1).max(1024),relativePath:z.string().min(1).max(4096),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough();

/** Read saved run metadata only for earlier attempts bound to this task. */
export function priorAgentInputs(runId:string) {
  const result:Array<z.infer<typeof aliasSchema> & {originRunId:string}>=[];
  for(const originRunId of listAgentTaskRuns(runId)) {
    if(originRunId===runId)continue;
    const row=getDb().prepare("SELECT metrics_json FROM run_mode_details WHERE run_id=? AND mode='agent' AND engine_version='agent-v3'").get(originRunId) as {metrics_json:string|null}|undefined;
    if(!row?.metrics_json)continue;
    const metrics=JSON.parse(row.metrics_json), aliases=z.array(aliasSchema).max(100).parse(metrics.sourceAliases ?? []);
    for(const alias of aliases) {
      if(!alias.relativePath.startsWith(`runs/${originRunId}/input/`))throw new Error("Saved task input is outside its originating run.");
      result.push({...alias,originRunId});
    }
  }
  return result;
}

/** IDs remain stable only when their saved bytes and name agree across attempts. */
export function bindTaskInputs(context:ToolExecutionContext):void {
  const merged=new Map<string,NonNullable<ToolExecutionContext["inputSources"]>[number]>();
  for(const source of [...(context.inputSources ?? []),...priorAgentInputs(context.runId)]) {
    const previous=merged.get(source.id);
    if(previous && (previous.sha256!==source.sha256 || previous.filename!==source.filename))throw new Error("A task input ID has conflicting saved revisions. Submit a new source.");
    if(!previous)merged.set(source.id,source);
  }
  context.inputSources=[...merged.values()];
}
