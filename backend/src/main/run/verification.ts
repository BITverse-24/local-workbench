import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RunContract, RunVerificationReport, VerificationCheck, VerificationStatus } from "../../shared/contracts.js";
import { getDb } from "../persistence/db.js";
import { matchesContractDeliverable, getRunContract, normalizeContractPath } from "./contract.js";
import { absoluteDataPath, runRoot, sha256File } from "./filesystem.js";
import { getExecutionLedger, verificationCheckSchema, verificationTerminationSchema } from "./execution-ledger.js";
import { RunResultStore } from "./result-store.js";
import { resolveSafe } from "../harness/path-guard.js";
import { captureAgentVerificationManifest } from "../agent/test-verification.js";

const checkSchema = verificationCheckSchema;
const reportSchema = z.object({ schemaVersion: z.literal(1), runId: z.string().uuid(), status: z.enum(["passed", "failed", "unverified", "not_applicable", "skipped"]), checks: z.array(checkSchema).max(2000), updatedAt: z.string().datetime(), termination: verificationTerminationSchema.optional(), attempts: z.object({ verification: z.number().int().nonnegative(), repairs: z.number().int().nonnegative(), modelCalls: z.number().int().nonnegative(), recoveries: z.number().int().nonnegative() }).optional() });
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
  const current = getExecutionLedger(runId)?.verification;
  return current ? { ...report, termination: current.termination,
    status: current.termination && report.status === "passed" ? "unverified" : report.status } : report;
}

