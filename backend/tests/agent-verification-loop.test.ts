import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { createRunDirectories, setDataDir } from "../src/main/run/filesystem.js";
import { normalizeRunContract, persistRunContract } from "../src/main/run/contract.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { configureExecutionLedger, initializeExecutionLedger } from "../src/main/run/execution-ledger.js";
import { getRunVerificationState } from "../src/main/run/verification-controller.js";
import { verifyRunEvidence } from "../src/main/run/verification.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { buildExecutionEnvelope } from "../src/main/run/envelope.js";
import { AgentLoop } from "../src/main/agent/agent-loop.js";
import { runCommandTool, writeFileTool } from "../src/main/tools/workspace-tools.js";
import type { RunEvent } from "../src/shared/contracts.js";

let temporary: string, workspace: string;
beforeEach(() => {
  temporary = mkdtempSync(path.join(tmpdir(), "verification-loop-")); workspace = path.join(temporary, "workspace"); mkdirSync(workspace);
  setDataDir(temporary); initDb(path.join(temporary, "workbench.sqlite"));
});
afterEach(() => { closeDb(); rmSync(temporary, { recursive: true, force: true }); });

async function execute(input: { failFirst?: boolean; noSetup?: boolean; skip?: boolean; marker?: boolean }) {
  if (!input.noSetup) {
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeFileSync(path.join(workspace, "module.test.cjs"), "const {test}=require('node:test');const assert=require('node:assert/strict');test('returns expected result',()=>assert.equal(require('./module.cjs').value,2));\n");
  }
  writeFileSync(path.join(workspace, "module.cjs"), "exports.value = 0;\n");
  const userPrompt = `Fix module.cjs in the workspace.${input.skip ? " Do not run tests." : ""}`;
  const runId = createRun(createChat(), userPrompt); createRunDirectories(runId);
  const intent = validateAndNormalizeIntent({ requestedAction: "modify_software", responseMode: "chat", primaryGoal: "Fix the saved module", workspaceMutationRequested: true, targetFiles: ["module.cjs"], expectedDeliverables: [] }, { hasWorkspace: true, workspaceFiles: ["module.cjs"], userPrompt });
  const normalized = normalizeRunContract(runId, intent, { mode: "agent", newRun: true });
  if (input.marker) normalized.acceptance.successMarker = "CHECK_OK";
  const contract = persistRunContract(normalized);
  const ledger = initializeExecutionLedger(contract);
  configureExecutionLedger(runId, { modelId: "primary-model", mode: "agent", workspaceRoot: workspace, groundingEnabled: false });
  let generations = 0, sawFailure = false, sawAssertion = false;
  const gateway = { async chatWithTools(_model: unknown, messages: any[]) {
    sawFailure ||= messages.some(message => String(message.content).includes("Runtime test failure"));
    sawAssertion ||= messages.some(message => String(message.content).includes("1 !== 2"));
    generations++;
    const write = generations === 1 || (input.failFirst && generations === 2);
    return { ok: true, value: { content: write ? "" : "The requested change is saved.", finishReason: "stop", tool_calls: write ? [{ id: `write-${generations}`, name: "write_file", arguments: { path: "module.cjs", content: `exports.value = ${input.failFirst && generations === 1 ? 1 : 2};\n` } }] : [] } };
  } };
  const envelope = buildExecutionEnvelope({ runId, mode: "agent", modelId: "primary-model", hasWorkspace: true, workspaceRoot: workspace, mutationRequested: true, commandExecutionRequested: true });
  const events: RunEvent[] = [];
  const result = await new AgentLoop().run({ runId, driverModelId: "primary-model", userPrompt, systemPrompt: "Perform the requested workspace change.", runContract: contract,
    tools: [writeFileTool, runCommandTool], envelope, context: { runId, workspaceRoot: workspace, gateway: gateway as any, runContract: contract, executionLedger: ledger, resultStore: new RunResultStore(runId), automaticCodeValidation: true },
    onPlanConfirmationRequired: async () => true, emitEvent: event => events.push(event), maxTurns: 6 });
  return { result, runId, sawFailure, sawAssertion, commands: events.filter(event => event.type === "tool_call" && event.tool === "run_command") };
}

describe("Agent loop runtime test scheduling", () => {
  it("runs existing real tests after a model write without a model command request", async () => {
    const { result, runId, commands } = await execute({});
    expect(result.outcome, result.finalText).toBe("completed");
    expect(commands).toHaveLength(1);
    expect(getRunVerificationState(runId)?.evidence.find(check => check.criterionId === "acceptance:validate-written-code")?.status).toBe("passed");
  });

  it("uses real failing tests to request a correction and then retests the saved repair", async () => {
    const { result, runId, commands, sawFailure, sawAssertion } = await execute({ failFirst: true });
    expect(result.outcome, result.finalText).toBe("completed");
    expect(sawFailure).toBe(true); expect(sawAssertion).toBe(true); expect(commands).toHaveLength(2);
    expect(getRunVerificationState(runId)?.repairCount).toBe(1);
    expect(getRunVerificationState(runId)?.attempts.map(attempt => attempt.status)).toEqual(["failed", "passed"]);
  });

  it("retains the saved change as Partial when no existing tests are available", async () => {
    const { result, runId, commands } = await execute({ noSetup: true });
    expect(result.outcome).toBe("partial"); expect(commands).toHaveLength(0);
    expect(readFileSync(path.join(workspace, "module.cjs"), "utf8")).toContain("= 2");
    expect(getRunVerificationState(runId)?.termination?.reason).toBe("no_usable_test_setup");
  });
  it("emits a requested marker only as part of accepted test execution", async () => {
    const { result, runId, commands } = await execute({ marker: true });
    expect(result.outcome, result.finalText).toBe("completed"); expect(commands).toHaveLength(1);
    expect(verifyRunEvidence(runId)?.checks.find(check => check.criterionId === "acceptance:success-marker")?.status).toBe("passed");
  });

  it("can complete an explicit user skip and labels verification as skipped", async () => {
    const { result, runId, commands } = await execute({ skip: true });
    expect(result.outcome, result.finalText).toBe("completed"); expect(commands).toHaveLength(0);
    expect(result.finalText).toContain("skipped");
    expect(getRunVerificationState(runId)?.userSkip?.basis).toBe("Do not run tests");
  });
});
