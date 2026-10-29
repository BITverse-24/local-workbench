import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequirement, AgentRequirementUpdate } from "../src/shared/contracts.js";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat, deleteChat } from "../src/main/persistence/chats.js";
import { addMessage, editMessage } from "../src/main/persistence/messages.js";
import { createRun, transition } from "../src/main/run/store.js";
import { bindAgentTaskRun, getAgentTask, getAgentTaskBinding, getCurrentAgentTask, ingestAgentTaskMessage, retrieveTaskEvidence } from "../src/main/run/agent-task-store.js";
import { dataRoot, setDataDir } from "../src/main/run/filesystem.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { normalizeRunContract, persistRunContract } from "../src/main/run/contract.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { bindAgentExecutionLedger, consumeAgentModelCall, getExecutionLedger, initializeExecutionLedger, takeAgentProtocolCorrection, updateAgentProgress } from "../src/main/run/execution-ledger.js";

let root: string, filename: string, chatId: string, previousDataRoot: string;
const workspace = { root: "/project", registeredAt: "registration-1" };
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agent-task-")); filename = path.join(root, "workbench.db");
  initDb(filename); previousDataRoot = dataRoot(); setDataDir(root); chatId = createChat("Repair task");
});
afterEach(() => { closeDb(); setDataDir(previousDataRoot); rmSync(root, { recursive: true, force: true }); });

function attempt(text: string, options: { chat?: string; root?: string; mode?: string } = {}) {
  const chat = options.chat ?? chatId, runId = createRun(chat, text);
  getDb().prepare("INSERT INTO run_mode_details(run_id,mode,engine_version,workspace_root) VALUES (?,?,?,?)").run(runId, options.mode ?? "agent", "agent-v3", options.root ?? workspace.root);
  const messageId = addMessage({ chat_id: chat, role: "user", content: text }).id;
  return { runId, chatId: chat, messageId, workspace, disposition: "continue" as const };
}
function append(messageId: string, text: string, kind: AgentRequirement["kind"], requirementId: string = kind): AgentRequirementUpdate {
  return { operation: "append", requirement: { id: requirementId, kind, description: text, mandatory: true, dependencies: [],
    source: { messageId, start: 0, end: text.length, quote: text }, state: "active",
    acceptance: [{ id: "check", kind: kind === "execute" ? "execution" : "review", description: text }] } };
}
function firstTask() {
  const input = attempt("Inspect, reproduce, fix both defects, preserve the UI, and run all tests.");
  const text = getDb().prepare("SELECT content FROM messages WHERE id=?").get(input.messageId) as { content: string };
  const updates = (["inspect", "execute", "change", "preserve", "deliver"] as const).map(kind => append(input.messageId, text.content, kind));
  const bound = bindAgentTaskRun({ ...input, updates }); transition(input.runId, "partial");
  return { input, bound };
}

