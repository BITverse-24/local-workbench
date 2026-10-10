import { randomUUID } from "node:crypto";
import { getDb, prepareCached } from "../persistence/db.js";
import type { PendingAction } from "../../shared/contracts.js";
const prompts: Record<PendingAction["kind"], string> = {
  generate_docx: "Generate the approval-note DOCX?",
  execute_python: "Execute the generated Python?",
  generate_xlsx: "Generate the out-of-range summary XLSX?",
  uncontained_python: "Approve Python without OS isolation? Filesystem and network isolation are not enforced.",
  plan_approval: "Approve proposed execution plan?",
};
export function createConfirmation(runId: string, kind: PendingAction["kind"], preview?: string, customPrompt?: string): PendingAction {
  const now = new Date();
  const prompt = customPrompt || prompts[kind];
  const action: PendingAction = { actionId: randomUUID(), runId, kind, prompt, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300000).toISOString(), preview };
  const db = getDb();
  prepareCached(db, "INSERT INTO confirmations(action_id, run_id, kind, prompt, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(action.actionId, runId, kind, action.prompt, action.createdAt, action.expiresAt);
  return action;
}
export function decide(runId: string, actionId: string, approved: boolean): void {
  const db = getDb();
  const row = prepareCached(db, "SELECT * FROM confirmations WHERE action_id=? AND run_id=?").get(actionId, runId) as { expires_at: string; outcome?: string } | undefined;
  if (!row) throw new Error("confirmation not found");
  if (row.outcome) throw new Error("confirmation already decided");
  const expired = Date.now() >= Date.parse(row.expires_at);
  const outcome = expired ? "expired" : approved ? "approved" : "rejected";
  prepareCached(db, "UPDATE confirmations SET outcome=?, decided_at=? WHERE action_id=?").run(outcome, new Date().toISOString(), actionId);
  if (outcome !== "approved") throw new Error(`confirmation ${outcome}`);
}

export function cancelPending(runId: string): void {
  const db = getDb();
  prepareCached(db, "UPDATE confirmations SET outcome='cancelled', decided_at=? WHERE run_id=? AND outcome IS NULL").run(new Date().toISOString(), runId);
}
