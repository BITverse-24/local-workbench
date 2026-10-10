import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { normalizeRunContract, persistRunContract } from "../src/main/run/contract.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { compactConversationHistory, type AgentMessage } from "../src/main/agent/context-manager.js";
import { addExecutionLedgerBlocker, configureExecutionLedger, getExecutionLedger, initializeExecutionLedger, markAuthorizationPending, markExecutionTokenLimit, prepareExecutionResume, recordAuthorizationDecision, recordExecutionToolOutcome, recordExecutionToolStarted, reopenPartialRun, reconcileInterruptedExecutions, updateExecutionLedgerState, executionLedgerSummary } from "../src/main/run/execution-ledger.js";
import { transition } from "../src/main/run/store.js";

describe("P1-C1 execution ledger", () => {
  let dir: string, runId: string;
  const intent = () => validateAndNormalizeIntent({
    intentType: "code_modification", primaryGoal: "Repair parser behavior", driverModel: "primary-model", taskType: "code", isActionable: true,
    chatResponseOnly: false, workspaceMutationRequested: true, targetFiles: ["parser.py"], protectedPaths: [], restrictMutationsToTargets: true,
    workspaceOperations: [{ operation: "mutate", targetPath: "parser.py" }], expectedDeliverables: [{ filename: "report.md", type: "md" }],
  }, { hasWorkspace: true, workspaceFiles: ["parser.py"], userPrompt: "Repair parser and report" });
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "p1-c1-ledger-"));
    initDb(path.join(dir, "workbench.sqlite"));
    runId = createRun(createChat(), "repair parser");
    const contract = persistRunContract(normalizeRunContract(runId, intent()));
    initializeExecutionLedger(contract);
  });
  afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("records meaningful operations, result IDs and contract work idempotently", () => {
    const store = new RunResultStore(runId, undefined, dir);
    const result = store.registerResult({ type: "text", status: "complete", origin: "source_extracted", producer: { tool: "read_file", callId: "read-1" }, summary: "Read parser source", payload: "source body", sources: [{ filename: "parser.py", relation: "source" }] });
    recordExecutionToolOutcome({ runId, callId: "read-1", tool: "read_file", args: { path: "parser.py" }, summary: "Read parser source", ok: true, resultId: result.resultId });
    recordExecutionToolOutcome({ runId, callId: "read-1", tool: "read_file", args: { path: "parser.py" }, summary: "Read parser source", ok: true, resultId: result.resultId });
    recordExecutionToolOutcome({ runId, callId: "write-1", tool: "write_file", args: { path: "parser.py" }, summary: "Wrote parser", ok: true });
    const ledger = getExecutionLedger(runId)!;
    expect(ledger.completedOperations).toHaveLength(2);
    expect(ledger.completedOperations[0].resultIds).toEqual([result.resultId]);
    expect(ledger.knownWork.find((item) => item.label === "mutate parser.py")?.status).toBe("completed");
    expect(ledger.progress).toEqual({ completedWork: 1, totalKnownWork: 2 });
    expect(ledger.knownWork.find((item) => item.label.includes("report.md"))?.status).toBe("pending");
    expect(ledger.status).toBe("active");
    expect(executionLedgerSummary(runId)).toContain(result.resultId);
    expect(executionLedgerSummary(runId)!.length).toBeLessThanOrEqual(800);
    const history: AgentMessage[] = [
      { role: "system", content: "system" }, { role: "user", content: "repair" },
      { role: "assistant", content: "thinking", turn: 1 }, { role: "tool", toolName: "read_file", content: "payload ".repeat(600), resultId: result.resultId, turn: 1 },
      { role: "assistant", content: "next", turn: 2 }, { role: "tool", toolName: "read_file", content: "latest", turn: 2 },
    ];
    const compacted = compactConversationHistory(history, 2, 0);
    expect(compacted[3].content).toContain("compacted");
    expect(executionLedgerSummary(runId)).toContain(result.resultId);
  });

  it("tracks authorization, blockers, partial and cancelled outcomes across database restart", () => {
    updateExecutionLedgerState(runId, "awaiting_confirmation");
    expect(getExecutionLedger(runId)?.status).toBe("awaiting_authorization");
    addExecutionLedgerBlocker(runId, "Model output limit reached; incomplete action was not dispatched.");
    updateExecutionLedgerState(runId, "partial", "Known work remains.");
    closeDb();
    initDb(path.join(dir, "workbench.sqlite"));
    expect(getExecutionLedger(runId)?.status).toBe("partial");
    expect(getExecutionLedger(runId)?.blockers).toContain("Model output limit reached; incomplete action was not dispatched.");
    expect(getExecutionLedger(runId)?.knownWork.every((item) => item.status === "pending")).toBe(true);
    updateExecutionLedgerState(runId, "cancelled", "Run was cancelled.");
    expect(getExecutionLedger(runId)?.status).toBe("cancelled");
  });

  it("records failures without calling a failed operation completed", () => {
    recordExecutionToolOutcome({ runId, callId: randomUUID(), tool: "run_command", args: { command: "check" }, summary: "Command failed", ok: false, error: "exit 1" });
    expect(getExecutionLedger(runId)?.completedOperations).toHaveLength(0);
    expect(getExecutionLedger(runId)?.blockers.join(" ")).toContain("exit 1");
  });

  it("reconstructs a crash as interrupted and blocks uncertain mutation replay", () => {
    configureExecutionLedger(runId, { modelId: "primary-model", mode: "agent", workspaceRoot: dir, groundingEnabled: false });
    recordExecutionToolStarted({ runId, callId: "mutation-1", tool: "write_file", args: { path: "parser.py" }, summary: "Write parser" });
    expect(reconcileInterruptedExecutions()).toBe(1);
    expect(getExecutionLedger(runId)?.operationAttempts[0].status).toBe("uncertain");
    expect(() => prepareExecutionResume(runId)).toThrow(/uncertain mutation/i);
  });

  it("allows explicit resumption after a completed operation and preserves result references", () => {
    configureExecutionLedger(runId, { modelId: "primary-model", mode: "agent", workspaceRoot: dir, groundingEnabled: false });
    const result = new RunResultStore(runId, undefined, dir).registerResult({ type: "text", status: "complete", origin: "source_extracted", producer: { tool: "read_file", callId: "read-resume" }, summary: "source", payload: "body" });
    recordExecutionToolStarted({ runId, callId: "read-resume", tool: "read_file", args: { path: "parser.py" }, summary: "Read parser" });
    recordExecutionToolOutcome({ runId, callId: "read-resume", tool: "read_file", args: { path: "parser.py" }, summary: "Read parser", ok: true, resultId: result.resultId });
    recordExecutionToolOutcome({ runId, callId: "write-resume", tool: "write_file", args: { path: "parser.py" }, summary: "Write parser", ok: true });
    transition(runId, "partial");
    updateExecutionLedgerState(runId, "partial");
    const prepared = prepareExecutionResume(runId);
    expect(prepared.ledger.operationAttempts[0].resultIds).toContain(result.resultId);
    expect(prepared.ledger.operationAttempts.find((attempt) => attempt.callId === "write-resume")?.status).toBe("completed");
    reopenPartialRun(runId);
    expect(getExecutionLedger(runId)?.status).toBe("active");
  });

  it("records pending authorization and clears it after a decision", () => {
    markAuthorizationPending(runId, [{ id: "pending-1", name: "write_file", arguments: { path: "parser.py" }, summary: "Write parser" }]);
    expect(getExecutionLedger(runId)?.status).toBe("awaiting_authorization");
    expect(getExecutionLedger(runId)?.pendingAuthorizations).toHaveLength(1);
    recordAuthorizationDecision(runId);
    expect(getExecutionLedger(runId)?.pendingAuthorizations).toHaveLength(0);
    expect(getExecutionLedger(runId)?.status).toBe("active");
  });

  it("offers only one explicit larger-generation recovery after a token limit", () => {
    markExecutionTokenLimit(runId);
    transition(runId, "limit_exceeded");
    updateExecutionLedgerState(runId, "limit_exceeded");
    expect(() => prepareExecutionResume(runId)).toThrow(/eligible/i);
    const recovery = prepareExecutionResume(runId, true);
    expect(recovery.useLargerAllowance).toBe(true);
    expect(recovery.ledger.tokenLimitRecoveryCount).toBe(1);
    expect(() => prepareExecutionResume(runId, true)).toThrow(/eligible|available/i);
  });
});
