import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { addMessage } from "../src/main/persistence/messages.js";
import { createRun } from "../src/main/run/store.js";
import { dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { persistRunContract } from "../src/main/run/contract.js";
import { bindAgentTaskRun } from "../src/main/run/agent-task-store.js";
import {
  bindAgentExecutionLedger,
  consumeAgentModelCall,
  initializeExecutionLedger,
  BudgetDeniedError
} from "../src/main/run/execution-ledger.js";
import { runJudge, hashInput, type Judge } from "../src/main/agent/judge.js";
import { assessAgentFileScope } from "../src/main/agent/requirement-scope.js";
import { assessAgentArtifactScope } from "../src/main/agent/artifact-scope.js";
import type { AgentTask, AgentRequirement } from "../src/shared/contracts.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";

let root: string, filename: string, chatId: string, previousDataRoot: string;
let workspace: { root: string; registeredAt: string };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "judge-budgets-"));
  workspace = { root, registeredAt: "registration-1" };
  filename = path.join(root, "workbench.db");
  initDb(filename);
  previousDataRoot = dataRoot();
  setDataDir(root);
  chatId = createChat("Budget test chat");
});

afterEach(() => {
  closeDb();
  setDataDir(previousDataRoot);
  rmSync(root, { recursive: true, force: true });
});

