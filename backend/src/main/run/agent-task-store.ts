import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentMessageDisposition, AgentRequirementUpdate, AgentSourceQuote, AgentTask, AgentTaskBinding, AgentTaskRevision, TaskEvidenceRef, ResultSliceRequest } from "../../shared/contracts.js";
import { getDb } from "../persistence/db.js";
import { RunResultStore } from "./result-store.js";

const id = z.string().uuid();
const key = z.string().min(1).max(128);
const quote = z.object({ messageId: id, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1).max(32768) }).strict();
const disposition = z.enum(["continue", "evidence", "scope_revision", "status", "regression"]);
const workspace = z.object({ root: z.string().min(1).max(4096), registeredAt: z.string().min(1).max(100) }).strict();
const requirement = z.object({
  id: key, kind: z.enum(["inspect", "change", "execute", "preserve", "deliver"]), description: z.string().min(1).max(4096),
  source: quote, mandatory: z.boolean(), dependencies: z.array(key),
  acceptance: z.array(z.object({ id: key, description: z.string().min(1).max(4096), kind: z.enum(["inspection", "execution", "review", "delivery"]) }).strict()).min(1),
  state: z.enum(["active", "superseded", "waived"]), resolution: quote.optional(),
}).strict();
const revision = z.object({ schemaVersion: z.literal(1), taskId: id, revision: z.number().int().positive(),
  messages: z.array(z.object({ id, content: z.string(), disposition }).strict()), requirements: z.array(requirement) }).strict();
const update = z.union([
  z.object({ operation: z.literal("append"), requirement }).strict(),
  z.object({ operation: z.enum(["supersede", "waive"]), requirementId: key, source: quote }).strict(),
]);
const bindInput = z.object({ runId: id, chatId: id, messageId: id, workspace,
  intent: z.enum(["continue", "new"]).default("continue"), disposition,
  expectedRevision: z.number().int().positive().optional(), updates: z.array(update).default([]), predecessorRunId: id.optional() }).strict();
type TaskRow = { task_id: string; chat_id: string; workspace_json: string; status: AgentTask["status"]; is_current: number; current_revision: number };

function binding(runId: string): AgentTaskBinding | undefined {
  const row = getDb().prepare("SELECT run_id,task_id,task_revision,disposition,predecessor_run_id FROM agent_task_runs WHERE run_id=?").get(runId) as
    { run_id: string; task_id: string; task_revision: number; disposition: AgentMessageDisposition; predecessor_run_id: string | null } | undefined;
  return row && { runId: row.run_id, taskId: row.task_id, taskRevision: row.task_revision, disposition: row.disposition, predecessorRunId: row.predecessor_run_id ?? undefined };
}

export function getAgentTaskBinding(runId: string): AgentTaskBinding | undefined { return binding(id.parse(runId)); }

export function getAgentTask(taskId: string): AgentTask | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agent_tasks WHERE task_id=?").get(id.parse(taskId)) as TaskRow | undefined;
  if (!row) return;
  const saved = db.prepare("SELECT snapshot_json FROM agent_task_revisions WHERE task_id=? AND revision=?").get(taskId, row.current_revision) as { snapshot_json: string };
  const latest = db.prepare("SELECT run_id FROM agent_task_runs WHERE task_id=? ORDER BY task_revision DESC LIMIT 1").get(taskId) as { run_id: string } | undefined;
  return { taskId, chatId: row.chat_id, workspace: workspace.parse(JSON.parse(row.workspace_json)), status: row.status,
    current: row.is_current === 1, snapshot: revision.parse(JSON.parse(saved.snapshot_json)), latestRunId: latest?.run_id };
}

export function getCurrentAgentTask(chatId: string): AgentTask | undefined {
  const row = getDb().prepare("SELECT task_id FROM agent_tasks WHERE chat_id=? AND is_current=1").get(id.parse(chatId)) as { task_id: string } | undefined;
  return row && getAgentTask(row.task_id);
}

export function setAgentTaskStatus(runId: string, status: AgentTask["status"]): void {
  const bound = binding(id.parse(runId));
  if (!bound || bound.disposition === "status") return;
  const db = getDb();
  db.prepare("UPDATE agent_tasks SET status=?,updated_at=? WHERE task_id=? AND current_revision=? AND is_current=1").run(status, new Date().toISOString(), bound.taskId, bound.taskRevision);
}

/** Validate provenance only. An exact quotation is not proof of correct interpretation. */
function validateQuote(source: AgentSourceQuote, snapshot: AgentTaskRevision, messageId: string): void {
  const message = snapshot.messages.find(item => item.id === source.messageId);
  if (source.messageId !== messageId || !message || source.end <= source.start || message.content.slice(source.start, source.end) !== source.quote)
    throw new Error("Requirement source must quote an exact span of the current user message.");
}

