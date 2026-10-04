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
import { addExecutionLedgerBlocker, getExecutionLedger, initializeExecutionLedger, recordExecutionToolOutcome, updateExecutionLedgerState, executionLedgerSummary } from "../src/main/run/execution-ledger.js";

describe("P1-C1 execution ledger", () => {
  let dir: string, runId: string;
  const intent = () => validateAndNormalizeIntent({
    intentType: "code_modification", primaryGoal: "Repair parser behavior", driverModel: "code-qwen25coder", taskType: "code", isActionable: true,
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
});
