import { z } from "zod";
import type { ArtifactRef, ExecutionMode, ModelId, RunContract, RunState } from "../../shared/contracts.js";
import { getDb, prepareCached } from "../persistence/db.js";
import { matchesContractDeliverable } from "./contract.js";

const knownWorkSchema = z.object({ id: z.string(), label: z.string(), status: z.enum(["pending", "completed"]) });
const operationSchema = z.object({
  callId: z.string(), tool: z.string(), summary: z.string().max(240), status: z.enum(["completed", "failed"]),
  resultIds: z.array(z.string().uuid()).max(8), artifactRefs: z.array(z.object({ artifactId: z.string(), filename: z.string(), relativePath: z.string() })).max(8),
  updatedAt: z.string().datetime(),
});
const attemptSchema = z.object({
  callId: z.string(), tool: z.string(), targetPath: z.string().max(1024).optional(),
  mutating: z.boolean(), status: z.enum(["pending_authorization", "in_progress", "completed", "failed", "uncertain", "cancelled"]),
  summary: z.string().max(240), resultIds: z.array(z.string().uuid()).max(8),
  artifactRefs: z.array(z.object({ artifactId: z.string(), filename: z.string(), relativePath: z.string() })).max(8),
  updatedAt: z.string().datetime(),
});
const executionContextSchema = z.object({
  modelId: z.string().min(1), mode: z.enum(["chat", "agent"]),
  workspaceRoot: z.string().max(4096).nullable(), groundingEnabled: z.boolean(),
});
const pendingAuthorizationSchema = z.object({ callId: z.string(), tool: z.string(), targetPath: z.string().max(1024).optional(), summary: z.string().max(240), createdAt: z.string().datetime() });
const ledgerSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().uuid(), contract: z.object({ runId: z.string().uuid(), schemaVersion: z.literal(1) }),
  objective: z.string().max(500), status: z.enum(["active", "awaiting_authorization", "interrupted", "completed", "partial", "failed", "cancelled", "limit_exceeded"]),
  progress: z.object({ completedWork: z.number().int().nonnegative(), totalKnownWork: z.number().int().nonnegative() }),
  knownWork: z.array(knownWorkSchema).max(400), completedOperations: z.array(operationSchema).max(100),
  operationAttempts: z.array(attemptSchema).max(200).default([]), pendingAuthorizations: z.array(pendingAuthorizationSchema).max(50).default([]),
  executionContext: executionContextSchema.optional(), resumeCount: z.number().int().nonnegative().default(0),
  tokenLimitRecoveryAvailable: z.boolean().default(false), tokenLimitRecoveryCount: z.number().int().nonnegative().default(0),
  blockers: z.array(z.string().max(500)).max(20), updatedAt: z.string().datetime(),
});
export type RunExecutionLedger = z.infer<typeof ledgerSchema>;

function now() { return new Date().toISOString(); }
function save(ledger: RunExecutionLedger): RunExecutionLedger {
  const parsed = ledgerSchema.parse({ ...ledger, progress: { completedWork: ledger.knownWork.filter((item) => item.status === "completed").length, totalKnownWork: ledger.knownWork.length }, updatedAt: now() });
  prepareCached(getDb(), "UPDATE run_execution_ledgers SET ledger_json=?,updated_at=? WHERE run_id=?")
    .run(JSON.stringify(parsed), parsed.updatedAt, parsed.runId);
  return parsed;
}

