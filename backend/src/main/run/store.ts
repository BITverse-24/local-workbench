import { randomUUID } from "node:crypto";
import type { RunState } from "../../shared/contracts.js";
import { getDb, prepareCached } from "../persistence/db.js";
export interface RunSummary { runId: string; chatId: string; state: RunState; createdAt: string; completedAt?: string; }
export function createRun(chatId: string, summary: string, attachmentId?: string, explicitId?: string): string {
  const db = getDb();
  if (explicitId) {
    const existing = prepareCached(db, "SELECT id FROM runs WHERE id=?").get(explicitId) as { id: string } | undefined;
    if (existing) return explicitId;
  }
  const id = explicitId ?? randomUUID();
  const now = new Date().toISOString();
  prepareCached(db, "INSERT INTO runs(id, chat_id, state, user_text_summary, attachment_id, created_at) VALUES (?, ?, 'created', ?, ?, ?)").run(id, chatId, summary.slice(0, 500), attachmentId ?? null, now);
  return id;
}
const TERMINAL_STATES: RunState[] = ["completed", "partial", "failed", "cancelled", "limit_exceeded"];

export function transition(runId: string, to: RunState): void {
  const db = getDb();
  const now = new Date().toISOString();
  const current = prepareCached(db, "SELECT state FROM runs WHERE id=?").get(runId) as { state: RunState } | undefined;
  if (!current) throw new Error("run not found");
  if (TERMINAL_STATES.includes(current.state)) throw new Error(`run is terminal: ${current.state}`);
  try {
    prepareCached(db, "UPDATE runs SET state=?, completed_at=CASE WHEN ? IN ('completed','partial','failed','cancelled','limit_exceeded') THEN ? ELSE completed_at END WHERE id=?").run(to, to, now, runId);
  } catch {
    // Graceful fallback for existing databases with older CHECK constraint before migration:
    const fallback = to === "partial" ? "completed" : to === "limit_exceeded" ? "failed" : to;
    prepareCached(db, "UPDATE runs SET state=?, completed_at=CASE WHEN ? IN ('completed','partial','failed','cancelled','limit_exceeded') THEN ? ELSE completed_at END WHERE id=?").run(fallback, to, now, runId);
  }
  prepareCached(db, "INSERT INTO run_transitions(run_id, from_state, to_state, created_at) VALUES (?, ?, ?, ?)").run(runId, current.state, to, now);
}
export function getState(runId: string): RunState {
  const db = getDb();
  const latestTransition = prepareCached(db, "SELECT to_state FROM run_transitions WHERE run_id=? ORDER BY id DESC LIMIT 1").get(runId) as { to_state: string } | undefined;
  if (latestTransition && (latestTransition.to_state === "partial" || latestTransition.to_state === "limit_exceeded")) {
    return latestTransition.to_state as RunState;
  }
  const row = prepareCached(db, "SELECT state FROM runs WHERE id=?").get(runId) as { state: RunState } | undefined;
  if (!row) throw new Error("run not found");
  return row.state;
}
export function listRuns(limit = 50): RunSummary[] {
  const db = getDb();
  const rows = prepareCached(db, "SELECT id as runId, chat_id as chatId, state, created_at as createdAt, completed_at as completedAt FROM runs ORDER BY created_at DESC LIMIT ?").all(Math.min(limit, 200)) as RunSummary[];
  return rows.map((r) => {
    const latestTransition = prepareCached(db, "SELECT to_state FROM run_transitions WHERE run_id=? ORDER BY id DESC LIMIT 1").get(r.runId) as { to_state: string } | undefined;
    if (latestTransition && (latestTransition.to_state === "partial" || latestTransition.to_state === "limit_exceeded")) {
      return { ...r, state: latestTransition.to_state as RunState };
    }
    return r;
  });
}
export function recordRouting(runId: string, requestId: string, taskType: string, modelId: string, reason: string): void {
  const db = getDb();
  prepareCached(db, "INSERT INTO routing_decisions(run_id, request_id, task_type, model_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(runId, requestId, taskType, modelId, reason, new Date().toISOString());
}
export function recordError(runId: string, code: string, message: string, retryable = false): void {
  const db = getDb();
  prepareCached(db, "INSERT INTO run_errors(run_id, code, message, retryable, created_at) VALUES (?, ?, ?, ?, ?)").run(runId, code, message.slice(0, 1000), retryable ? 1 : 0, new Date().toISOString());
}
