import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RunContract, RunVerificationReport, VerificationCheck, VerificationStatus } from "../../shared/contracts.js";
import { getDb } from "../persistence/db.js";
import { matchesContractDeliverable, getRunContract, normalizeContractPath } from "./contract.js";
import { absoluteDataPath, runRoot, sha256File } from "./filesystem.js";
import { getExecutionLedger } from "./execution-ledger.js";
import { RunResultStore } from "./result-store.js";
import { resolveSafe } from "../harness/path-guard.js";

const evidenceSchema = z.object({ kind: z.enum(["result", "artifact", "execution"]), id: z.string().min(1).max(256) });
const checkSchema = z.object({
  criterionId: z.string().min(1).max(256), requirement: z.string().max(500),
  status: z.enum(["passed", "failed", "unverified", "not_applicable"]),
  method: z.enum(["sha256", "result_store_checksum", "format_parser", "filesystem", "execution_record", "agent_loop_completion", "content_check", "independent_reader"]),
  evidence: z.array(evidenceSchema).max(40), reason: z.string().max(500), verifiedAt: z.string().datetime(), mandatory: z.boolean(),
});
const reportSchema = z.object({ schemaVersion: z.literal(1), runId: z.string().uuid(), status: z.enum(["passed", "failed", "unverified", "not_applicable"]), checks: z.array(checkSchema).max(2000), updatedAt: z.string().datetime() });
type ArtifactRow = { artifact_id: string; kind: string; filename: string; relative_path: string; size_bytes: number; sha256: string | null };
const MAX_STRUCTURAL_PARSE_BYTES = 64 * 1024 * 1024;

function now(): string { return new Date().toISOString(); }
function check(input: Omit<VerificationCheck, "verifiedAt">, timestamp = now()): VerificationCheck {
  return checkSchema.parse({ ...input, verifiedAt: timestamp });
}
function fileFormat(file: string, kind: string, bytes: Buffer): { status: VerificationStatus; reason: string } {
  if (bytes.length === 0) return { status: "failed", reason: "Artifact is empty." };
  const ext = path.extname(file).toLowerCase();
  const extensionKind: Record<string, string> = { ".docx": "docx", ".xlsx": "xlsx", ".pdf": "pdf", ".csv": "csv", ".json": "json", ".md": "md", ".txt": "txt" };
  if (extensionKind[ext] && extensionKind[ext] !== kind) return { status: "failed", reason: `File extension ${ext} does not match registered format ${kind}.` };
  if ((kind === "docx" && ext === ".doc") || (kind === "xlsx" && ext === ".xls")) return { status: "not_applicable", reason: `Legacy ${ext} format is not parsed by this verifier.` };
  if (kind === "txt" && ![".txt", ".py", ".sh", ".sql", ".log", ".ts", ".tsx", ".js", ".jsx", ".c", ".cpp", ".h", ".java", ".rs"].includes(ext)) return { status: "not_applicable", reason: `No parser is configured for ${ext || "this file extension"}.` };
  try {
    if (kind === "json") { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); return { status: "passed", reason: "JSON parsed successfully and the file extension matches." }; }
    if (kind === "pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-" && bytes.includes(Buffer.from("%%EOF"))
      ? { status: "passed", reason: "PDF header and end marker are present." } : { status: "failed", reason: "PDF header or end marker is missing." };
    if (kind === "docx" || kind === "xlsx") {
      const requiredEntry = kind === "docx" ? "word/document.xml" : "xl/workbook.xml";
      const zipSignature = bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]);
      return zipSignature && bytes.includes(Buffer.from(requiredEntry))
        ? { status: "passed", reason: `ZIP package contains ${requiredEntry}.` } : { status: "failed", reason: `The ${kind.toUpperCase()} package is missing a valid ZIP signature or ${requiredEntry}.` };
    }
    if (["txt", "md"].includes(kind)) { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return { status: "passed", reason: "Text is valid UTF-8 and the extension matches the registered format." }; }
    if (kind === "csv") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      let quoted = false, afterQuote = false, atFieldStart = true;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
          if (char === '"' && text[i + 1] === '"') { i++; continue; }
          if (char === '"') { quoted = false; afterQuote = true; }
          continue;
        }
        if (afterQuote) {
          if (char === ",") { afterQuote = false; atFieldStart = true; continue; }
          if (char === "\n" || char === "\r") { afterQuote = false; atFieldStart = true; continue; }
          return { status: "failed", reason: "CSV has characters after a quoted field." };
        }
        if (char === '"') {
          if (!atFieldStart) return { status: "failed", reason: "CSV contains a quote inside an unquoted field." };
          quoted = true; atFieldStart = false;
        } else if (char === ",") atFieldStart = true;
        else if (char === "\n" || char === "\r") atFieldStart = true;
        else atFieldStart = false;
      }
      return quoted ? { status: "failed", reason: "CSV contains an unclosed quoted field." } : { status: "passed", reason: "CSV text is valid UTF-8 and quoted fields are balanced." };
    }
    return { status: "not_applicable", reason: `No structural parser is defined for format ${kind}.` };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? `Format parser failed: ${error.message}`.slice(0, 500) : "Format parser failed." };
  }
}
function outputArtifactPath(runId: string, relativePath: string): string {
  const prefix = `runs/${runId}/output/`;
  if (!relativePath.startsWith(prefix)) throw new Error("Artifact path is outside this run's output directory.");
  const target = absoluteDataPath(relativePath);
  const root = realpathSync(path.join(runRoot(runId), "output"));
  const actual = realpathSync(target);
  if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw new Error("Artifact resolves outside this run's output directory.");
  return actual;
}