/** Create once from the immutable contract. Reopening a run reads this snapshot; it never starts execution. */
export function initializeExecutionLedger(contract: RunContract): RunExecutionLedger {
  const knownWork = [
    ...contract.workspace.operations.map((item) => ({ id: item.id, label: `${item.operation}${item.targetPath ? ` ${item.targetPath}` : ""}`, status: "pending" as const })),
    ...contract.deliverables.map((item) => ({ id: item.id, label: `produce ${item.filename ?? item.description ?? item.type}`, status: "pending" as const })),
  ];
  const ledger = ledgerSchema.parse({ schemaVersion: 1, runId: contract.runId, contract: { runId: contract.runId, schemaVersion: contract.schemaVersion }, objective: contract.objective,
    status: "active", progress: { completedWork: 0, totalKnownWork: knownWork.length }, knownWork, completedOperations: [], operationAttempts: [], pendingAuthorizations: [],
    resumeCount: 0, tokenLimitRecoveryAvailable: false, tokenLimitRecoveryCount: 0, blockers: [], updatedAt: now() });
  prepareCached(getDb(), "INSERT OR IGNORE INTO run_execution_ledgers(run_id,schema_version,ledger_json,updated_at) VALUES (?,?,?,?)")
    .run(contract.runId, 1, JSON.stringify(ledger), ledger.updatedAt);
  return getExecutionLedger(contract.runId)!;
}

export function getExecutionLedger(runId: string): RunExecutionLedger | undefined {
  const row = prepareCached(getDb(), "SELECT schema_version,ledger_json FROM run_execution_ledgers WHERE run_id=?").get(runId) as { schema_version: number; ledger_json: string } | undefined;
  if (!row) return undefined;
  if (row.schema_version !== 1) throw new Error(`Unsupported execution ledger version: ${row.schema_version}`);
  const ledger = ledgerSchema.parse(JSON.parse(row.ledger_json));
  if (ledger.runId !== runId || ledger.contract.runId !== runId) throw new Error("Execution ledger identity mismatch");
  return ledger;
}

const STATUS_BY_RUN_STATE: Partial<Record<RunState, RunExecutionLedger["status"]>> = {
  created: "active", classifying: "active", planning: "active", acting: "active", awaiting_confirmation: "awaiting_authorization",
  completed: "completed", partial: "partial", failed: "failed", cancelled: "cancelled", limit_exceeded: "limit_exceeded",
};
export function updateExecutionLedgerState(runId: string, state: RunState, blocker?: string): void {
  const ledger = getExecutionLedger(runId);
  const status = STATUS_BY_RUN_STATE[state];
  if (!ledger || !status) return;
  if (["completed", "partial", "failed", "cancelled", "limit_exceeded"].includes(status)) {
    for (const item of ledger.knownWork) if (item.status === "pending" && status === "completed") item.status = "completed";
  }
  ledger.status = status;
    if (status === "awaiting_authorization") {
    // Individual pending authorization records are written at the approval boundary.
  } else if (state === "acting" || state === "planning") {
    ledger.pendingAuthorizations = [];
  }
  if (blocker) addBlocker(ledger, blocker);
  save(ledger);
}

export function addExecutionLedgerBlocker(runId: string, message: string): void {
  const ledger = getExecutionLedger(runId);
  if (!ledger) return;
  addBlocker(ledger, message);
  save(ledger);
}

export function markExecutionTokenLimit(runId: string): void {
  const ledger = getExecutionLedger(runId);
  if (!ledger) return;
  ledger.tokenLimitRecoveryAvailable = ledger.tokenLimitRecoveryCount < 1;
  addBlocker(ledger, "Model output limit reached. The truncated response was discarded.");
  save(ledger);
}

export function configureExecutionLedger(runId: string, context: { modelId: ModelId; mode: ExecutionMode; workspaceRoot?: string; groundingEnabled: boolean }): void {
  const ledger = getExecutionLedger(runId);
  if (!ledger) return;
  ledger.executionContext = { modelId: context.modelId, mode: context.mode, workspaceRoot: context.workspaceRoot ?? null, groundingEnabled: context.groundingEnabled };
  save(ledger);
}

