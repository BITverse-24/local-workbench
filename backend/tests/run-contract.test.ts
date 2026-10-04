import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChat } from "../src/main/persistence/chats.js";
import { initDb, closeDb, getDb } from "../src/main/persistence/db.js";
import { createRun } from "../src/main/run/store.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { normalizeRunContract, persistRunContract, getRunContract, outputExpectationFromContract, evaluateRunContractCompletion, matchesContractDeliverable, type CompletionEvidence } from "../src/main/run/contract.js";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";

describe("P1 canonical run contract", () => {
  let dir: string, runId: string;
  const raw = { intentType: "code_modification", primaryGoal: "Repair the parser", driverModel: "code-qwen25coder", taskType: "code", isActionable: true, chatResponseOnly: false, workspaceMutationRequested: true, targetFiles: ["parser.py"], protectedPaths: ["config.json"], restrictMutationsToTargets: true, expectedDeliverables: [] };
  const intent = (patch = {}) => validateAndNormalizeIntent({ ...raw, ...patch }, { hasWorkspace: true, workspaceFiles: ["parser.py", "config.json"], userPrompt: "This raw prompt must never be copied into a contract" });
  const evidence = (patch: Partial<CompletionEvidence> = {}): CompletionEvidence => ({ artifacts: new Set(), written: new Set(), deleted: new Set(), commandExecuted: false, writtenValidationPassed: false, validatedPythonArtifacts: new Set(), responseText: "Done", hadErrors: false, ...patch });
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "p1-contract-")); initDb(path.join(dir, "db.sqlite")); runId = createRun(createChat(), "existing request"); });
  afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("persists one versioned normalized contract without duplicating raw prompt content", () => {
    const contract = persistRunContract(normalizeRunContract(runId, intent({ validationRequested: true, userConstraints: ["Preserve existing interfaces"] })));
    expect(contract.schemaVersion).toBe(1);
    expect(contract.objective).toBe("Repair the parser");
    expect(contract.acceptance.validateWrittenCode).toBe(true);
    expect(JSON.stringify(contract)).not.toContain("raw prompt");
    expect(getRunContract(runId)).toEqual(contract);
    expect(() => persistRunContract(contract)).toThrow();
    closeDb(); initDb(path.join(dir, "db.sqlite"));
    expect(getRunContract(runId)).toEqual(contract);
  });
  it("separates workspace documents from exported artifacts and ignores contradictory compatibility output expectations", () => {
    const resolved = intent({ intentType: "document_drafting", targetFiles: ["notes.md", "plan.docx"], expectedDeliverables: [{ filename: "notes.md", type: "md" }, { filename: "plan.docx", type: "docx" }, { filename: "report.docx", type: "docx" }] });
    resolved.outputExpectation = { chatResponse: true, expectedFiles: ["wrong.xlsx"], workspaceMutationRequested: false };
    const contract = normalizeRunContract(runId, resolved);
    const output = outputExpectationFromContract(contract);
    expect(output.targetFiles).toEqual(["notes.md", "plan.docx"]);
    expect(output.expectedFiles).toEqual(["report.docx"]);
    expect(evaluateRunContractCompletion(contract, evidence({ written: new Set(["notes.md", "plan.docx"]), artifacts: new Set(["report.docx"]) })).outcome).toBe("completed");
  });
  it("does not accept an artifact as a workspace change or reuse one file for two requested outputs", () => {
    const contract = normalizeRunContract(runId, intent({ expectedDeliverables: [{ type: "xlsx", description: "clean workbook" }, { type: "xlsx", description: "reconciliation workbook" }] }));
    const result = evaluateRunContractCompletion(contract, evidence({ artifacts: new Set(["parser.py", "clean.xlsx"]) }));
    expect(result.missingMutations).toEqual(["parser.py"]);
    expect(result.missingDeliverables).toEqual(["reconciliation workbook"]);
    expect(result.outcome).toBe("partial");
  });
  it("accepts a verified deliverable with a generated name when no exact filename was requested", () => {
    const contract = normalizeRunContract(runId, intent({ intentType: "document_drafting", workspaceMutationRequested: false, targetFiles: [], expectedDeliverables: [{ type: "docx", description: "Requested Word document" }] }));
    expect(contract.deliverables[0].filename).toBeUndefined();
    expect(evaluateRunContractCompletion(contract, evidence({ artifacts: new Set(["inspection-summary.docx"]) })).outcome).toBe("completed");
    expect(evaluateRunContractCompletion(contract, evidence({ artifacts: new Set(["inspection-summary.xlsx"]) })).outcome).toBe("partial");
  });
  it("requires the exact explicitly requested filename while permitting separate outputs", () => {
    const explicit = normalizeRunContract(runId, intent({ intentType: "document_drafting", workspaceMutationRequested: false, targetFiles: [], expectedDeliverables: [{ filename: "approval.docx", filenameRequired: true, type: "docx" }] }));
    expect(matchesContractDeliverable(explicit, "approval-final.docx", "docx")).toBe(false);
    expect(matchesContractDeliverable(explicit, "approval.docx", "docx")).toBe(true);
    expect(evaluateRunContractCompletion(explicit, evidence({ artifacts: new Set(["approval-final.docx"]) })).missingDeliverables).toEqual(["approval.docx"]);
    expect(evaluateRunContractCompletion(explicit, evidence({ artifacts: new Set(["approval.docx"]) })).outcome).toBe("completed");
    const multiple = normalizeRunContract(runId, intent({ intentType: "document_drafting", workspaceMutationRequested: false, targetFiles: [], expectedDeliverables: [{ type: "docx" }, { type: "xlsx" }] }));
    expect(matchesContractDeliverable(multiple, "note.docx", "docx")).toBe(true);
    expect(evaluateRunContractCompletion(multiple, evidence({ artifacts: new Set(["note.docx", "table.xlsx"]) })).outcome).toBe("completed");
    expect(evaluateRunContractCompletion(multiple, evidence({ artifacts: new Set(["note.docx"]) })).missingDeliverables).toHaveLength(1);
  });
  it("matches exact workspace paths and distinguishes writes, deletes and successful commands", () => {
    const contract = normalizeRunContract(runId, intent({ targetFiles: ["src/parser.py"], workspaceOperations: [{ operation: "delete", targetPath: "src/parser.py" }, { operation: "execute" }] }));
    expect(evaluateRunContractCompletion(contract, evidence({ deleted: new Set(["other/parser.py"]) })).missingMutations).toHaveLength(2);
    expect(evaluateRunContractCompletion(contract, evidence({ deleted: new Set(["src/parser.py"]), commandExecuted: true })).outcome).toBe("completed");
  });
  it("requires declared verification even when the target exists and exposes the same requirement after reload", () => {
    const contract = persistRunContract(normalizeRunContract(runId, intent({ validationRequested: true, successMarker: "CHECK_OK" })));
    const pending = evaluateRunContractCompletion(getRunContract(runId)!, evidence({ written: new Set(["parser.py"]) }));
    expect(pending.outcome).toBe("partial");
    expect(pending.missingAcceptance).toContain("validation against the latest written code");
    expect(evaluateRunContractCompletion(contract, evidence({ written: new Set(["parser.py"]), writtenValidationPassed: true })).outcome).toBe("completed");
  });
  it("preserves chat-only and ambiguous scope without granting execution authority", () => {
    const contract = normalizeRunContract(runId, intent({ chatResponseOnly: true, expectedDeliverables: [{ filename: "out.xlsx", type: "xlsx" }] }));
    expect(contract.workspace.operations).toEqual([]);
    expect(contract.deliverables).toEqual([]);
    const ambiguous = normalizeRunContract(runId, intent({ ambiguityDetails: "Which file should be updated?" }));
    expect(ambiguous.workspace.operations).toEqual([]);
    const guard = new MutationPolicyGuard({ strict: true });
    persistRunContract(normalizeRunContract(runId, intent()));
    expect(guard.isAuthorized(runId, "write_file", { path: "parser.py" })).toBe(false);
  });
  it("rejects unknown persisted schema versions and escaping paths", () => {
    persistRunContract(normalizeRunContract(runId, intent()));
    getDb().prepare("UPDATE run_contracts SET schema_version=99 WHERE run_id=?").run(runId);
    expect(() => getRunContract(runId)).toThrow("Unsupported");
    expect(() => normalizeRunContract(runId, { ...intent(), targetFiles: ["/outside.py"] })).toThrow("absolute");
  });

  describe("successMarker contract normalization regressions", () => {
    it("normalizes missing marker to undefined", () => {
      const contract = normalizeRunContract(runId, intent({ successMarker: undefined }));
      expect(contract.acceptance.successMarker).toBeUndefined();
      const persisted = persistRunContract(contract);
      expect(persisted.acceptance.successMarker).toBeUndefined();
    });

    it("normalizes empty marker to undefined without too_small error", () => {
      const contract = normalizeRunContract(runId, intent({ successMarker: "" }));
      expect(contract.acceptance.successMarker).toBeUndefined();
      const persisted = persistRunContract(contract);
      expect(persisted.acceptance.successMarker).toBeUndefined();
    });

    it("normalizes whitespace-only marker to undefined", () => {
      const contract = normalizeRunContract(runId, intent({ successMarker: "   \t\n  " }));
      expect(contract.acceptance.successMarker).toBeUndefined();
      const persisted = persistRunContract(contract);
      expect(persisted.acceptance.successMarker).toBeUndefined();
    });

    it("preserves valid markers and trims surrounding whitespace", () => {
      const contract = normalizeRunContract(runId, intent({ successMarker: "  ALL_TESTS_PASS  " }));
      expect(contract.acceptance.successMarker).toBe("ALL_TESTS_PASS");
      const persisted = persistRunContract(contract);
      expect(persisted.acceptance.successMarker).toBe("ALL_TESTS_PASS");
    });

    it("rejects oversized markers (>128 chars)", () => {
      const oversized = "X".repeat(129);
      expect(() => {
        validateAndNormalizeIntent({ ...raw, successMarker: oversized }, {
          hasWorkspace: true,
          workspaceFiles: ["parser.py"],
          userPrompt: "test",
        });
      }).not.toThrow(); // Raw parse fails gracefully in validateAndNormalizeIntent returning status: "failed"

      const failedIntent = validateAndNormalizeIntent({ ...raw, successMarker: oversized }, {
        hasWorkspace: true,
        workspaceFiles: ["parser.py"],
        userPrompt: "test",
      });
      expect(failedIntent.status).toBe("failed");

      // Direct schema rejection on oversized marker:
      expect(() => {
        normalizeRunContract(runId, { ...intent(), successMarker: oversized });
      }).toThrow();
    });

    it("allows ordinary chat intent with empty successMarker to reach agent contract cleanly", () => {
      const chatRaw = {
        intentType: "pure_chat",
        taskType: "draft",
        driverModel: "draft-qwen3",
        primaryGoal: "Explain Bourdon tube safety",
        isActionable: false,
        chatResponseOnly: true,
        workspaceMutationRequested: false,
        restrictMutationsToTargets: false,
        targetFiles: [],
        protectedPaths: [],
        expectedDeliverables: [],
        ambiguityDetails: null,
        responseRequired: true,
        validationRequested: false,
        successMarker: "",
        userConstraints: [],
        workspaceOperations: [],
      };
      const chatIntent = validateAndNormalizeIntent(chatRaw, {
        hasWorkspace: false,
        workspaceFiles: [],
        userPrompt: "Explain Bourdon tube safety",
      });
      expect(chatIntent.status).toBe("resolved");
      expect(chatIntent.successMarker).toBeUndefined();
      const contract = normalizeRunContract(runId, chatIntent);
      expect(contract.acceptance.successMarker).toBeUndefined();
      expect(contract.response.chatOnly).toBe(true);
      const persisted = persistRunContract(contract);
      expect(persisted.acceptance.successMarker).toBeUndefined();
    });
  });
});
