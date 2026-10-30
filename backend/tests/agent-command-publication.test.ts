import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";
import { captureCommandWorkspaceDigest, commandApprovalDigest, runCommand } from "../src/main/harness/tools/run-command.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";
import { executeProcess } from "../src/main/tools/child-process.js";

vi.mock("../src/main/tools/child-process.js", () => ({ executeProcess: vi.fn() }));
vi.mock("../src/main/harness/tools/write-file.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/main/harness/tools/write-file.js")>();
  return { ...original, writeFile: (...args: Parameters<typeof original.writeFile>) => {
    if (args[1] === "b.txt") throw new Error("simulated write failure");
    return original.writeFile(...args);
  } };
});
let workspace = "";
afterEach(() => { if (workspace) rmSync(workspace,{recursive:true,force:true}); vi.restoreAllMocks(); });

it("marks a failed multi-file publication uncertain and preserves earlier backups", async () => {
  workspace=mkdtempSync(path.join(tmpdir(),"command-publish-"));
  writeFileSync(path.join(workspace,"a.txt"),"old A");writeFileSync(path.join(workspace,"b.txt"),"old B");
  const command="echo perform-change", approval={workspaceDigest:captureCommandWorkspaceDigest(workspace)};
  const guard=new MutationPolicyGuard({strict:true});
  guard.grantScope({runId:"run",operation:"run_command",command,operationDigest:commandApprovalDigest(command,approval),allowUnisolated:true});
  vi.mocked(executeProcess).mockImplementation(async (_binary,args,options)=>{
    if(args.at(-1) === "printf WORKBENCH_ISOLATED")return {stdout:"WORKBENCH_ISOLATED",stderr:""};
    writeFileSync(path.join(options.cwd!,"a.txt"),"new A");writeFileSync(path.join(options.cwd!,"b.txt"),"new B");
    return {stdout:"done",stderr:""};
  });
  await expect(withRuntimeScope({runId:"run",mode:"agent",agentPhase:"actions",signal:new AbortController().signal},
    ()=>runCommand(workspace,command,5000,{guard,runId:"run",approval}))).rejects.toMatchObject({code:"persistence_failure",retryable:false,message:expect.stringContaining("publication may be incomplete")});
  expect(readFileSync(path.join(workspace,"a.txt"),"utf8")).toBe("new A");
  expect(readFileSync(path.join(workspace,"b.txt"),"utf8")).toBe("old B");
  expect(readdirSync(path.join(workspace,".harness_backups")).length).toBeGreaterThan(0);
});
