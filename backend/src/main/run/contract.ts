import path from "node:path";
import { z } from "zod";
import type { AgentOutcome, ExecutionMode, OutputExpectation, RunContract } from "../../shared/contracts.js";
import type { SemanticIntent } from "../router/contextual-router.js";
import { getDb, prepareCached } from "../persistence/db.js";
import { assertSafeRelativePath } from "../persistence/paths.js";

const pathSchema = z.string().min(1).max(1024).refine((value) => {
  try { assertSafeRelativePath(value); return true; } catch { return false; }
}, "Expected a contained relative path");
export function normalizeSuccessMarker(value?: string | null): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const SuccessMarkerSchema = z
  .string()
  .nullish()
  .transform((val) => normalizeSuccessMarker(val))
  .pipe(z.string().min(1).max(128).optional());

export const RunContractSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().uuid(), createdAt: z.string().datetime(),
  objective: z.string().min(1).max(500),
  resolution: z.object({ status: z.enum(["resolved", "ambiguous", "failed"]), ambiguity: z.string().max(1000).optional() }),
  routing: z.object({ intentType: z.enum(["code_modification", "file_inspection", "command_execution", "document_drafting", "pure_chat", "general_qa"]), taskType: z.enum(["code", "draft", "vision"]), driverModel: z.string().min(1), actionable: z.boolean() }),
  response: z.object({ required: z.boolean(), chatOnly: z.boolean() }),
  workspace: z.object({ requested: z.boolean(), operations: z.array(z.object({ id: z.string(), operation: z.enum(["mutate", "write", "delete", "execute"]), targetPath: pathSchema.optional(), sourceId: z.string().min(1).optional(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(200) }),
  deliverables: z.array(z.object({ id: z.string(), filename: pathSchema.optional(), filenameRequired: z.boolean().default(false), type: z.enum(["docx", "xlsx", "csv", "pdf", "md", "json", "file"]), description: z.string().max(1000).optional() })).max(200),
  constraints: z.object({ protectedPaths: z.array(pathSchema).max(200), restrictMutationsToTargets: z.boolean(), userConstraints: z.array(z.string().max(500)).max(50) }),
  acceptance: z.object({ validateWrittenCode: z.boolean(), validatedPythonDeliverables: z.array(pathSchema), successMarker: SuccessMarkerSchema, artifactChecks: z.array(z.object({ id: z.string().max(100), filename: pathSchema.optional(), kind: z.enum(["contains_text", "heading", "columns", "json_key", "row_count", "sheet", "semantic"]), expected: z.union([z.string().max(2000), z.number()]), mandatory: z.boolean(), basis: z.string().min(1).max(4000) })).max(100).default([]) }),
});

export function normalizeContractPath(value: string): string {
  const clean = value.trim().replace(/^@\/?/, "").replace(/\\/g, "/").replace(/^\.\//, "");
  assertSafeRelativePath(clean);
  return clean.split("/").filter((part) => part && part !== ".").join("/");
}
const normalizePath = normalizeContractPath;
function protectedTarget(target: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((p) => target === p || target.startsWith(`${p}/`));
}

/** Normalize only the semantic interpreter's fields; never parse the raw request again. */
export function normalizeRunContract(runId: string, intent: SemanticIntent, options: { mode?: ExecutionMode; newRun?: boolean } = {}): RunContract {
  const protectedPaths = [...new Set(intent.protectedPaths.map(normalizePath))];
  const chatOnly = intent.chatResponseOnly || intent.status !== "resolved";
  const requested = !chatOnly && intent.workspaceMutationRequested;
  const targets = requested ? [...new Set(intent.targetFiles.map(normalizePath))].filter((p) => !protectedTarget(p, protectedPaths)) : [];
  const operations: RunContract["workspace"]["operations"] = [];
  if (requested) {
    for (const supplied of intent.workspaceOperations ?? []) {
      const targetPath = supplied.targetPath ? normalizePath(supplied.targetPath) : undefined;
      if (targetPath && (protectedTarget(targetPath, protectedPaths) || (intent.restrictMutationsToTargets && !targets.includes(targetPath)))) continue;
      if (supplied.operation !== "execute" && !targetPath) continue;
      operations.push({ id: `workspace-${operations.length + 1}`, operation: supplied.operation, targetPath });
    }
    for (const targetPath of targets) {
      if (!operations.some((op) => op.targetPath === targetPath)) operations.push({ id: `workspace-${operations.length + 1}`, operation: "mutate", targetPath });
    }
  }
  if (!chatOnly && intent.isActionable && intent.intentType === "command_execution" && !operations.some((op) => op.operation === "execute")) {
    operations.push({ id: `workspace-${operations.length + 1}`, operation: "execute" });
  }
  if (requested && operations.length === 0) operations.push({ id: "workspace-1", operation: "mutate" });
  const plannedTargets = operations.flatMap(operation => operation.targetPath ? [operation.targetPath] : []);
  const documentsOnly = plannedTargets.length > 0 && plannedTargets.every(target => /\.(?:md|mdx|rst|txt|adoc|docx|xlsx|pdf|png|jpe?g|gif|svg|webp|ico|avif|bmp|tiff?|woff2?|ttf|otf)$/i.test(target));
  const deliverables: RunContract["deliverables"] = [];
  if (!chatOnly) {
    for (const d of intent.expectedDeliverables) {
      const filename = d.filename ? normalizePath(d.filename) : undefined;
      // Every workspace resource, including formatted documents, is distinct from an export.
      if (filename && (protectedTarget(filename, protectedPaths) || operations.some((op) => op.targetPath === filename))) continue;
      if (deliverables.some((existing) => filename && existing.filename === filename)) continue;
      deliverables.push({ id: `deliverable-${deliverables.length + 1}`, filename, filenameRequired: Boolean(d.filenameRequired), type: d.type, description: d.description });
    }
  }
  return RunContractSchema.parse({
    schemaVersion: 1, runId, createdAt: new Date().toISOString(), objective: intent.primaryGoal,
    resolution: { status: intent.status, ambiguity: intent.ambiguityDetails },
    routing: { intentType: intent.intentType, taskType: intent.taskType, driverModel: intent.driverModel, actionable: intent.isActionable && !chatOnly },
    response: { required: intent.responseRequired ?? true, chatOnly },
    workspace: { requested, operations }, deliverables,
    constraints: { protectedPaths, restrictMutationsToTargets: intent.restrictMutationsToTargets, userConstraints: intent.userConstraints ?? [] },
    acceptance: {
      validateWrittenCode: requested && intent.intentType === "code_modification" && (Boolean(intent.validationRequested) || (options.mode === "agent" && options.newRun === true && !documentsOnly)),
      validatedPythonDeliverables: intent.intentType === "code_modification" ? deliverables.filter((d) => d.filename?.endsWith(".py")).map((d) => d.filename!) : [],
      successMarker: normalizeSuccessMarker(intent.successMarker),
    },
  });
}

/** Insert once. Reinterpreting an existing run cannot silently expand its expectations. */
export function persistRunContract(contract: RunContract): RunContract {
  const validated = RunContractSchema.parse(contract);
  const json = JSON.stringify(validated);
  if (Buffer.byteLength(json) > 64 * 1024) throw new Error("Run contract exceeds metadata limit");
  prepareCached(getDb(), "INSERT INTO run_contracts(run_id,schema_version,contract_json,created_at) VALUES (?,?,?,?)").run(contract.runId, contract.schemaVersion, json, contract.createdAt);
  return getRunContract(contract.runId)!;
}
export function getRunContract(runId: string): RunContract | undefined {
  z.string().uuid().parse(runId);
  const row = prepareCached(getDb(), "SELECT schema_version,contract_json FROM run_contracts WHERE run_id=?").get(runId) as { schema_version: number; contract_json: string } | undefined;
  if (!row) return undefined;
  if (row.schema_version !== 1) throw new Error(`Unsupported run contract schema version: ${row.schema_version}`);
  const stored = JSON.parse(row.contract_json);
  // Read older role-routed contracts under the single-model architecture.
  if (["code-qwen25coder", "draft-qwen3", "vision-qwen25vl"].includes(stored?.routing?.driverModel)) stored.routing.driverModel = "primary-model";
  const contract = RunContractSchema.parse(stored);
  if (contract.runId !== runId) throw new Error("Run contract identity mismatch");
  return contract;
}

export function outputExpectationFromContract(contract: RunContract): OutputExpectation {
  return {
    chatResponse: contract.response.required, expectedFiles: contract.deliverables.flatMap((d) => d.filename ? [d.filename] : []),
    workspaceMutationRequested: contract.workspace.requested,
    targetFiles: contract.workspace.operations.flatMap((op) => op.targetPath ? [op.targetPath] : []),
    expectedDeliverables: contract.deliverables, protectedPaths: contract.constraints.protectedPaths,
    restrictMutationsToTargets: contract.constraints.restrictMutationsToTargets,
  };
}
export function matchesContractDeliverable(contract: RunContract, filename: string, type?: string): boolean {
  const normalized = normalizePath(filename);
  const ext = path.extname(normalized).replace(/^\./, "").toLowerCase();
  const stem = path.basename(normalized, path.extname(normalized)).toLowerCase();
  return contract.deliverables.some((d) => {
    const dExt = (d.filename ? path.extname(d.filename).replace(/^\./, "") : d.type).toLowerCase();
    const typeMatches = !type || d.type === type || d.type === "file" || type === "file" || ext === d.type || ext === dExt;
    if (!typeMatches) return false;
    if (!d.filename) return d.type === "file" || ext === d.type;
    const dStem = path.basename(d.filename, path.extname(d.filename)).toLowerCase();
    if (normalized === d.filename) return true;
    if (d.filenameRequired) return false;
    if (stem === dStem || stem.startsWith(dStem) || dStem.startsWith(stem)) return true;
    if (contract.deliverables.length === 1) return true;
    return false;
  });
}
/** Compatibility projection for the existing compositor and loop branches. */
export function intentFromContract(contract: RunContract): SemanticIntent {
  const output = outputExpectationFromContract(contract);
  return {
    status: contract.resolution.status, driverModel: contract.routing.driverModel, taskType: contract.routing.taskType,
    intentType: contract.routing.intentType as SemanticIntent["intentType"], primaryGoal: contract.objective,
    isActionable: contract.routing.actionable, chatResponseOnly: contract.response.chatOnly,
    workspaceMutationRequested: contract.workspace.requested, targetFiles: output.targetFiles!,
    protectedPaths: contract.constraints.protectedPaths, restrictMutationsToTargets: contract.constraints.restrictMutationsToTargets,
    expectedDeliverables: contract.deliverables, reason: "persisted run contract", ambiguityDetails: contract.resolution.ambiguity,
    outputExpectation: output,
    responseRequired: contract.response.required, validationRequested: contract.acceptance.validateWrittenCode,
    successMarker: contract.acceptance.successMarker, userConstraints: contract.constraints.userConstraints,
    workspaceOperations: contract.workspace.operations.map(({ operation, targetPath }) => ({ operation, targetPath })),
  };
}

export interface CompletionEvidence {
  artifacts: Set<string>;
  written: Set<string>;
  deleted: Set<string>;
  commandExecuted: boolean;
  writtenValidationPassed: boolean;
  validatedPythonArtifacts: Set<string>;
  responseText: string;
  hadErrors: boolean;
  cancelled?: boolean;
  limitExceeded?: boolean;
}
export function evaluateRunContractCompletion(contract: RunContract, evidence: CompletionEvidence) {
  const producedDeliverables: string[] = [], missingDeliverables: string[] = [], producedMutations: string[] = [], missingMutations: string[] = [];
  const remaining = new Set([...evidence.artifacts].map(normalizePath));
  for (const expected of contract.deliverables) {
    const match = [...remaining].find((p) => {
      if (expected.filename) {
        if (p === expected.filename) return true;
        if (expected.filenameRequired) return false;
        const pExt = path.extname(p).replace(/^\./, "").toLowerCase();
        const expExt = path.extname(expected.filename).replace(/^\./, "").toLowerCase();
        if (pExt !== expExt && expected.type && pExt !== expected.type) return false;
        const pStem = path.basename(p, path.extname(p)).toLowerCase();
        const expStem = path.basename(expected.filename, path.extname(expected.filename)).toLowerCase();
        if (pStem === expStem || pStem.startsWith(expStem) || expStem.startsWith(pStem)) return true;
        if (contract.deliverables.length === 1) return true;
        return false;
      }
      return expected.type === "file" || p.endsWith(`.${expected.type}`);
    });
    if (match) { producedDeliverables.push(match); remaining.delete(match); }
    else missingDeliverables.push(expected.filename ?? expected.description ?? expected.id);
  }
  for (const expected of contract.workspace.operations) {
    const target = expected.targetPath;
    const satisfied = expected.operation === "execute" ? evidence.commandExecuted : !target ? evidence.written.size + evidence.deleted.size > 0 : Boolean(target && (
      expected.operation === "delete" ? evidence.deleted.has(target) : expected.operation === "write" ? evidence.written.has(target) : evidence.written.has(target) || evidence.deleted.has(target)
    ));
    (satisfied ? producedMutations : missingMutations).push(target ?? (expected.operation === "execute" ? "requested command execution" : "requested workspace mutation"));
  }
  const missingAcceptance: string[] = [];
  if (contract.acceptance.validateWrittenCode && !evidence.writtenValidationPassed) missingAcceptance.push("validation against the latest written code");
  for (const filename of contract.acceptance.validatedPythonDeliverables) if (!evidence.validatedPythonArtifacts.has(filename)) missingAcceptance.push(`validated source: ${filename}`);
  if (contract.response.required && !evidence.responseText.trim()) missingAcceptance.push("conversational response");
  const missing = missingDeliverables.length + missingMutations.length + missingAcceptance.length;
  let outcome: AgentOutcome = missing === 0 && !evidence.hadErrors ? "completed" : evidence.hadErrors && !producedDeliverables.length && !producedMutations.length ? "failed" : "partial";
  if (evidence.cancelled) outcome = "cancelled";
  else if (evidence.limitExceeded) outcome = "limit_exceeded";
  else if (contract.resolution.status !== "resolved" && (producedDeliverables.length || producedMutations.length)) outcome = "partial";
  return { outcome, producedDeliverables, missingDeliverables, producedMutations, missingMutations, missingAcceptance };
}