/** Deterministic checks over durable evidence. Semantic criteria remain unverified unless P0's evaluator accepted them. */
export function verifyRunEvidence(runId: string, _legacyOptions: { contractEvaluatorPassed?: boolean } = {}): RunVerificationReport | undefined {
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
          if (expected && operation.sourceId) {
            method = "sha256";
            status = operation.sourceSha256 && sha256File(targetPath) === operation.sourceSha256 ? "passed" : "failed";
            reason = status === "passed" ? "Workspace file bytes match the approved source snapshot." : "Workspace file bytes do not match the approved source snapshot.";
          }
        } catch { status = "failed"; reason = "The target path could not be checked safely."; }
      }
    }
    checks.push(check({ criterionId: `workspace:${operation.id}`, requirement: operation.targetPath ?? "Execute the requested command", status, method, evidence, reason, mandatory: true }));
  }

  const acceptanceCriteria = [
    ...((contract.acceptance.validateWrittenCode || ledger?.verification?.evidence.some(item => item.criterionId === "acceptance:validate-written-code") || ledger?.verification?.userSkip) ? [{ id: "validate-written-code", label: "Validate the latest written code" }] : []),
    ...contract.acceptance.validatedPythonDeliverables.map((filename) => ({ id: `validated-python:${filename}`, label: `Validate source ${filename}` })),
    ...(contract.acceptance.successMarker ? [{ id: "success-marker", label: `Emit validation marker ${contract.acceptance.successMarker}` }] : []),
    ...(contract.response.required ? [{ id: "response", label: "Provide a response to the user" }] : []),
  ];
  for (const criterion of acceptanceCriteria) {
    const criterionId = `acceptance:${criterion.id}`;
    if (criterion.id === "response") {
      const message = db.prepare("SELECT id,content FROM messages WHERE run_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(runId) as { id: string; content: string } | undefined;
      checks.push(check({ criterionId, requirement: criterion.label, status: message?.content.trim() ? "passed" : "unverified", method: "message_record", evidence: message?.content.trim() ? [{ kind: "message", id: message.id }] : [], reason: message?.content.trim() ? "The final assistant response is saved in this run." : "No final assistant response has been saved for this run.", mandatory: true }));
      continue;
    }
    if (criterion.id === "validate-written-code" && ledger?.verification?.userSkip) {
      checks.push(check({ criterionId, requirement: criterion.label, status: "skipped", method: "execution_record", evidence: [], reason: "Tests were skipped at the user's explicit request. No test pass is claimed.", mandatory: true, waiver: ledger.verification.userSkip }));
      continue;
    }
    if (criterion.id === "success-marker") {
      const approved = checks.filter(item => item.status === "passed" && (item.criterionId === "acceptance:validate-written-code" || item.criterionId.startsWith("acceptance:validated-python:")));
      const matching = approved.flatMap(item => item.evidence).find(ref => {
        if (ref.kind !== "result") return false;
        try {
          if (!resultStore.verifyIntegrity(ref.id).valid || resultStore.getResult(ref.id).origin !== "execution") return false;
          try {
            if (resultStore.retrieveResultSlice(ref.id, { mode: "json", pointer: "/verification/successMarker", maxChars: 256 }).content === contract.acceptance.successMarker &&
                resultStore.retrieveResultSlice(ref.id, { mode: "json", pointer: "/verification/successMarkerObserved", maxChars: 16 }).content === "true") return true;
          } catch { /* Python and legacy executions retain their stdout evidence. */ }
          const output = resultStore.retrieveResultSlice(ref.id, { mode: "json", pointer: "/stdout", maxChars: 3000 });
          return output.content.split(/\r?\n/).some(line => line.trim() === contract.acceptance.successMarker);
        } catch { return false; }
      });
      checks.push(check({ criterionId, requirement: criterion.label, status: matching ? "passed" : "unverified", method: "execution_record", evidence: matching ? [matching] : [], reason: matching ? "The validated execution printed the requested marker." : "No accepted current execution proves the requested marker.", mandatory: true }));
      continue;
    }
    const saved = ledger?.verification?.evidence.find(item => item.criterionId === criterionId);
    let status: VerificationStatus = "unverified", reason = "No criterion-specific execution evidence is recorded.", evidence: VerificationCheck["evidence"] = [];
    let method: VerificationCheck["method"] = "execution_record";
    if (saved && saved.status !== "skipped") {
      status = saved.status; reason = saved.reason; evidence = saved.evidence; method = saved.method;
      const resultRefs = saved.evidence.filter(ref => ref.kind === "result");
      const validRefs = resultRefs.length > 0 && resultRefs.every(ref => resultStore.verifyIntegrity(ref.id).valid) && resultRefs.some(ref => {
        try { const record = resultStore.getResult(ref.id); return record.origin === "execution" && (record.status === "complete" || saved.status === "failed"); } catch { return false; }
      });
      const artifactRefsValid = saved.evidence.filter(ref => ref.kind === "artifact").every(ref => {
        const artifact = artifacts.find(item => item.artifact_id === ref.id);
        if (!artifact?.sha256) return false;
        try { return sha256File(outputArtifactPath(runId, artifact.relative_path)) === artifact.sha256; } catch { return false; }
      });
      const manifest = Object.entries(saved.sourceManifest ?? {});
      const manifestValid = manifest.every(([filename, digest]) => {
        if (!ledger?.executionContext?.workspaceRoot) return false;
        try { const file = resolveSafe(ledger.executionContext.workspaceRoot, normalizeContractPath(filename)); return digest === null ? !existsSync(file) : existsSync(file) && statSync(file).isFile() && sha256File(file) === digest; } catch { return false; }
      });
      let typedExecutionValid = true;
      if (criterion.id === "validate-written-code") {
        const executions = resultRefs.filter(ref => { try { return resultStore.getResult(ref.id).origin === "execution"; } catch { return false; } });
        typedExecutionValid = executions.length > 0 && executions.every(ref => {
          try {
            const record = resultStore.getResult(ref.id);
            const payload = JSON.parse(readFileSync(resolveSafe(runRoot(runId), record.storage.relativePath), "utf8"));
            const report = payload.verification;
            const registered = ledger?.verification?.plans.find(plan => plan.id === report?.planId && plan.revision === report?.manifestSha256 && plan.kind === "agent_tests");
            return registered && Boolean(registered.command && registered.runner) && report.command === registered.command && report.runner === registered.runner && report.manifestSha256 === saved.revision && typeof payload.exitCode === "number" && Number.isInteger(payload.exitCode) && payload.timedOut === false && typeof report.executed === "number" && Number.isInteger(report.executed) && report.executed > 0 && typeof report.failed === "number" && Number.isInteger(report.failed) && report.failed >= 0 && (saved.status === "passed" ? payload.exitCode === 0 && report.failed === 0 && !report.reason : true);
          } catch { return false; }
        });
      }
      let pythonRevisionValid = true;
      if (criterion.id.startsWith("validated-python:")) {
        const filename = criterion.id.slice("validated-python:".length);
        const artifact = artifacts.find(item => item.filename === filename);
        pythonRevisionValid = Boolean(artifact?.sha256 && resultRefs.some(ref => {
          try {
            const record = resultStore.getResult(ref.id);
            return record.origin === "execution" && resultStore.retrieveResultSlice(ref.id, { mode: "json", pointer: "/sourceDigest", maxChars: 100 }).content === artifact.sha256;
          } catch { return false; }
        }));
      }
      let fullManifestValid = criterion.id !== "validate-written-code";
      if (!fullManifestValid && ledger?.executionContext?.workspaceRoot && saved.revision) {
        try { fullManifestValid = captureAgentVerificationManifest(ledger.executionContext.workspaceRoot).sha256 === saved.revision; } catch { fullManifestValid = false; }
      }
      const currentRevision = typedExecutionValid && pythonRevisionValid && (criterion.id !== "validate-written-code" || Boolean(saved.revision && saved.planId && manifest.length && manifestValid && fullManifestValid));
      if ((saved.status === "passed" || saved.status === "failed") && (!validRefs || !artifactRefsValid || !manifestValid || !currentRevision)) {
        status = "unverified"; reason = "Execution evidence is missing, changed, or does not identify the current source revision.";
      }
    }
    checks.push(check({ criterionId, requirement: criterion.label, status, method, evidence, reason, mandatory: true, revision: saved?.revision, planId: saved?.planId, sourceManifest: saved?.sourceManifest }));
  }

  for (const [index, constraint] of contract.constraints.userConstraints.entries()) {
    checks.push(check({ criterionId: `constraint:${index + 1}`, requirement: constraint, status: "unverified", method: "agent_loop_completion", evidence: [],
      reason: "This free-text constraint needs semantic review. No deterministic check is defined for it.", mandatory: false }));
  }

  let workReviewAttempts = 0;
  const extra = getDb().prepare("SELECT checks_json FROM run_artifact_validations WHERE run_id=?").get(runId) as { checks_json: string } | undefined;
  if (extra) {
    const saved=JSON.parse(extra.checks_json);workReviewAttempts=Number(saved.review?.totalAttempts)||0;const recorded=z.array(checkSchema).parse(Array.isArray(saved)?saved:saved.checks);
    const stale=Object.entries(saved.digests??{}).some(([id,digest])=>{const artifact=artifacts.find(a=>a.artifact_id===id);if(!artifact)return true;try{return sha256File(absoluteDataPath(artifact.relative_path))!==digest;}catch{return true;}});
    checks.push(...recorded.map(check=>stale&&["passed","failed"].includes(check.status)?{...check,status:"unverified" as const,reason:"The saved output changed after its content checks. Recheck this requirement."}:check));
  }
  for (const requirement of contract.acceptance.artifactChecks ?? []) {
    const criterionId = `content:${requirement.id}`;
    if (!checks.some(item => item.criterionId === criterionId)) checks.push(check({ criterionId, requirement: requirement.basis.slice(0, 500), status: "unverified", method: "content_check", evidence: [], reason: "No saved content assessment exists for this required criterion.", mandatory: requirement.mandatory }));
  }
  const applicable = checks.filter((item) => item.status !== "not_applicable");
  const status: VerificationStatus = applicable.some((item) => item.mandatory && item.status === "failed") ? "failed"
    : applicable.some((item) => item.status === "unverified" || item.status === "failed") ? "unverified" : applicable.some(item => item.status === "skipped") ? "skipped" : applicable.length ? "passed" : "not_applicable";
  const mode = db.prepare("SELECT metrics_json FROM run_mode_details WHERE run_id=?").get(runId) as { metrics_json: string } | undefined;
  let metrics: Record<string, unknown> = {};
  try { metrics = JSON.parse(mode?.metrics_json ?? "{}"); } catch { /* Older optional metrics do not establish acceptance. */ }
  const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  return persist({ schemaVersion: 1, runId, status, checks, updatedAt: timestamp, termination: ledger?.verification?.termination,
    attempts: { verification: (ledger?.verification?.attempts.length ?? 0) + Math.max(count(metrics.verificationAttemptCount), count(workReviewAttempts)), repairs: ledger?.verification?.repairCount ?? 0, modelCalls: count(metrics.modelCallCount), recoveries: count(metrics.recoveryCount) } });
}

export function verificationFeedback(report: RunVerificationReport | undefined): { key: string; text: string } | undefined {
  if (!report) return undefined;
  const actionable = report.checks.filter((item) => item.mandatory && (item.status === "failed" || item.status === "unverified")).slice(0, 3);
  if (!actionable.length) return undefined;
  const key = actionable.map((item) => `${item.criterionId}:${item.status}:${item.reason}`).join("|");
  return { key, text: actionable.map((item) => `${item.status}: ${item.requirement} — ${item.reason}`).join("; ").slice(0, 600) };
}
