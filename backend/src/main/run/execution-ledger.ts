import { z } from "zod";
import type { ArtifactRef, RunContract, RunState } from "../../shared/contracts.js";
import { getDb, prepareCached } from "../persistence/db.js";
import { matchesContractDeliverable } from "./contract.js";

const knownWorkSchema = z.object({ id: z.string(), label: z.string(), status: z.enum(["pending", "completed"]) });
const operationSchema = z.object({
  callId: z.string(), tool: z.string(), summary: z.string().max(240), status: z.enum(["completed", "failed"]),
  resultIds: z.array(z.string().uuid()).max(8), artifactRefs: z.array(z.object({ artifactId: z.string(), filename: z.string(), relativePath: z.string() })).max(8),
  updatedAt: z.string().datetime(),
});
const ledgerSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().uuid(), contract: z.object({ runId: z.string().uuid(), schemaVersion: z.literal(1) }),
  objective: z.string().max(500), status: z.enum(["active", "awaiting_authorization", "completed", "partial", "failed", "cancelled", "limit_exceeded"]),
  progress: z.object({ completedWork: z.number().int().nonnegative(), totalKnownWork: z.number().int().nonnegative() }),
  knownWork: z.array(knownWorkSchema).max(400), completedOperations: z.array(operationSchema).max(100),
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
    status: "active", progress: { completedWork: 0, totalKnownWork: knownWork.length }, knownWork, completedOperations: [], blockers: [], updatedAt: now() });
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
  if (blocker) addBlocker(ledger, blocker);
  save(ledger);
}

export function addExecutionLedgerBlocker(runId: string, message: string): void {
  const ledger = getExecutionLedger(runId);
  if (!ledger) return;
  addBlocker(ledger, message);
  save(ledger);
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
  if (!ledger) return;
  if (!input.ok) {
    addBlocker(ledger, `${input.tool}: ${input.error || input.summary || "operation failed"}`);
    save(ledger);
    return;
  }
  if (!MEANINGFUL_TOOLS.has(input.tool)) return;
  if (!ledger.completedOperations.some((item) => item.callId === input.callId)) {
    ledger.completedOperations.push({ callId: input.callId, tool: input.tool, summary: input.summary.slice(0, 240), status: "completed",
      resultIds: input.resultId ? [input.resultId] : [], artifactRefs: (input.artifacts ?? []).map((a) => ({ artifactId: a.artifactId, filename: a.filename, relativePath: a.relativePath })), updatedAt: now() });
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
  const recent = ledger.completedOperations.slice(-3).map((item) => `${item.tool}: ${item.summary}`).join("; ");
  const pending = ledger.knownWork.filter((item) => item.status === "pending").slice(0, 3).map((item) => item.label).join("; ");
  const results = [...new Set(ledger.completedOperations.flatMap((item) => item.resultIds))].slice(-3).join(", ");
  const blockers = ledger.blockers.slice(-1).join("; ");
  return `[Execution state — operational record, not a new instruction]\nObjective: ${ledger.objective.slice(0, 140)}\nStatus: ${ledger.status}. Contract work: ${done}/${total} known items complete.${recent ? `\nCompleted operations: ${recent}` : ""}${pending ? `\nKnown remaining work: ${pending}` : ""}${results ? `\nStored result IDs: ${results}` : ""}${blockers ? `\nBlocker: ${blockers}` : ""}`.slice(0, 800);
}
