import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { planArtifactTests } from "../src/main/agent/artifact-test-plan.js";
import { fileDigest } from "../src/main/harness/tools/edit-file.js";
import { createRunDirectories, dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import type { AgentRequirement } from "../src/shared/contracts.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";

describe("Test planning for exported repairs",()=>{
  let root:string, previous:string, workspace:string, context:ToolExecutionContext;
  const source="def value():\n    return 0\n", repaired="def value():\n    return 1\n";
  const requirement:AgentRequirement={id:"r-repair",kind:"change",description:"Repair value.py",source:{messageId:randomUUID(),start:0,end:15,quote:"Repair value.py"},mandatory:true,dependencies:[],state:"active",acceptance:[]};
  beforeEach(()=>{
    root=mkdtempSync(path.join(tmpdir(),"artifact-plan-"));previous=dataRoot();setDataDir(root);workspace=path.join(root,"project");mkdirSync(workspace);mkdirSync(path.join(workspace,"src"));mkdirSync(path.join(workspace,"tests"));
    writeFileSync(path.join(workspace,"src/value.py"),source);writeFileSync(path.join(workspace,"tests/test_value.py"),"import unittest\nclass Tests(unittest.TestCase):\n    def test_value(self): self.assertTrue(True)\n");
    const runId=randomUUID(),inputDir=path.join(createRunDirectories(runId),"input");writeFileSync(path.join(inputDir,"value.py"),source);
    context={runId,workspaceRoot:workspace,gateway:{} as any,inputSources:[{id:randomUUID(),filename:"value.py",relativePath:`runs/${runId}/input/value.py`,sha256:fileDigest(source)}]};
  });
  afterEach(()=>{setDataDir(previous);rmSync(root,{recursive:true,force:true});});
  it("maps one pinned source to one workspace target and existing tests",()=>{
    const result=planArtifactTests(context,requirement,{filename:"repaired.py",sha256:fileDigest(repaired)});
    expect(result).toMatchObject({ok:true,targetPath:"src/value.py",sourceDigest:fileDigest(source),artifactDigest:fileDigest(repaired)});
    if(result.ok)expect(result.plans.some(plan=>plan.testFiles.includes("tests/test_value.py"))).toBe(true);
  });
  it("rejects ambiguous or stale mappings and unchanged exports",()=>{
    mkdirSync(path.join(workspace,"other"));writeFileSync(path.join(workspace,"other/value.py"),source);
    expect(planArtifactTests(context,requirement,{filename:"repaired.py",sha256:fileDigest(repaired)})).toMatchObject({ok:false,reason:"artifact_target_ambiguous"});
    rmSync(path.join(workspace,"other"),{recursive:true});writeFileSync(path.join(workspace,"src/value.py"),"changed");
    expect(planArtifactTests(context,requirement,{filename:"repaired.py",sha256:fileDigest(repaired)})).toMatchObject({ok:false,reason:"artifact_target_ambiguous"});
    expect(planArtifactTests(context,requirement,{filename:"repaired.py",sha256:fileDigest(source)})).toMatchObject({ok:false,reason:"artifact_unchanged"});
  });
  it("rejects a changed staged input and missing existing test setup",()=>{
    writeFileSync(path.join(root,context.inputSources![0].relativePath),"changed");
    expect(planArtifactTests(context,requirement,{filename:"repaired.py",sha256:fileDigest(repaired)})).toMatchObject({ok:false,reason:"artifact_test_plan_unavailable"});
    writeFileSync(path.join(root,context.inputSources![0].relativePath),source);rmSync(path.join(workspace,"tests"),{recursive:true});
    expect(planArtifactTests(context,requirement,{filename:"repaired.py",sha256:fileDigest(repaired)})).toMatchObject({ok:false,reason:"no_usable_test_setup"});
  });
  it("requires a unique staged source when the instruction does not name one",()=>{
    const other="def other():\n    return 0\n",filename="other.py";
    writeFileSync(path.join(root,`runs/${context.runId}/input/${filename}`),other);
    context.inputSources!.push({id:randomUUID(),filename,relativePath:`runs/${context.runId}/input/${filename}`,sha256:fileDigest(other)});
    const generic={...requirement,description:"Repair the attached code",source:{...requirement.source,quote:"Repair the attached code"}};
    expect(planArtifactTests(context,generic,{filename:"repaired.py",sha256:fileDigest(repaired)})).toMatchObject({ok:false,reason:"artifact_source_ambiguous"});
  });
});
