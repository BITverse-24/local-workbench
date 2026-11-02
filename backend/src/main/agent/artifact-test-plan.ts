import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentRequirement } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { readAgentInputBytes } from "./workspace-actions.js";
import { captureAgentVerificationManifest, discoverAgentTestPlans, isAgentTestPath, isCodeVerificationPath } from "./test-verification.js";
import { agentArtifactOutcomes, currentAgentArtifact } from "./artifact-evidence.js";
import { getAgentTask, getAgentTaskBinding } from "../run/agent-task-store.js";

/** A test target is eligible only when one pinned input identifies one unchanged
 * workspace file. This selection grants no execution or publication authority. */
export function planArtifactTests(context:ToolExecutionContext, requirement:AgentRequirement, artifact:{filename:string;sha256:string}) {
  try {
    const extension=path.extname(artifact.filename).toLowerCase();
    const inputs=(context.inputSources ?? []).filter(source=>isCodeVerificationPath(source.filename) && !isAgentTestPath(source.filename) && path.extname(source.filename).toLowerCase()===extension);
    const named=inputs.filter(source=>{
      const escaped=source.filename.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      return new RegExp(`(^|[^\\w/\\\\.-])${escaped}(?=$|[^\\w/\\\\.-]|\\.(?=\\s|$))`).test(requirement.source.quote);
    });
    const candidates=named.length ? named : inputs;
    if(candidates.length!==1)return {ok:false as const,reason:"artifact_source_ambiguous",detail:"The exported repair does not identify one staged source. Select the source and its existing tests."};
    const source=candidates[0];readAgentInputBytes(context,source.id);
    if(source.sha256===artifact.sha256)return {ok:false as const,reason:"artifact_unchanged",detail:"The exported repair has the same bytes as the staged source."};
    const manifest=captureAgentVerificationManifest(context.workspaceRoot);
    const paths=Object.entries(manifest.files).filter(([name,digest])=>path.posix.basename(name)===source.filename && digest===source.sha256 && !isAgentTestPath(name)).map(([name])=>name);
    if(paths.length!==1)return {ok:false as const,reason:"artifact_target_ambiguous",detail:"The staged source does not match exactly one current workspace file. Tests cannot be mapped safely."};
    const discovery=discoverAgentTestPlans({workspaceRoot:context.workspaceRoot,changedPaths:paths});
    if(!discovery.ok)return discovery;
    return {ok:true as const,sourceId:source.id,sourceDigest:source.sha256,artifactDigest:artifact.sha256,targetPath:paths[0],manifestSha256:manifest.sha256,plans:discovery.plans};
  } catch(error) { return {ok:false as const,reason:"artifact_test_plan_unavailable",detail:String(error)}; }
}

/** The identity covers every input to execution, including the task revision.
 * Rebuilding it also checks the pinned input and registered artifact again. */
export function bindArtifactTests(context:ToolExecutionContext, requirement:AgentRequirement, artifact:ReturnType<typeof agentArtifactOutcomes>[number], fullSuite:boolean) {
  const resolve = () => {
    const task = getAgentTaskBinding(context.runId);
    if (!task) throw new Error("The exported repair has no bound task.");
    const current = getAgentTask(task.taskId);
    if (!current?.current || current.snapshot.revision !== task.taskRevision || current.workspace.root !== context.workspaceRoot || !current.snapshot.requirements.some(item=>item.id===requirement.id && item.state === "active")) throw new Error("The exported repair task binding is no longer current.");
    if (!agentArtifactOutcomes(context).some(item=>item.artifactId===artifact.artifactId && item.runId===artifact.runId && item.resultId===artifact.resultId && item.requirementId===requirement.id && item.sha256===artifact.sha256)) throw new Error("The exported repair's saved action evidence is no longer current.");
    const artifactPath = currentAgentArtifact(artifact);
    const plan = planArtifactTests(context, requirement, artifact);
    if (!plan.ok) throw new Error(plan.detail);
    const operation = {artifactPath,artifactDigest:artifact.sha256,sourceDigest:plan.sourceDigest,targetPath:plan.targetPath};
    const revision = createHash("sha256").update(JSON.stringify([task.taskId,task.taskRevision,requirement.id,artifact.runId,artifact.artifactId,artifact.resultId,plan.sourceId,operation,plan.manifestSha256,fullSuite])).digest("hex");
    return {operation,revision,targetPath:plan.targetPath};
  };
  const selected=resolve();
  return {...selected,criterionId:`acceptance:validate-export:${artifact.artifactId}`,assertCurrent:()=>{
    if(resolve().revision!==selected.revision)throw new Error("The exported repair or its test inputs changed.");
  }};
}