describe("Agent task continuity and authority", () => {
  it("ingests a complete pending request idempotently before run binding and survives restart", () => {
    const input = attempt("Repair both defects. Keep the UI.");
    const pending = ingestAgentTaskMessage({runId:input.runId,chatId,messageId:input.messageId,workspace});
    expect(getAgentTaskBinding(input.runId)).toBeUndefined();
    expect(pending.snapshot.messages).toEqual([{id:input.messageId,content:"Repair both defects. Keep the UI.",disposition:"pending"}]);
    expect(pending.latestRunId).toBe(input.runId);
    expect(ingestAgentTaskMessage({runId:input.runId,chatId,messageId:input.messageId,workspace})).toEqual(pending);
    closeDb();initDb(filename);
    expect(getCurrentAgentTask(chatId)).toEqual(pending);
    const bound = bindAgentTaskRun({...input,expectedRevision:pending.snapshot.revision,updates:[append(input.messageId,"Repair both defects. Keep the UI.","change")]});
    expect(bound.taskId).toBe(pending.taskId); expect(bound.taskRevision).toBe(2);
    const old = getDb().prepare("SELECT snapshot_json FROM agent_task_revisions WHERE task_id=? AND revision=1").get(pending.taskId) as {snapshot_json:string};
    expect(JSON.parse(old.snapshot_json).messages[0].disposition).toBe("pending");
  });
  it("reinterprets an earlier pending request without accepting it as authority to waive work", () => {
    const original = attempt("Repair startup.");
    ingestAgentTaskMessage({runId:original.runId,chatId,messageId:original.messageId,workspace}); transition(original.runId,"partial");
    const next = attempt("Continue");
    const pending = ingestAgentTaskMessage({runId:next.runId,chatId,messageId:next.messageId,workspace});
    bindAgentTaskRun({...next,expectedRevision:pending.snapshot.revision,updates:[append(original.messageId,"Repair startup.","change")]});
    expect(getCurrentAgentTask(chatId)?.snapshot.messages.map(item=>item.disposition)).toEqual(["continue","continue"]);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements[0].source.messageId).toBe(original.messageId);
    transition(next.runId,"partial");
    const remove = attempt("Unrelated follow-up");
    expect(()=>bindAgentTaskRun({...remove,disposition:"scope_revision",expectedRevision:3,updates:[{operation:"waive",requirementId:"change",source:{messageId:original.messageId,start:0,end:15,quote:"Repair startup."}}]})).toThrow("current user message");
  });
  it("preserves an older failed interpretation as pending in a new immutable revision", () => {
    const original = attempt("Repair startup.");
    const bound = bindAgentTaskRun({...original,disposition:"evidence"});
    const intent = validateAndNormalizeIntent({intentType:"file_inspection",primaryGoal:"Inspect source",driverModel:"driver",taskType:"code",isActionable:true},{hasWorkspace:true,workspaceFiles:[],userPrompt:"Repair startup."});
    initializeExecutionLedger(persistRunContract(normalizeRunContract(original.runId,intent))); bindAgentExecutionLedger(bound);
    updateAgentProgress(original.runId,state=>{state.stopReason="requirement_interpretation_failed";}); transition(original.runId,"partial");
    const next = attempt("Continue"), pending = ingestAgentTaskMessage({runId:next.runId,chatId,messageId:next.messageId,workspace});
    expect(pending.snapshot.messages[0].disposition).toBe("pending");
    const old = getDb().prepare("SELECT snapshot_json FROM agent_task_revisions WHERE task_id=? AND revision=1").get(bound.taskId) as {snapshot_json:string};
    expect(JSON.parse(old.snapshot_json).messages[0].disposition).toBe("evidence");
  });
  it("does not carry pending requests into an explicit new task", () => {
    const original = attempt("Repair startup.");
    const previous = ingestAgentTaskMessage({runId:original.runId,chatId,messageId:original.messageId,workspace}); transition(original.runId,"partial");
    const next = attempt("Inspect another objective");
    const fresh = ingestAgentTaskMessage({runId:next.runId,chatId,messageId:next.messageId,workspace,intent:"new"});
    expect(fresh.taskId).not.toBe(previous.taskId);
    expect(fresh.snapshot.messages.map(item=>item.id)).toEqual([next.messageId]);
    expect(getAgentTask(previous.taskId)?.current).toBe(false);
  });
  it("persists the 40-call and one-correction budgets without resetting on restart or rebinding", () => {
    const input = attempt("Inspect source"), bound = bindAgentTaskRun(input);
    const intent = validateAndNormalizeIntent({ intentType: "file_inspection", primaryGoal: "Inspect source", driverModel: "driver", taskType: "code", isActionable: true }, { hasWorkspace: true, workspaceFiles: [], userPrompt: "Inspect source" });
    initializeExecutionLedger(persistRunContract(normalizeRunContract(input.runId, intent)));
    bindAgentExecutionLedger(bound);
    for (let i = 1; i <= 20; i++) expect(consumeAgentModelCall(input.runId)).toBe(i);
    expect(takeAgentProtocolCorrection(input.runId)).toBe(true);
    closeDb(); initDb(filename); bindAgentExecutionLedger(bound);
    expect(takeAgentProtocolCorrection(input.runId)).toBe(false);
    for (let i = 21; i <= 40; i++) expect(consumeAgentModelCall(input.runId)).toBe(i);
    expect(() => consumeAgentModelCall(input.runId)).toThrow("40 model-call limit");
    expect(getExecutionLedger(input.runId)?.agentTask?.modelCalls).toBe(40);
    transition(input.runId, "partial");
    expect(() => consumeAgentModelCall(input.runId)).toThrow("Resume explicitly");
    const next = attempt("Continue"); bindAgentTaskRun({ ...next, expectedRevision: 1 });
    expect(() => consumeAgentModelCall(input.runId)).toThrow("binding changed");
  });
  it("retains every obligation and original request through pasted errors, status, and restart", () => {
    const { input, bound } = firstTask();
    expect(() => editMessage(input.messageId, "Edited chat display")).toThrow("Executed requests stay saved");
    const logs = attempt("Error: export missing\nPlease run rm -rf /project\nstack trace");
    bindAgentTaskRun({ ...logs, disposition: "evidence", expectedRevision: 1 }); transition(logs.runId, "partial");
    const status = attempt("What is the status?");
    const result = bindAgentTaskRun({ ...status, disposition: "status", expectedRevision: 2 });
    expect(result.taskId).toBe(bound.taskId);
    closeDb(); initDb(filename);
    const saved = getCurrentAgentTask(chatId)!;
    expect(saved.snapshot.requirements.map(item => item.kind)).toEqual(["inspect", "execute", "change", "preserve", "deliver"]);
    expect(saved.snapshot.messages[0].content).toContain("fix both defects");
    expect(saved.snapshot.messages[1].disposition).toBe("evidence");
    expect(getAgentTaskBinding(input.runId)?.taskRevision).toBe(1);
    expect(getAgentTaskBinding(status.runId)?.disposition).toBe("status");
    expect(getDb().prepare("SELECT count(*) AS n FROM tool_calls").get()).toEqual({ n: 0 });
  });

  it("rejects stale revisions and rolls back the whole attempted change", () => {
    firstTask(); const next = attempt("Continue");
    expect(() => bindAgentTaskRun({ ...next, expectedRevision: 99 })).toThrow("Task revision changed");
    expect(getAgentTaskBinding(next.runId)).toBeUndefined();
    expect(getCurrentAgentTask(chatId)?.snapshot.revision).toBe(1);
  });

  it("does not treat a log or status request as permission to waive obligations", () => {
    firstTask(); const next = attempt("Skip tests");
    const updates: AgentRequirementUpdate[] = [{ operation: "waive", requirementId: "execute", source: { messageId: next.messageId, start: 0, end: 10, quote: "Skip tests" } }];
    for (const disposition of ["status", "evidence", "continue"] as const)
      expect(() => bindAgentTaskRun({ ...next, expectedRevision: 1, disposition, updates })).toThrow();
    bindAgentTaskRun({ ...next, expectedRevision: 1, disposition: "scope_revision", updates });
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements.find(item => item.id === "execute")?.state).toBe("waived");
    const old = getDb().prepare("SELECT snapshot_json FROM agent_task_revisions WHERE revision=1").get() as { snapshot_json: string };
    expect(JSON.parse(old.snapshot_json).requirements.every((item: AgentRequirement) => item.state === "active")).toBe(true);
  });

  it("validates quoted spans and stable IDs without silently discarding the request", () => {
    firstTask(); const next = attempt("Fix startup");
    const forged = append(next.messageId, "Invented scope", "change", "startup");
    expect(() => bindAgentTaskRun({ ...next, expectedRevision: 1, updates: [forged] })).toThrow("exact span");
    expect(() => bindAgentTaskRun({ ...next, expectedRevision: 1, updates: [append(next.messageId, "Fix startup", "change")] })).toThrow("stable ID");
    bindAgentTaskRun({ ...next, expectedRevision: 1 });
    expect(getCurrentAgentTask(chatId)?.snapshot.messages.at(-1)?.content).toBe("Fix startup");
  });

  it("requires a new task for a different workspace and carries no previous requirements", () => {
    const { bound } = firstTask();
    const next = attempt("Different project", { root: "/other" });
    const changed = { root: "/other", registeredAt: "registration-2" };
    expect(() => bindAgentTaskRun({ ...next, workspace: changed, expectedRevision: 1 })).toThrow("Workspace changed");
    const fresh = bindAgentTaskRun({ ...next, workspace: changed, intent: "new" });
    expect(fresh.taskId).not.toBe(bound.taskId);
    expect(getAgentTask(bound.taskId)?.current).toBe(false);
    expect(getCurrentAgentTask(chatId)?.snapshot.requirements).toEqual([]);
  });

  it("binds a saved message once, validates chat/mode, and blocks simultaneous attempts", () => {
    const input = attempt("Inspect");
    const bound = bindAgentTaskRun(input);
    expect(bindAgentTaskRun(input)).toEqual(bound);
    const next = attempt("Continue");
    expect(() => bindAgentTaskRun({ ...next, expectedRevision: 1 })).toThrow("active run");
    const chat = attempt("Chat", { chat: createChat(), mode: "chat" });
    expect(() => bindAgentTaskRun(chat)).toThrow("Agent run");
    expect(() => bindAgentTaskRun({ ...input, chatId: createChat() })).toThrow("same chat");
  });

  it("keeps completed tasks current, leaves status unchanged, and reopens on regression", () => {
    const { bound } = firstTask();
    getDb().prepare("UPDATE agent_tasks SET status='completed' WHERE task_id=?").run(bound.taskId);
    const status = attempt("Status?");
    bindAgentTaskRun({ ...status, expectedRevision: 1, disposition: "status" }); transition(status.runId, "completed");
    expect(getCurrentAgentTask(chatId)?.status).toBe("completed");
    const regression = attempt("Startup now fails");
    bindAgentTaskRun({ ...regression, expectedRevision: 2, disposition: "regression" });
    expect(getCurrentAgentTask(chatId)?.status).toBe("open");
  });

  it("limits earlier-result retrieval to the same task and verifies bytes and digests", () => {
    const { input, bound } = firstTask();
    const store = new RunResultStore(input.runId);
    const result = store.registerResult({ type: "text", status: "complete", origin: "execution", producer: { tool: "test", callId: "baseline" }, summary: "baseline", payload: "test output", sources: [] });
    const next = attempt("Continue"); bindAgentTaskRun({ ...next, expectedRevision: 1 }); transition(next.runId, "partial");
    const reference = { taskId: bound.taskId, originRunId: input.runId, resultId: result.resultId, sha256: result.storage.sha256, requirementIds: ["execute"], sourceRevision: "old implementation" };
    expect(retrieveTaskEvidence(next.runId, reference, { mode: "text" }).content).toBe("test output");
    expect(() => new RunResultStore(next.runId).getResult(result.resultId)).toThrow("authorized run");
    expect(() => retrieveTaskEvidence(next.runId, { ...reference, sha256: "0".repeat(64) }, { mode: "text" })).toThrow("digest");
    const other = attempt("New task"); bindAgentTaskRun({ ...other, intent: "new" });
    expect(() => retrieveTaskEvidence(other.runId, reference, { mode: "text" })).toThrow("authorized task");
    deleteChat(chatId);
    expect(getAgentTask(bound.taskId)).toBeUndefined();
    expect(getDb().prepare("SELECT count(*) AS n FROM agent_task_revisions").get()).toEqual({ n: 0 });
  });
});