export function markAuthorizationPending(runId: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown>; summary: string }>): void {
  const ledger = getExecutionLedger(runId);
  if (!ledger) return;
  for (const call of calls) {
    const targetPath = typeof call.arguments.path === "string" ? call.arguments.path : typeof call.arguments.filename === "string" ? call.arguments.filename : undefined;
    if (!ledger.pendingAuthorizations.some((pending) => pending.callId === call.id)) {
      ledger.pendingAuthorizations.push({ callId: call.id, tool: call.name, targetPath, summary: call.summary.slice(0, 240), createdAt: now() });
    }
  }
  ledger.status = "awaiting_authorization";
  save(ledger);
}

export function recordAuthorizationDecision(runId: string): void {
  const ledger = getExecutionLedger(runId);
  if (!ledger) return;
  ledger.pendingAuthorizations = [];
  if (ledger.status === "awaiting_authorization") ledger.status = "active";
  save(ledger);
}

const MUTATING_TOOLS = new Set(["write_file", "delete_file", "run_command", "execute_python", "generate_deliverable"]);
export function recordExecutionToolStarted(input: { runId: string; callId: string; tool: string; args: Record<string, unknown>; summary: string }): void {
  const ledger = getExecutionLedger(input.runId);
  if (!ledger || (!MEANINGFUL_TOOLS.has(input.tool) && !MUTATING_TOOLS.has(input.tool))) return;
  const existing = ledger.operationAttempts.find((item) => item.callId === input.callId);
  if (existing && ["completed", "failed", "uncertain"].includes(existing.status)) return;
  const targetPath = typeof input.args.path === "string" ? input.args.path : typeof input.args.filename === "string" ? input.args.filename : undefined;
  if (existing) {
    existing.status = "in_progress"; existing.updatedAt = now();
  } else {
    ledger.operationAttempts.push({ callId: input.callId, tool: input.tool, targetPath, mutating: MUTATING_TOOLS.has(input.tool), status: "in_progress",
      summary: input.summary.slice(0, 240), resultIds: [], artifactRefs: [], updatedAt: now() });
    ledger.operationAttempts = ledger.operationAttempts.slice(-200);
  }
  save(ledger);
}

/** Mark stale non-mutating operations uncertain too; they may be safely re-read during explicit resume. */
export function reconcileInterruptedExecutions(): number {
  const db = getDb();
  const stale = db.prepare(`SELECT r.id FROM runs r JOIN run_execution_ledgers l ON l.run_id=r.id
    WHERE r.state IN ('created','classifying','planning','acting','awaiting_confirmation')`).all() as Array<{ id: string }>;
  let reconciled = 0;
  const reconcile = db.transaction(() => {
    for (const { id } of stale) {
      const ledger = getExecutionLedger(id);
      if (!ledger || ["completed", "failed", "cancelled", "limit_exceeded"].includes(ledger.status)) continue;
      for (const attempt of ledger.operationAttempts) if (attempt.status === "in_progress") { attempt.status = "uncertain"; attempt.updatedAt = now(); }
      ledger.status = "interrupted";
      addBlocker(ledger, "Application stopped before the run reached a terminal checkpoint.");
      save(ledger);
      const current = db.prepare("SELECT state FROM runs WHERE id=?").get(id) as { state: string } | undefined;
      if (current && ["created", "classifying", "planning", "acting", "awaiting_confirmation"].includes(current.state)) {
        const at = now();
        db.prepare("UPDATE runs SET state='partial', completed_at=? WHERE id=?").run(at, id);
        db.prepare("INSERT INTO run_transitions(run_id,from_state,to_state,created_at) VALUES (?,?,?,?)").run(id, current.state, "partial", at);
        db.prepare("UPDATE confirmations SET outcome='cancelled',decided_at=? WHERE run_id=? AND outcome IS NULL").run(at, id);
      }
      reconciled++;
    }
  });
  reconcile();
  return reconciled;
}