function persist(report: RunVerificationReport): RunVerificationReport {
  const parsed = reportSchema.parse(report);
  getDb().prepare(`INSERT INTO run_verification_reports(run_id,schema_version,report_json,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET schema_version=excluded.schema_version,report_json=excluded.report_json,updated_at=excluded.updated_at`)
    .run(parsed.runId, 1, JSON.stringify(parsed), parsed.updatedAt);
  return parsed;
}
export function getVerificationReport(runId: string): RunVerificationReport | undefined {
  const row = getDb().prepare("SELECT schema_version,report_json FROM run_verification_reports WHERE run_id=?").get(runId) as { schema_version: number; report_json: string } | undefined;
  if (!row) return undefined;
  if (row.schema_version !== 1) throw new Error(`Unsupported verification report version: ${row.schema_version}`);
  const report = reportSchema.parse(JSON.parse(row.report_json));
  if (report.runId !== runId) throw new Error("Verification report identity mismatch");
  return report;
}

/** Deterministic checks over durable evidence. Semantic criteria remain unverified unless P0's evaluator accepted them. */
export function verifyRunEvidence(runId: string, options: { contractEvaluatorPassed?: boolean } = {}): RunVerificationReport | undefined {
  const contract = getRunContract(runId);
  if (!contract || contract.response.chatOnly || !contract.routing.actionable) return undefined;
  const timestamp = now();
  const checks: VerificationCheck[] = [];
  const db = getDb();
  const artifacts = db.prepare("SELECT artifact_id,kind,filename,relative_path,size_bytes,sha256 FROM artifacts WHERE run_id=? ORDER BY created_at,artifact_id").all(runId) as ArtifactRow[];
  const ledger = getExecutionLedger(runId);
  const attempts = ledger?.operationAttempts ?? [];

  for (const artifact of artifacts) {
    const matches = matchesContractDeliverable(contract, artifact.filename, artifact.kind);
    const evidence = [{ kind: "artifact" as const, id: artifact.artifact_id }];
    let target: string | undefined;
    let bytes: Buffer | undefined;
    let digest: string | undefined;
    let pathError: string | undefined;
    try {
      target = outputArtifactPath(runId, artifact.relative_path);
      const stat = statSync(target);
      if (!stat.isFile() || stat.size !== artifact.size_bytes) throw new Error("File is missing or registered size differs from current size.");
      digest = sha256File(target);
      if (stat.size <= MAX_STRUCTURAL_PARSE_BYTES) bytes = readFileSync(target);
    } catch (error) { pathError = error instanceof Error ? error.message : "Artifact could not be opened."; }
    checks.push(check({ criterionId: `artifact-integrity:${artifact.artifact_id}`, requirement: `Integrity of artifact ${artifact.filename}`, status: pathError ? "failed" : !artifact.sha256 ? "unverified" : digest === artifact.sha256 ? "passed" : "failed",
      method: "sha256", evidence, reason: pathError ?? (!artifact.sha256 ? "Legacy artifact has no stored SHA-256 digest." : digest === artifact.sha256 ? "SHA-256 matches the registered digest." : "Current artifact SHA-256 differs from the registered digest."), mandatory: matches && (Boolean(artifact.sha256) || Boolean(pathError)) }));
    if (bytes) {
      const result = fileFormat(artifact.filename, artifact.kind, bytes);
      checks.push(check({ criterionId: `artifact-format:${artifact.artifact_id}`, requirement: `Structural format of ${artifact.filename}`, status: result.status, method: "format_parser", evidence, reason: result.reason, mandatory: matches && result.status !== "not_applicable" }));
    } else if (!pathError) {
      checks.push(check({ criterionId: `artifact-format:${artifact.artifact_id}`, requirement: `Structural format of ${artifact.filename}`, status: "unverified", method: "format_parser", evidence, reason: "Artifact exceeds the structural parser's 64 MiB bound. SHA-256 was checked separately.", mandatory: false }));
    } else {
      checks.push(check({ criterionId: `artifact-format:${artifact.artifact_id}`, requirement: `Structural format of ${artifact.filename}`, status: "failed", method: "format_parser", evidence, reason: pathError ?? "Artifact could not be opened.", mandatory: matches }));
    }
  }

  const resultIds = [...new Set([...(ledger?.operationAttempts.flatMap((item) => item.resultIds) ?? []), ...(ledger?.completedOperations.flatMap((item) => item.resultIds) ?? [])])].slice(-1200);
  const resultStore = new RunResultStore(runId);
  for (const resultId of resultIds) {
    const integrity = resultStore.verifyIntegrity(resultId);
    checks.push(check({ criterionId: `result-integrity:${resultId}`, requirement: `Integrity of stored result ${resultId}`, status: integrity.valid ? "passed" : "failed", method: "result_store_checksum", evidence: [{ kind: "result", id: resultId }], reason: integrity.reason, mandatory: false }));
  }

  for (const deliverable of contract.deliverables) {
    const found = artifacts.find((artifact) => matchesContractDeliverable(contract, artifact.filename, artifact.kind));
    if (found) {
      checks.push(check({ criterionId: `deliverable:${deliverable.id}`, requirement: deliverable.filename ?? deliverable.description ?? `Produce ${deliverable.type}`, status: "passed", method: "filesystem", evidence: [{ kind: "artifact", id: found.artifact_id }], reason: "A registered artifact matches the RunContract deliverable. Its format and integrity have separate checks.", mandatory: true }));
    } else {
      const operation = attempts.find((attempt) => ["generate_deliverable", "generate_docx", "generate_xlsx"].includes(attempt.tool));
      const status = operation ? (operation.status === "completed" ? "failed" : operation.status === "failed" ? "failed" : "unverified") : "unverified";
      checks.push(check({ criterionId: `deliverable:${deliverable.id}`, requirement: deliverable.filename ?? deliverable.description ?? `Produce ${deliverable.type}`, status, method: "execution_record", evidence: operation ? [{ kind: "execution", id: operation.callId }] : [], reason: operation?.status === "completed" ? "Generation completed, but no matching artifact is registered." : operation?.status === "failed" ? "The recorded artifact generation failed." : "No matching registered artifact is available; there is not enough evidence to decide whether generation was attempted.", mandatory: true }));
    }
  }

  for (const operation of contract.workspace.operations) {
    const targetMatches = (item: { targetPath?: string }) => {
      if (!operation.targetPath || !item.targetPath) return false;
      try { return normalizeContractPath(item.targetPath) === normalizeContractPath(operation.targetPath); } catch { return false; }
    };
    const latest = attempts.filter((item) => operation.operation === "execute"
      ? ["run_command", "execute_python"].includes(item.tool)
      : targetMatches(item) && ["write_file", "delete_file"].includes(item.tool))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    let status: VerificationStatus = "unverified", reason = "No successful execution record exists for this contract operation.", method: VerificationCheck["method"] = "execution_record";
    let evidence: VerificationCheck["evidence"] = [];
    if (latest) {
      evidence = [{ kind: "execution", id: latest.callId }];
      if (latest.status === "failed") { status = "failed"; reason = "The latest recorded operation failed."; }
      else if (latest.status !== "completed") { status = "unverified"; reason = `The latest recorded operation is ${latest.status}.`; }
      else if (operation.operation === "execute") { status = "passed"; reason = "The ledger records a successful command or script execution."; }
      else if (!operation.targetPath || !ledger?.executionContext?.workspaceRoot) { status = "unverified"; reason = "The successful operation is recorded, but its authorized workspace path is unavailable."; }
      else {
        method = "filesystem";
        try {
          const targetPath = resolveSafe(ledger.executionContext.workspaceRoot, operation.targetPath);
          const exists = existsSync(targetPath);
          const expected = latest.tool === "delete_file" ? !exists : exists && statSync(targetPath).isFile();
          status = expected ? "passed" : "failed";
          reason = expected ? "Current workspace state matches the completed operation." : "Current workspace state does not match the completed operation.";
        } catch { status = "failed"; reason = "The target path could not be checked safely."; }
      }
    }
    checks.push(check({ criterionId: `workspace:${operation.id}`, requirement: operation.targetPath ?? "Execute the requested command", status, method, evidence, reason, mandatory: true }));
  }

  const acceptanceCriteria = [
    ...(contract.acceptance.validateWrittenCode ? [{ id: "validate-written-code", label: "Validate the latest written code" }] : []),
    ...contract.acceptance.validatedPythonDeliverables.map((filename) => ({ id: `validated-python:${filename}`, label: `Validate source ${filename}` })),
    ...(contract.acceptance.successMarker ? [{ id: "success-marker", label: `Emit validation marker ${contract.acceptance.successMarker}` }] : []),
    ...(contract.response.required ? [{ id: "response", label: "Provide a response to the user" }] : []),
  ];
  for (const criterion of acceptanceCriteria) {
    const accepted = options.contractEvaluatorPassed === true;
    const latest = attempts.filter((attempt) => ["run_command", "execute_python"].includes(attempt.tool)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const failed = latest?.status === "failed" ? latest : undefined;
    checks.push(check({ criterionId: `acceptance:${criterion.id}`, requirement: criterion.label, status: accepted ? "passed" : failed ? "failed" : "unverified",
      method: "agent_loop_completion", evidence: accepted ? attempts.filter((item) => item.status === "completed" && ["run_command", "execute_python"].includes(item.tool)).slice(-4).map((item) => ({ kind: "execution" as const, id: item.callId })) : failed ? [{ kind: "execution", id: failed.callId }] : [],
      reason: accepted ? "The existing AgentLoop RunContract completion evaluator accepted this criterion." : failed ? "The latest recorded validation operation failed." : "The existing completion evaluator has not recorded acceptance for this criterion.", mandatory: true }));
  }

  for (const [index, constraint] of contract.constraints.userConstraints.entries()) {
    checks.push(check({ criterionId: `constraint:${index + 1}`, requirement: constraint, status: "unverified", method: "agent_loop_completion", evidence: [],
      reason: "This free-text constraint needs semantic review. No deterministic check is defined for it.", mandatory: false }));
  }

  const extra = getDb().prepare("SELECT checks_json FROM run_artifact_validations WHERE run_id=?").get(runId) as { checks_json: string } | undefined;
  if (extra) {
    const saved=JSON.parse(extra.checks_json);const recorded=z.array(checkSchema).parse(Array.isArray(saved)?saved:saved.checks);
    const stale=Object.entries(saved.digests??{}).some(([id,digest])=>{const artifact=artifacts.find(a=>a.artifact_id===id);if(!artifact)return true;try{return sha256File(absoluteDataPath(artifact.relative_path))!==digest;}catch{return true;}});
    checks.push(...recorded.map(check=>stale&&check.status==="passed"?{...check,status:"unverified" as const,reason:"The saved output changed after its content checks. Recheck this requirement."}:check));
  }
  const applicable = checks.filter((item) => item.status !== "not_applicable");
  const status: VerificationStatus = applicable.some((item) => item.mandatory && item.status === "failed") ? "failed"
    : applicable.some((item) => item.status === "unverified" || item.status === "failed") ? "unverified" : applicable.length ? "passed" : "not_applicable";
  return persist({ schemaVersion: 1, runId, status, checks, updatedAt: timestamp });
}

export function verificationFeedback(report: RunVerificationReport | undefined): { key: string; text: string } | undefined {
  if (!report) return undefined;
  const actionable = report.checks.filter((item) => item.mandatory && (item.status === "failed" || item.status === "unverified")).slice(0, 3);
  if (!actionable.length) return undefined;
  const key = actionable.map((item) => `${item.criterionId}:${item.status}:${item.reason}`).join("|");
  return { key, text: actionable.map((item) => `${item.status}: ${item.requirement} — ${item.reason}`).join("; ").slice(0, 600) };
}
