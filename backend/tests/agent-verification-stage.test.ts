import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { createRunDirectories, setDataDir } from "../src/main/run/filesystem.js";
import { normalizeRunContract, persistRunContract } from "../src/main/run/contract.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { configureExecutionLedger, initializeExecutionLedger } from "../src/main/run/execution-ledger.js";
import { getRunVerificationState, recordVerificationUserSkip } from "../src/main/run/verification-controller.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { verifyRunEvidence } from "../src/main/run/verification.js";
import { runAgentVerificationStage } from "../src/main/agent/verification-stage.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";
import type { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";

let temporary: string, workspace: string, runId: string, context: ToolExecutionContext;
beforeEach(() => {
  temporary = mkdtempSync(path.join(tmpdir(), "verification-stage-"));
  workspace = path.join(temporary, "workspace"); mkdirSync(workspace);
  setDataDir(temporary); initDb(path.join(temporary, "workbench.sqlite"));
  runId = createRun(createChat(), "Fix the existing software"); createRunDirectories(runId);
  const intent = validateAndNormalizeIntent({ requestedAction: "modify_software", responseMode: "chat", primaryGoal: "Fix existing software", workspaceMutationRequested: true, targetFiles: ["module.js"], expectedDeliverables: [] }, { hasWorkspace: true, workspaceFiles: ["module.js"], userPrompt: "Fix module.js" });
  const contract = persistRunContract(normalizeRunContract(runId, intent, { mode: "agent", newRun: true }));
  const ledger = initializeExecutionLedger(contract);
  configureExecutionLedger(runId, { modelId: "primary-model", mode: "agent", workspaceRoot: workspace, groundingEnabled: false });
  context = { runId, workspaceRoot: workspace, gateway: {} as any, runContract: contract, executionLedger: ledger, resultStore: new RunResultStore(runId) };
});
afterEach(() => { closeDb(); rmSync(temporary, { recursive: true, force: true }); });

function setupProject(directory = ".") {
  const root = path.join(workspace, directory); mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(path.join(root, "module.js"), "export const value = 1;\n");
  writeFileSync(path.join(root, "module.test.js"), "import { test } from 'node:test'; test('value', () => {});\n");
}
function dispatcher(fail = false) {
  const dispatchConcurrent = vi.fn(async (calls: any[], active: ToolExecutionContext) => {
    const request = active.agentVerification!;
    const evidence = { planId: request.planId, command: request.command, phase: request.phase, runner: request.runner,
      manifestSha256: request.workspaceManifestSha256, sourceManifest: request.sourceManifest,
      exitCode: fail ? 1 : 0, timedOut: false, executed: 1, failed: fail ? 1 : 0, skipped: 0, testFiles: request.testFiles,
      ...(request.artifact ? {artifact:{targetPath:request.artifact.targetPath,sourceDigest:request.artifact.sourceDigest,artifactDigest:request.artifact.artifactDigest}} : {}) };
    const result = active.resultStore!.registerResult({ type: "execution", status: fail ? "partial" : "complete", origin: "execution", producer: { tool: "run_command", callId: calls[0].id }, summary: fail ? "An assertion failed" : "A test passed", payload: { exitCode: evidence.exitCode, timedOut: false, verification: evidence } });
    return [{ id: calls[0].id, name: "run_command", args: calls[0].arguments, result: { ok: !fail, toolName: "run_command", output: "Saved test evidence", summary: "Test execution", durationMs: 1, data: {}, resultRef: result,
      executionEvidence: { ...evidence, resultId: result.resultId }, ...(fail ? { error: { code: "validation_failure", message: "An assertion failed", retryable: true } } : {}) } }];
  });
  return { getTool: () => ({}), dispatchConcurrent } as unknown as ToolDispatcher & { dispatchConcurrent: typeof dispatchConcurrent };
}
const run = (tools: ToolDispatcher, changedPaths = ["module.js"]) => runAgentVerificationStage({ context, dispatcher: tools, changedPaths, authorize: async () => true });

describe("Agent verification stage", () => {
  it("binds an export to the approval, execution evidence, and separate revision", async () => {
    setupProject(); const tools=dispatcher(),operation={artifactPath:path.join(temporary,"export.js"),artifactDigest:"a".repeat(64),sourceDigest:"b".repeat(64),targetPath:"module.js"};
    const artifact={operation,criterionId:"acceptance:validate-export:r1",revision:"revision-1",assertCurrent:vi.fn()};
    const authorize=vi.fn(async()=>{expect(context.agentVerification?.artifact).toEqual(operation);return true;});
    const result=await runAgentVerificationStage({context,dispatcher:tools,changedPaths:["module.js"],artifact,authorize});
    expect(result.action).toBe("passed");expect(artifact.assertCurrent).toHaveBeenCalledTimes(3);
    expect(getRunVerificationState(runId)?.evidence.find(item=>item.criterionId===artifact.criterionId)).toMatchObject({status:"passed",revision:artifact.revision});
    expect(context.agentVerification).toBeUndefined();
    await runAgentVerificationStage({context,dispatcher:tools,changedPaths:["module.js"],artifact,authorize});
    expect(tools.dispatchConcurrent).toHaveBeenCalledTimes(1);
    const stale={...artifact,assertCurrent:()=>{throw new Error("export changed");}};
    expect((await runAgentVerificationStage({context,dispatcher:tools,changedPaths:["module.js"],artifact:stale,authorize})).action).toBe("stop");
  });
  it("does not dispatch a declined export test", async () => {
    setupProject();const tools=dispatcher(),artifact={operation:{artifactPath:"/export.js",artifactDigest:"a".repeat(64),sourceDigest:"b".repeat(64),targetPath:"module.js"},criterionId:"acceptance:validate-export:r1",revision:"revision-1",assertCurrent:()=>{}};
    expect((await runAgentVerificationStage({context,dispatcher:tools,changedPaths:["module.js"],artifact,authorize:async()=>false})).action).toBe("cancelled");
    expect(context.agentVerification).toBeUndefined();expect(tools.dispatchConcurrent).not.toHaveBeenCalled();
  });
  it("does not execute an export that changes while approval is pending", async () => {
    setupProject(); const tools=dispatcher();let current=true;
    const artifact={operation:{artifactPath:"/export.js",artifactDigest:"a".repeat(64),sourceDigest:"b".repeat(64),targetPath:"module.js"},criterionId:"acceptance:validate-export:r1",revision:"revision-1",assertCurrent:()=>{if(!current)throw new Error("export changed");}};
    await expect(runAgentVerificationStage({context,dispatcher:tools,changedPaths:["module.js"],artifact,authorize:async()=>{current=false;return true;}})).rejects.toThrow("export changed");
    expect(context.agentVerification).toBeUndefined();expect(tools.dispatchConcurrent).not.toHaveBeenCalled();
  });
  it("runs each affected package and records only current immutable test evidence", async () => {
    setupProject("first"); setupProject("second");
    const tools = dispatcher();
    expect((await run(tools, ["first/module.js", "second/module.js"])).action).toBe("passed");
    expect(tools.dispatchConcurrent).toHaveBeenCalledTimes(2);
    expect(getRunVerificationState(runId)?.attempts).toHaveLength(2);
    expect(verifyRunEvidence(runId)?.attempts?.verification).toBe(2);
    expect(verifyRunEvidence(runId)?.checks.find(item => item.criterionId === "acceptance:validate-written-code")?.status).toBe("passed");
    expect((await run(tools, ["first/module.js", "second/module.js"])).action).toBe("passed");
    expect(tools.dispatchConcurrent).toHaveBeenCalledTimes(2);
  });
  it("executes baseline suites and keeps an initial failure separate from mandatory repair acceptance", async () => {
    setupProject(); const tools = dispatcher(true);
    const baseline = await runAgentVerificationStage({ context, dispatcher: tools, changedPaths: [], baseline: true, authorize: async () => true });
    expect(baseline.action).toBe("repair"); expect(tools.dispatchConcurrent).toHaveBeenCalledTimes(1);
    expect(getRunVerificationState(runId)?.evidence.find(item => item.criterionId === "baseline:project-tests")).toMatchObject({ status: "failed", mandatory: false });
    expect(getRunVerificationState(runId)?.repairCount).toBe(0);
    writeFileSync(path.join(workspace, "module.js"), "export const value = 2;\n");
    expect((await run(dispatcher())).action).toBe("passed");
    expect(verifyRunEvidence(runId)?.checks.find(item => item.criterionId === "acceptance:validate-written-code")?.status).toBe("passed");
  });
  it("does not pass a requested full suite when no tests exist", async () => {
    const tools = dispatcher();
    expect((await run(tools, [])).action).toBe("stop");
    expect(tools.dispatchConcurrent).not.toHaveBeenCalled();
    expect(getRunVerificationState(runId)?.evidence.find(item => item.criterionId === "acceptance:validate-written-code")?.status).toBe("unverified");
  });

  it("stops without inventing tests when no existing setup is usable", async () => {
    writeFileSync(path.join(workspace, "module.js"), "export const value = 1;\n");
    const tools = dispatcher();
    expect((await run(tools)).action).toBe("stop");
    expect(tools.dispatchConcurrent).not.toHaveBeenCalled();
    expect(getRunVerificationState(runId)?.termination?.reason).toBe("no_usable_test_setup");
    expect(verifyRunEvidence(runId)?.termination?.nextAction).toContain("resume");
  });

  it("honors an explicit user skip without claiming a test pass", async () => {
    recordVerificationUserSkip(runId, "Do not run tests");
    const tools = dispatcher();
    expect((await run(tools)).action).toBe("skipped");
    expect(tools.dispatchConcurrent).not.toHaveBeenCalled();
    expect(verifyRunEvidence(runId)?.checks.find(item => item.criterionId === "acceptance:validate-written-code")?.status).toBe("skipped");
  });

  it("allows two repairs across revisions and preserves the final failed evidence", async () => {
    setupProject(); const tools = dispatcher(true);
    expect((await run(tools)).action).toBe("repair");
    expect((await run(tools)).action).toBe("repair");
    expect(tools.dispatchConcurrent).toHaveBeenCalledTimes(1);
    writeFileSync(path.join(workspace, "module.js"), "export const value = 2;\n");
    expect((await run(tools)).action).toBe("repair");
    writeFileSync(path.join(workspace, "module.js"), "export const value = 3;\n");
    expect((await run(tools)).action).toBe("stop");
    expect(getRunVerificationState(runId)?.repairCount).toBe(2);
    expect(getRunVerificationState(runId)?.termination?.reason).toBe("repair_budget_exhausted");
    expect(verifyRunEvidence(runId)?.checks.find(item => item.criterionId === "acceptance:validate-written-code")?.status).toBe("failed");
  });

  it("can retry an unavailable environment without restoring repair allowance", async () => {
    setupProject();
    const unavailable = { getTool: () => undefined } as unknown as ToolDispatcher;
    expect((await run(unavailable)).action).toBe("stop");
    expect(getRunVerificationState(runId)?.termination?.reason).toBe("execution_unavailable");
    expect((await run(dispatcher())).action).toBe("passed");
    expect(getRunVerificationState(runId)?.repairCount).toBe(0);
  });
});