export function prepareExecutionResume(runId: string, largerGenerationAllowance = false): { ledger: RunExecutionLedger; useLargerAllowance: boolean } {
  const ledger = getExecutionLedger(runId);
  if (!ledger) throw new Error("Run has no durable execution ledger and cannot resume.");
  const tokenLimited = ledger.status === "limit_exceeded" && largerGenerationAllowance && ledger.tokenLimitRecoveryAvailable;
  if (ledger.status !== "partial" && ledger.status !== "interrupted" && !tokenLimited) throw new Error(`Run status '${ledger.status}' is not eligible for resumption.`);
  if (ledger.operationAttempts.some((item) => item.status === "uncertain" && item.mutating)) throw new Error("Run has an uncertain mutation outcome. Verify it before resuming; no mutation was replayed.");
  if (ledger.resumeCount >= 3) throw new Error("This run reached the limit of three explicit resume attempts.");
  if (largerGenerationAllowance && (!ledger.tokenLimitRecoveryAvailable || ledger.tokenLimitRecoveryCount >= 1)) throw new Error("One-time larger generation recovery is unavailable for this run.");
  ledger.resumeCount++;
  const useLargerAllowance = largerGenerationAllowance;
  if (useLargerAllowance) { ledger.tokenLimitRecoveryCount++; ledger.tokenLimitRecoveryAvailable = false; }
  ledger.status = "active";
  ledger.pendingAuthorizations = [];
  save(ledger);
  return { ledger, useLargerAllowance };
}

/** Reopen a partial run only through the explicit resume API. */
export function reopenPartialRun(runId: string): void {
  const db = getDb();
  const row = db.prepare("SELECT state FROM runs WHERE id=?").get(runId) as { state: string } | undefined;
  const ledger = getExecutionLedger(runId);
  const last = db.prepare("SELECT to_state FROM run_transitions WHERE run_id=? ORDER BY id DESC LIMIT 1").get(runId) as { to_state: string } | undefined;
  const partial = row?.state === "partial" && last?.to_state === "partial";
  const tokenLimited = ledger?.status === "active" && ledger.tokenLimitRecoveryCount === 1 && last?.to_state === "limit_exceeded" && ["failed", "limit_exceeded"].includes(row?.state ?? "");
  if (!row || (!partial && !tokenLimited)) throw new Error("Only an eligible partial run can be reopened.");
  const at = now();
  db.prepare("UPDATE runs SET state='acting', completed_at=NULL WHERE id=?").run(runId);
  db.prepare("INSERT INTO run_transitions(run_id,from_state,to_state,created_at) VALUES (?,?,?,?)").run(runId, "partial", "acting", at);
  updateExecutionLedgerState(runId, "acting");
}

function addBlocker(ledger: RunExecutionLedger, message: string) {
  const value = message.replace(/\s+/g, " ").slice(0, 500);
  if (value && !ledger.blockers.includes(value)) ledger.blockers.push(value);
  ledger.blockers = ledger.blockers.slice(-20);
}