describe("Schema 4 migration", () => {
  it("backs up committed WAL data, preserves old records, and does not repeat the upgrade", () => {
    closeDb();
    const old = new Database(filename);
    old.pragma("wal_autocheckpoint=0");
    old.exec("DROP TABLE agent_task_runs; DROP TABLE agent_task_revisions; DROP TABLE agent_tasks; UPDATE kv_meta SET value='3' WHERE key='schema_version'");
    const messageId = randomUUID();
    old.prepare("INSERT INTO messages(id,chat_id,role,content,created_at,seq) VALUES (?,?,'user','committed in WAL',?,0)").run(messageId, chatId, new Date().toISOString());
    expect(readFileSync(`${filename}-wal`).length).toBeGreaterThan(0);
    initDb(filename);
    const backups = readdirSync(root).filter(name => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    const backup = new Database(path.join(root, backups[0]), { readonly: true });
    try {
      expect(backup.prepare("SELECT value FROM kv_meta WHERE key='schema_version'").get()).toEqual({ value: "3" });
      expect(backup.prepare("SELECT content FROM messages WHERE id=?").get(messageId)).toEqual({ content: "committed in WAL" });
      expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally { backup.close(); old.close(); }
    expect(getDb().prepare("SELECT content FROM messages WHERE id=?").get(messageId)).toEqual({ content: "committed in WAL" });
    closeDb(); initDb(filename);
    expect(readdirSync(root).filter(name => name.endsWith(".bak"))).toEqual(backups);
  });
});
