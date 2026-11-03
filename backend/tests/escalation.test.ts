import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { createRun } from "../src/main/run/store.js";
import { dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import { persistRunContract } from "../src/main/run/contract.js";
import { bindAgentTaskRun } from "../src/main/run/agent-task-store.js";
import {
  advanceAgentEscalation,
  bindAgentExecutionLedger,
  getExecutionLedger,
  initializeExecutionLedger
} from "../src/main/run/execution-ledger.js";
import { LADDER, nextEscalation, type StuckKind } from "../src/main/agent/escalation.js";

let root: string, filename: string, chatId: string, previousDataRoot: string;
let workspace: { root: string; registeredAt: string };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "escalation-"));
  workspace = { root, registeredAt: "registration-1" };
  filename = path.join(root, "workbench.db");
  initDb(filename);
  previousDataRoot = dataRoot();
  setDataDir(root);
  chatId = createChat("Escalation test chat");
});

afterEach(() => {
  closeDb();
  setDataDir(previousDataRoot);
  rmSync(root, { recursive: true, force: true });
});

function setupRun(text = "Repair issue") {
  const runId = createRun(chatId, text);
  getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,?,?,?)")
    .run(runId, "agent", "agent-v3", workspace.root);
  const messageId = addMessage({ chat_id: chatId, role: "user", content: text }).id;
  const binding = bindAgentTaskRun({ runId, chatId, messageId, workspace, disposition: "continue" });
  const contract = persistRunContract({
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    objective: text,
    resolution: { status: "resolved" },
    routing: { intentType: "code_modification", taskType: "code", driverModel: "driver", actionable: true },
    response: { required: true, chatOnly: false },
    workspace: { requested: true, operations: [] },
    deliverables: [],
    constraints: { protectedPaths: [], restrictMutationsToTargets: false, userConstraints: [] },
    acceptance: { validateWrittenCode: true, validatedPythonDeliverables: [], artifactChecks: [] }
  });
  initializeExecutionLedger(contract);
  bindAgentExecutionLedger(binding);
  return { runId, messageId, binding };
}

describe("Escalation ladder unit logic (nextEscalation)", () => {
  it("traverses repeated_action ladder correctly", () => {
    const kind: StuckKind = "repeated_action";
    const expected = ["expand_context", "switch_edit_mode", "resample_t0.5", "stop"];
    expect(LADDER[kind]).toEqual(expected);

    expect(nextEscalation(kind, 0).action).toBe("expand_context");
    expect(nextEscalation(kind, 1).action).toBe("switch_edit_mode");
    expect(nextEscalation(kind, 2).action).toBe("resample_t0.5");
    expect(nextEscalation(kind, 3).action).toBe("stop");
    // Clamping to stop on any further attempts
    expect(nextEscalation(kind, 4).action).toBe("stop");
    expect(nextEscalation(kind, 10).action).toBe("stop");
  });

  it("traverses malformed_action ladder correctly", () => {
    const kind: StuckKind = "malformed_action";
    expect(nextEscalation(kind, 0).action).toBe("correction");
    expect(nextEscalation(kind, 1).action).toBe("constrained_transport");
    expect(nextEscalation(kind, 2).action).toBe("stop");
    expect(nextEscalation(kind, 3).action).toBe("stop");
  });

  it("traverses context_limit and repeated_context_request ladders correctly", () => {
    expect(nextEscalation("context_limit", 0).action).toBe("symbol_slices_only");
    expect(nextEscalation("context_limit", 1).action).toBe("stop");

    expect(nextEscalation("repeated_context_request", 0).action).toBe("supply_neighbor_symbols");
    expect(nextEscalation("repeated_context_request", 1).action).toBe("stop");
  });
});

describe("Durable escalation tracking (advanceAgentEscalation)", () => {
  it("persists escalation count in ledger across calls", () => {
    const { runId } = setupRun();

    const r1 = advanceAgentEscalation(runId, "repeated_action");
    expect(r1.action).toBe("expand_context");
    expect(r1.step).toBe(0);

    const ledger1 = getExecutionLedger(runId);
    expect(ledger1?.agentProgress?.escalations?.repeated_action).toBe(1);

    const r2 = advanceAgentEscalation(runId, "repeated_action");
    expect(r2.action).toBe("switch_edit_mode");
    expect(r2.step).toBe(1);

    const ledger2 = getExecutionLedger(runId);
    expect(ledger2?.agentProgress?.escalations?.repeated_action).toBe(2);

    const r3 = advanceAgentEscalation(runId, "repeated_action");
    expect(r3.action).toBe("resample_t0.5");
    expect(r3.step).toBe(2);

    const r4 = advanceAgentEscalation(runId, "repeated_action");
    expect(r4.action).toBe("stop");
    expect(r4.step).toBe(3);

    const r5 = advanceAgentEscalation(runId, "repeated_action");
    expect(r5.action).toBe("stop");
  });
});