function applyUpdates(snapshot: AgentTaskRevision, updates: AgentRequirementUpdate[], messageId: string, kind: AgentMessageDisposition): void {
  if ((kind === "evidence" || kind === "status") && updates.length) throw new Error("Evidence and status messages cannot change requirements.");
  for (const change of updates) {
    if (change.operation === "append") {
      const item = change.requirement;
      validateQuote(item.source, snapshot, messageId);
      if (item.state !== "active" || item.resolution || snapshot.requirements.some(existing => existing.id === item.id)) throw new Error("A new requirement needs a new stable ID and active state.");
      snapshot.requirements.push(item);
    } else {
      if (kind !== "scope_revision") throw new Error("Removing an obligation requires a quoted scope revision from the user.");
      validateQuote(change.source, snapshot, messageId);
      const item = snapshot.requirements.find(existing => existing.id === change.requirementId);
      if (!item || item.state !== "active") throw new Error("Only an active requirement can be superseded or waived.");
      item.state = change.operation === "waive" ? "waived" : "superseded";
      item.resolution = change.source;
    }
  }
  const allIds = new Set(snapshot.requirements.map(item => item.id));
  for (const item of snapshot.requirements) {
    if (new Set(item.acceptance.map(check => check.id)).size !== item.acceptance.length) throw new Error("Acceptance IDs must be unique within a requirement.");
    if (item.dependencies.some(dependency => !allIds.has(dependency) || dependency === item.id)) throw new Error("Unknown or self-dependent requirement.");
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (requirementId: string): void => {
    if (visiting.has(requirementId)) throw new Error("Requirement dependencies contain a cycle.");
    if (visited.has(requirementId)) return;
    visiting.add(requirementId);
    snapshot.requirements.find(item => item.id === requirementId)!.dependencies.forEach(visit);
    visiting.delete(requirementId); visited.add(requirementId);
  };
  allIds.forEach(visit);
}

/** Atomically attach an immutable request, append requirements, and bind the attempt. No authority is transferred. */
export function bindAgentTaskRun(input: {
  runId: string; chatId: string; messageId: string; workspace: AgentTask["workspace"];
  intent?: "continue" | "new"; disposition: AgentMessageDisposition; expectedRevision?: number;
  updates?: AgentRequirementUpdate[]; predecessorRunId?: string;
}): AgentTaskBinding {
  const parsed = bindInput.parse(input), db = getDb();
  return db.transaction(() => {
    const run = db.prepare("SELECT r.chat_id,m.mode,m.workspace_root FROM runs r JOIN run_mode_details m ON m.run_id=r.id WHERE r.id=?").get(parsed.runId) as { chat_id: string; mode: string; workspace_root: string | null } | undefined;
    if (!run || run.chat_id !== parsed.chatId || run.mode !== "agent" || run.workspace_root !== parsed.workspace.root) throw new Error("Task binding requires an Agent run in the same chat and workspace.");
    const message = db.prepare("SELECT chat_id,role,content,run_id FROM messages WHERE id=?").get(parsed.messageId) as { chat_id: string; role: string; content: string; run_id: string | null } | undefined;
    if (!message || message.chat_id !== parsed.chatId || message.role !== "user" || (message.run_id && message.run_id !== parsed.runId)) throw new Error("Task binding requires its saved user message.");
    const existing = binding(parsed.runId);
    if (existing) {
      const source = db.prepare("SELECT source_message_id FROM agent_task_runs WHERE run_id=?").get(parsed.runId) as { source_message_id: string };
      const task = getAgentTask(existing.taskId)!;
      if (source.source_message_id !== parsed.messageId || JSON.stringify(task.workspace) !== JSON.stringify(parsed.workspace)) throw new Error("Run is already bound to another request or workspace.");
      return existing;
    }
    const duplicate = db.prepare("SELECT ar.run_id FROM agent_task_runs ar JOIN agent_tasks t ON t.task_id=ar.task_id WHERE t.chat_id=? AND ar.source_message_id=?").get(parsed.chatId, parsed.messageId);
    if (duplicate) throw new Error("This saved message already has an Agent attempt.");
    const otherActive = db.prepare("SELECT r.id FROM runs r JOIN run_mode_details m ON m.run_id=r.id WHERE r.chat_id=? AND r.id<>? AND r.state IN ('created','classifying','planning','acting','awaiting_confirmation')").get(parsed.chatId, parsed.runId);
    if (otherActive) throw new Error("This chat already has an active run.");
    const previous = getCurrentAgentTask(parsed.chatId);
    const continuing = parsed.intent === "continue" ? previous : undefined;
    if (continuing && JSON.stringify(continuing.workspace) !== JSON.stringify(parsed.workspace)) throw new Error("Workspace changed. Start a new task with fresh authority.");
    if ((continuing && parsed.expectedRevision !== continuing.snapshot.revision) || (!continuing && parsed.expectedRevision !== undefined)) throw new Error("Task revision changed. Load the current task before continuing.");
    if (parsed.predecessorRunId) {
      const predecessor = db.prepare("SELECT r.chat_id,m.mode,m.workspace_root,r.state FROM runs r JOIN run_mode_details m ON m.run_id=r.id WHERE r.id=?").get(parsed.predecessorRunId) as { chat_id: string; mode: string; workspace_root: string; state: string } | undefined;
      if (!predecessor || predecessor.chat_id !== parsed.chatId || predecessor.mode !== "agent" || predecessor.workspace_root !== parsed.workspace.root || !["partial","cancelled","failed","limit_exceeded","completed"].includes(predecessor.state)) throw new Error("Invalid predecessor attempt.");
    }
    const taskId = continuing?.taskId ?? randomUUID(), nextRevision = (continuing?.snapshot.revision ?? 0) + 1;
    const snapshot: AgentTaskRevision = continuing?.snapshot ?? { schemaVersion: 1, taskId, revision: nextRevision, messages: [], requirements: [] };
    snapshot.revision = nextRevision;
    snapshot.messages.push({ id: parsed.messageId, content: message.content, disposition: parsed.disposition });
    applyUpdates(snapshot, parsed.updates, parsed.messageId, parsed.disposition);
    const now = new Date().toISOString();
    if (!continuing) {
      db.prepare("UPDATE agent_tasks SET is_current=0 WHERE chat_id=? AND is_current=1").run(parsed.chatId);
      db.prepare("INSERT INTO agent_tasks(task_id,chat_id,workspace_json,current_revision,is_current,status,created_at,updated_at) VALUES (?,?,?,?,1,'open',?,?)").run(taskId, parsed.chatId, JSON.stringify(parsed.workspace), nextRevision, now, now);
    } else {
      // A status reply leaves the task status unchanged; regression evidence reopens it.
      const status = parsed.disposition === "status" ? continuing.status : "open";
      db.prepare("UPDATE agent_tasks SET current_revision=?,status=?,updated_at=? WHERE task_id=? AND current_revision=?").run(nextRevision, status, now, taskId, nextRevision - 1);
    }
    db.prepare("INSERT INTO agent_task_revisions(task_id,revision,source_message_id,snapshot_json,created_at) VALUES (?,?,?,?,?)").run(taskId, nextRevision, parsed.messageId, JSON.stringify(revision.parse(snapshot)), now);
    db.prepare("INSERT INTO agent_task_runs(run_id,task_id,task_revision,source_message_id,disposition,predecessor_run_id) VALUES (?,?,?,?,?,?)").run(parsed.runId, taskId, nextRevision, parsed.messageId, parsed.disposition, parsed.predecessorRunId ?? null);
    db.prepare("UPDATE messages SET run_id=? WHERE id=?").run(parsed.runId, parsed.messageId);
    return binding(parsed.runId)!;
  }).immediate();
}

/** Cross-run access is allowed only through verified task membership. ResultStore stays run-scoped. */
export function retrieveTaskEvidence(requestingRunId: string, reference: TaskEvidenceRef, slice: ResultSliceRequest) {
  const parsed = z.object({ taskId: id, originRunId: id, resultId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/), requirementIds: z.array(key).min(1), sourceRevision: z.string().min(1) }).strict().parse(reference);
  const requester = binding(id.parse(requestingRunId)), origin = binding(parsed.originRunId);
  if (!requester || !origin || requester.taskId !== parsed.taskId || origin.taskId !== parsed.taskId) throw new Error("Evidence is outside the authorized task.");
  const saved = getDb().prepare("SELECT snapshot_json FROM agent_task_revisions WHERE task_id=? AND revision=?").get(requester.taskId, requester.taskRevision) as { snapshot_json: string };
  const snapshot = revision.parse(JSON.parse(saved.snapshot_json));
  if (parsed.requirementIds.some(requirementId => !snapshot.requirements.some(item => item.id === requirementId))) throw new Error("Evidence refers to an unknown requirement.");
  const store = new RunResultStore(parsed.originRunId);
  if (store.getResult(parsed.resultId).storage.sha256 !== parsed.sha256) throw new Error("Evidence digest does not match the saved result.");
  // A sourceRevision labels historical evidence; it does not establish current applicability.
  return store.retrieveResultSlice(parsed.resultId, slice);
}