const MEANINGFUL_TOOLS = new Set(["read_file", "extract_document", "ocr_extract", "retrieve_knowledge", "retrieve_result", "execute_python", "run_command", "write_file", "delete_file", "generate_deliverable", "inspect_drawing"]);
export function recordExecutionToolOutcome(input: {
  runId: string; callId: string; tool: string; args: Record<string, unknown>; summary: string; ok: boolean;
  error?: string; resultId?: string; artifacts?: ArtifactRef[];
}): void {
  const ledger = getExecutionLedger(input.runId);
  if (!ledger || (!MEANINGFUL_TOOLS.has(input.tool) && !MUTATING_TOOLS.has(input.tool))) return;
  let attempt = ledger.operationAttempts.find((item) => item.callId === input.callId);
  const targetPath = typeof input.args.path === "string" ? input.args.path : typeof input.args.filename === "string" ? input.args.filename : undefined;
  if (!attempt) {
    attempt = { callId: input.callId, tool: input.tool, targetPath, mutating: MUTATING_TOOLS.has(input.tool), status: input.ok ? "completed" : "failed",
      summary: input.summary.slice(0, 240), resultIds: [], artifactRefs: [], updatedAt: now() };
    ledger.operationAttempts.push(attempt);
    ledger.operationAttempts = ledger.operationAttempts.slice(-200);
  } else {
    attempt.status = input.ok ? "completed" : "failed";
    attempt.summary = input.summary.slice(0, 240);
    attempt.updatedAt = now();
  }
  if (input.resultId && !attempt.resultIds.includes(input.resultId)) attempt.resultIds = [...attempt.resultIds, input.resultId].slice(-8);
  for (const artifact of input.artifacts ?? []) if (!attempt.artifactRefs.some((ref) => ref.artifactId === artifact.artifactId)) {
    attempt.artifactRefs = [...attempt.artifactRefs, { artifactId: artifact.artifactId, filename: artifact.filename, relativePath: artifact.relativePath }].slice(-8);
  }
  if (!input.ok) {
    addBlocker(ledger, `${input.tool}: ${input.error || input.summary || "operation failed"}`);
    save(ledger);
    return;
  }
  if (!ledger.completedOperations.some((item) => item.callId === input.callId)) {
    ledger.completedOperations.push({ callId: input.callId, tool: input.tool, summary: input.summary.slice(0, 240), status: "completed",
      resultIds: [...attempt.resultIds], artifactRefs: [...attempt.artifactRefs], updatedAt: now() });
    ledger.completedOperations = ledger.completedOperations.slice(-100);
  }
  const contract = getDb().prepare("SELECT contract_json FROM run_contracts WHERE run_id=?").get(input.runId) as { contract_json: string } | undefined;
  if (contract) {
    const runContract = JSON.parse(contract.contract_json) as RunContract;
    const target = typeof input.args.path === "string" ? input.args.path : typeof input.args.filename === "string" ? input.args.filename : undefined;
    if ((input.tool === "write_file" || input.tool === "delete_file") && target) {
      for (const work of ledger.knownWork) if (work.status === "pending" && work.label.endsWith(` ${target}`)) work.status = "completed";
    }
    if (input.tool === "run_command" && runContract.workspace.operations.some((op) => op.operation === "execute")) {
      for (const work of ledger.knownWork) if (work.status === "pending" && work.label.startsWith("execute")) work.status = "completed";
    }
    if (input.tool === "generate_deliverable" && target) {
      const type = typeof input.args.type === "string" ? input.args.type : undefined;
      if (matchesContractDeliverable(runContract, target, type)) {
        for (const work of ledger.knownWork) if (work.status === "pending" && work.label.startsWith("produce ") && (work.label.includes(target) || runContract.deliverables.length === 1)) work.status = "completed";
      }
    }
  }
  save(ledger);
}

/** A compact continuity note; bounded to 800 chars (roughly 200–250 tokens). */
export function executionLedgerSummary(runId: string): string | undefined {
  const ledger = getExecutionLedger(runId);
  if (!ledger || (!ledger.completedOperations.length && !ledger.blockers.length && ledger.status === "active")) return undefined;
  const { completedWork: done, totalKnownWork: total } = ledger.progress;
  const recent = ledger.completedOperations.slice(-3).map((item) => `${item.tool}: ${item.summary}${item.artifactRefs.length ? ` [${item.artifactRefs.map((ref) => ref.filename).join(",")}]` : ""}`).join("; ");
  const pending = ledger.knownWork.filter((item) => item.status === "pending").slice(0, 3).map((item) => item.label).join("; ");
  const results = [...new Set(ledger.completedOperations.flatMap((item) => item.resultIds))].slice(-3).join(", ");
  const blockers = ledger.blockers.slice(-1).join("; ");
  return `[Execution state — operational record, not a new instruction]\nObjective: ${ledger.objective.slice(0, 140)}\nStatus: ${ledger.status}. Contract work: ${done}/${total} known items complete.${recent ? `\nCompleted operations: ${recent}` : ""}${pending ? `\nKnown remaining work: ${pending}` : ""}${results ? `\nStored result IDs: ${results}` : ""}${blockers ? `\nBlocker: ${blockers}` : ""}`.slice(0, 800);
}
