import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { setDataDir, absoluteDataPath, createRunDirectories, writeRunFile, artifactRef } from "../src/main/run/filesystem.js";
import { normalizeRunContract, persistRunContract } from "../src/main/run/contract.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { initializeExecutionLedger, recordExecutionToolOutcome } from "../src/main/run/execution-ledger.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { getVerificationReport, verifyRunEvidence } from "../src/main/run/verification.js";
import { RunManager } from "../src/main/run/manager.js";
import { getState } from "../src/main/run/store.js";

describe("P1-D durable outcome verification", () => {
  let dir: string;
  let runId: string;
  let contract: ReturnType<typeof normalizeRunContract>;

  const makeIntent = (overrides: Record<string, unknown> = {}) => validateAndNormalizeIntent({
    intentType: "document_drafting", primaryGoal: "Create report", driverModel: "draft-qwen3", taskType: "draft", isActionable: true,
    chatResponseOnly: false, workspaceMutationRequested: false, targetFiles: [], protectedPaths: [], restrictMutationsToTargets: false,
    expectedDeliverables: [{ filename: "report.md", filenameRequired: true, type: "md" }], ...overrides,
  } as any, { hasWorkspace: false, workspaceFiles: [], userPrompt: "Create report" });
  const createContract = (intent = makeIntent()) => {
    runId = createRun(createChat(), "Create report");
    contract = persistRunContract(normalizeRunContract(runId, intent));
    initializeExecutionLedger(contract);
  };
  const registerMarkdown = (text = "# Report\n") => {
    createRunDirectories(runId);
    const relativePath = writeRunFile(runId, "output", "report.md", text);
    const artifact = artifactRef(runId, "md", "report.md", relativePath);
    getDb().prepare("INSERT INTO artifacts(artifact_id,run_id,kind,filename,relative_path,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(artifact.artifactId, runId, artifact.kind, artifact.filename, artifact.relativePath, artifact.sizeBytes, artifact.sha256, artifact.createdAt);
    return artifact;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "p1d-verification-"));
    setDataDir(dir);
    initDb(path.join(dir, "workbench.sqlite"));
    createContract();
  });
  afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("checks a matching artifact digest and supported structure", () => {
    const artifact = registerMarkdown();
    const report = verifyRunEvidence(runId)!;
    expect(report.checks.find((item) => item.criterionId === `artifact-integrity:${artifact.artifactId}`)?.status).toBe("passed");
    expect(report.checks.find((item) => item.criterionId === `artifact-format:${artifact.artifactId}`)?.status).toBe("passed");
    expect(report.checks.find((item) => item.criterionId === "deliverable:deliverable-1")?.status).toBe("passed");
  });

  it("flags missing or changed artifact files as failed", () => {
    const artifact = registerMarkdown();
    writeFileSync(absoluteDataPath(artifact.relativePath), "# Changed\n");
    let report = verifyRunEvidence(runId)!;
    expect(report.checks.find((item) => item.criterionId === `artifact-integrity:${artifact.artifactId}`)?.status).toBe("failed");
    writeFileSync(absoluteDataPath(artifact.relativePath), "");
    report = verifyRunEvidence(runId)!;
    expect(report.checks.find((item) => item.criterionId === `artifact-format:${artifact.artifactId}`)?.status).toBe("failed");
    unlinkSync(absoluteDataPath(artifact.relativePath));
    report = verifyRunEvidence(runId)!;
    expect(report.checks.find((item) => item.criterionId === `artifact-integrity:${artifact.artifactId}`)?.status).toBe("failed");
  });

  it("rechecks prior evidence on a later checkpoint", () => {
    const artifact = registerMarkdown();
    expect(verifyRunEvidence(runId)!.status).not.toBe("failed");
    writeFileSync(absoluteDataPath(artifact.relativePath), "tampered");
    expect(verifyRunEvidence(runId)!.checks.find((item) => item.criterionId === `artifact-integrity:${artifact.artifactId}`)?.status).toBe("failed");
  });

  it("reports legacy artifacts without hashes as unverified", () => {
    const artifact = registerMarkdown();
    getDb().prepare("UPDATE artifacts SET sha256=NULL WHERE artifact_id=?").run(artifact.artifactId);
    const report = verifyRunEvidence(runId)!;
    const integrity = report.checks.find((item) => item.criterionId === `artifact-integrity:${artifact.artifactId}`)!;
    expect(integrity.status).toBe("unverified");
    expect(integrity.reason).toContain("Legacy artifact");
  });

  it("does not accept a successful generation call without the required deliverable", () => {
    recordExecutionToolOutcome({ runId, callId: "generation-1", tool: "generate_deliverable", args: { filename: "report.md", type: "md" }, summary: "Generated report", ok: true });
    const report = verifyRunEvidence(runId)!;
    expect(report.checks.find((item) => item.criterionId === "deliverable:deliverable-1")?.status).toBe("failed");
  });

  it("keeps a failed mandatory deterministic check partial", () => {
    recordExecutionToolOutcome({ runId, callId: "generation-gate", tool: "generate_deliverable", args: { filename: "report.md", type: "md" }, summary: "Generated report", ok: true });
    const manager = new RunManager({} as any);
    (manager as any).complete(runId, true);
    expect(getState(runId)).toBe("partial");
  });

  it("records explicit validation failures and leaves semantic constraints unverified", () => {
    const intent = makeIntent({ intentType: "code_modification", primaryGoal: "Update module", workspaceMutationRequested: true,
      targetFiles: ["module.py"], workspaceOperations: [{ operation: "mutate", targetPath: "module.py" }], expectedDeliverables: [], validationRequested: true,
      userConstraints: ["Preserve the public API"] });
    const nextRun = createRun(createChat(), "Update module");
    const nextContract = persistRunContract(normalizeRunContract(nextRun, intent));
    initializeExecutionLedger(nextContract);
    recordExecutionToolOutcome({ runId: nextRun, callId: "validation-1", tool: "run_command", args: { command: "pytest" }, summary: "Validation failed", ok: false, error: "assertion failed" });
    const report = verifyRunEvidence(nextRun)!;
    expect(report.checks.find((item) => item.criterionId === "acceptance:validate-written-code")?.status).toBe("failed");
    expect(report.checks.find((item) => item.criterionId === "constraint:1")?.status).toBe("unverified");
  });

  it("reconstructs the verification report after database restart", () => {
    registerMarkdown();
    const report = verifyRunEvidence(runId)!;
    closeDb();
    initDb(path.join(dir, "workbench.sqlite"));
    expect(getVerificationReport(runId)).toEqual(report);
  });

  it("checks ResultStore digests without copying payloads into the report", () => {
    const callId = randomUUID();
    const result = new RunResultStore(runId).registerResult({ type: "text", status: "complete", origin: "source_extracted", producer: { tool: "read_file", callId }, summary: "Source", payload: "durable evidence" });
    recordExecutionToolOutcome({ runId, callId, tool: "read_file", args: { path: "source.txt" }, summary: "Read source", ok: true, resultId: result.resultId });
    const payload = absoluteDataPath(`runs/${runId}/${result.storage.relativePath}`);
    writeFileSync(payload, "tampered");
    const report = verifyRunEvidence(runId)!;
    const check = report.checks.find((item) => item.criterionId === `result-integrity:${result.resultId}`)!;
    expect(check.status).toBe("failed");
    expect(check.evidence).toEqual([{ kind: "result", id: result.resultId }]);
    expect(JSON.stringify(report)).not.toContain("durable evidence");
  });

  it("bypasses report persistence for simple Chat", () => {
    const chatRun = createRun(createChat(), "hi");
    const chatIntent = { ...makeIntent(), intentType: "pure_chat", primaryGoal: "Chat", isActionable: false, chatResponseOnly: true, expectedDeliverables: [] } as any;
    const chatContract = persistRunContract(normalizeRunContract(chatRun, chatIntent));
    expect(verifyRunEvidence(chatRun)).toBeUndefined();
    expect(getVerificationReport(chatRun)).toBeUndefined();
  });

  it("retains the RunContract and does not change an existing run state", () => {
    const before = contract;
    registerMarkdown();
    verifyRunEvidence(runId);
    const row = getDb().prepare("SELECT contract_json FROM run_contracts WHERE run_id=?").get(runId) as { contract_json: string };
    expect(JSON.parse(row.contract_json)).toEqual(before);
  });

  it("does not let an unsupported optional semantic constraint block completion", () => {
    const intent = makeIntent({ userConstraints: ["Keep the report easy to read"] });
    const nextRun = createRun(createChat(), "Create report");
    const nextContract = persistRunContract(normalizeRunContract(nextRun, intent));
    initializeExecutionLedger(nextContract);
    registerMarkdownFor(nextRun);
    const manager = new RunManager({} as any);
    (manager as any).complete(nextRun, true);
    expect(getState(nextRun)).toBe("completed");
    expect(getVerificationReport(nextRun)?.checks.find((item) => item.criterionId === "constraint:1")?.status).toBe("unverified");
  });

  function registerMarkdownFor(targetRunId: string) {
    createRunDirectories(targetRunId);
    const relativePath = writeRunFile(targetRunId, "output", "report.md", "# Report\n");
    const artifact = artifactRef(targetRunId, "md", "report.md", relativePath);
    getDb().prepare("INSERT INTO artifacts(artifact_id,run_id,kind,filename,relative_path,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(artifact.artifactId, targetRunId, artifact.kind, artifact.filename, artifact.relativePath, artifact.sizeBytes, artifact.sha256, artifact.createdAt);
  }
});