function setupRun(text = "Fix the issue") {
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

describe("Role budgets and BudgetDeniedError", () => {
  it("enforces interpretation budget cap of 4 calls", () => {
    const { runId } = setupRun();
    for (let i = 0; i < 4; i++) {
      expect(consumeAgentModelCall(runId, undefined, "interpretation")).toBe(i + 1);
    }
    expect(() => consumeAgentModelCall(runId, undefined, "interpretation"))
      .toThrow(BudgetDeniedError);
  });

  it("enforces judge budget cap across all judge roles", () => {
    const { runId } = setupRun();
    const judgeLimit = Number(process.env.WORKBENCH_JUDGE_CALL_BUDGET ?? 20);
    const judgeRoles = ["scope_judge", "file_scope_judge", "artifact_judge", "coverage_judge"] as const;
    for (let i = 0; i < judgeLimit; i++) {
      const role = judgeRoles[i % judgeRoles.length];
      expect(consumeAgentModelCall(runId, undefined, role)).toBe(i + 1);
    }
    expect(() => consumeAgentModelCall(runId, undefined, "scope_judge"))
      .toThrow(BudgetDeniedError);
  });

  it("enforces delivery budget cap of 3 calls", () => {
    const { runId } = setupRun();
    for (let i = 0; i < 3; i++) {
      expect(consumeAgentModelCall(runId, undefined, "delivery")).toBe(i + 1);
    }
    expect(() => consumeAgentModelCall(runId, undefined, "delivery"))
      .toThrow(BudgetDeniedError);
  });

  it("reserves remaining calls for actor when total remaining is <= 16", () => {
    const { runId } = setupRun();
    // Consume 24 actor calls (leaving 16 remaining of 40)
    for (let i = 0; i < 24; i++) {
      expect(consumeAgentModelCall(runId, undefined, "actor")).toBe(i + 1);
    }
    // Non-actor call must be denied
    expect(() => consumeAgentModelCall(runId, undefined, "scope_judge"))
      .toThrow(BudgetDeniedError);
    // Actor call must still be permitted
    expect(consumeAgentModelCall(runId, undefined, "actor")).toBe(25);
  });
});

describe("Judge framework (runJudge)", () => {
  interface TestInput {
    id: string;
    value: number;
  }

  it("uses deterministic fast-path without invoking ask or checking cache", async () => {
    const askSpy = vi.fn();
    const testJudge: Judge<TestInput, boolean> = {
      name: "scope_judge",
      decide: (input) => (input.value > 10 ? true : undefined),
      cacheKey: (input) => hashInput(input),
      ask: askSpy
    };

    const ctx = {} as ToolExecutionContext;
    const verdict = await runJudge(testJudge, { id: "1", value: 20 }, ctx);
    expect(verdict).toBe(true);
    expect(askSpy).not.toHaveBeenCalled();
  });

  it("uses model fallback and caches result when deterministic check cannot decide", async () => {
    const { runId } = setupRun();
    const resultStore = new RunResultStore(runId, getDb());
    const askSpy = vi.fn().mockResolvedValue(true);

    const testJudge: Judge<TestInput, boolean> = {
      name: "scope_judge",
      decide: () => undefined,
      cacheKey: (input) => hashInput(input),
      ask: askSpy
    };

    const ctx = { resultStore, runId } as unknown as ToolExecutionContext;
    const input = { id: "2", value: 5 };

    // First call: falls back to model and writes to resultStore
    const verdict1 = await runJudge(testJudge, input, ctx);
    expect(verdict1).toBe(true);
    expect(askSpy).toHaveBeenCalledTimes(1);

    // Second call with same input: retrieves from cache!
    const verdict2 = await runJudge(testJudge, input, ctx);
    expect(verdict2).toBe(true);
    expect(askSpy).toHaveBeenCalledTimes(1); // Not called again!
  });
});

describe("Deterministic file scope judge", () => {
  it("determines workspace scope for repair instruction without model inference", async () => {
    const prompt = "The status filter returns the wrong orders. Fix it and make the tests pass.";
    const { runId, messageId, binding } = setupRun(prompt);
    const resultStore = new RunResultStore(runId, getDb());

    const requirement: AgentRequirement = {
      id: "req-1",
      kind: "change",
      description: "Fix orders filter",
      mandatory: true,
      dependencies: [],
      source: { messageId, start: 0, end: prompt.length, quote: prompt },
      state: "active",
      acceptance: [{ id: "check-1", kind: "execution", description: "tests pass" }]
    };

    const task: AgentTask = {
      taskId: binding.taskId,
      chatId,
      workspace,
      status: "open",
      current: true,
      latestRunId: runId,
      snapshot: {
        schemaVersion: 1,
        taskId: binding.taskId,
        revision: binding.taskRevision,
        requirements: [requirement],
        messages: [{ id: messageId, content: prompt, disposition: "continue" }]
      }
    };

    const ctx = {
      runId,
      workspaceRoot: workspace.root,
      resultStore,
      gateway: {} as any
    } as unknown as ToolExecutionContext;

    const call = {
      id: "call-1",
      name: "edit_file",
      arguments: { path: "src/work-orders.js", replacements: [{ old: "foo", new: "bar" }] }
    };

    const outcome = await assessAgentFileScope(task, "req-1", call, ctx, "test-driver");
    expect(outcome.verified).toBe(true);
    expect(outcome.withinScope).toBe(true);
    expect(ctx.agentFileScope?.scope).toBe("workspace");
    if (ctx.agentFileScope && ctx.agentFileScope.scope !== "none") {
      expect(ctx.agentFileScope.operations).toContain("edit_file");
    }
  });

  it("determines artifact scope is false for repair instruction without model inference", async () => {
    const prompt = "The status filter returns the wrong orders. Fix it and make the tests pass.";
    const { runId, messageId, binding } = setupRun(prompt);
    const resultStore = new RunResultStore(runId, getDb());

    const requirement: AgentRequirement = {
      id: "req-1",
      kind: "change",
      description: "Fix orders filter",
      mandatory: true,
      dependencies: [],
      source: { messageId, start: 0, end: prompt.length, quote: prompt },
      state: "active",
      acceptance: [{ id: "check-1", kind: "execution", description: "tests pass" }]
    };

    const task: AgentTask = {
      taskId: binding.taskId,
      chatId,
      workspace,
      status: "open",
      current: true,
      latestRunId: runId,
      snapshot: {
        schemaVersion: 1,
        taskId: binding.taskId,
        revision: binding.taskRevision,
        requirements: [requirement],
        messages: [{ id: messageId, content: prompt, disposition: "continue" }]
      }
    };

    const ctx = {
      runId,
      workspaceRoot: workspace.root,
      resultStore,
      gateway: {
        chatWithTools: vi.fn()
      } as any
    } as unknown as ToolExecutionContext;

    const outcome = await assessAgentArtifactScope(task, "req-1", ctx, "test-driver");
    expect(outcome.requested).toBe(false);
    expect(outcome.format).toBeNull();
    expect(outcome.filename).toBeNull();
    // Gateway was NOT called
    expect(ctx.gateway.chatWithTools).not.toHaveBeenCalled();
  });
});
