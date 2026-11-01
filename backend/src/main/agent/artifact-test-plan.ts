import path from "node:path";
import type { AgentRequirement } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { readAgentInputBytes } from "./workspace-actions.js";
import { captureAgentVerificationManifest, discoverAgentTestPlans, isAgentTestPath, isCodeVerificationPath } from "./test-verification.js";

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
