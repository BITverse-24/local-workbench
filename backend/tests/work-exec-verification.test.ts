import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDb, closeDb, getDb } from "../src/main/persistence/db.js";
import { setDataDir, createRunDirectories, writeRunFile, artifactRef, runRoot } from "../src/main/run/filesystem.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { persistRunContract } from "../src/main/run/contract.js";
import { validateWorkArtifacts } from "../src/main/run/work-orchestrator.js";
import { runScriptVerification } from "../src/main/run/work-exec/work-sandbox.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";
import type { RunContract, ArtifactAcceptanceCheck } from "../src/shared/contracts.js";

describe("Work Mode Code Mode: Script Verification", () => {
  let tempDir: string;
  let runId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "work-verify-test-"));
    setDataDir(tempDir);
    initDb(path.join(tempDir, "db.sqlite"));
    const chatId = createChat();
    runId = createRun(chatId, "Verification run");
    createRunDirectories(runId);
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("evaluates passing deterministic assertion scripts", async () => {
    const mockArtifact = {
      filename: "report.csv",
      text: "Item,Quantity,UnitCost,Total\nWidget A,10,5,50\nWidget B,20,2.5,50\n",
      headings: [],
      sheets: ["Sheet1"],
      columns: [["Item", "Quantity", "UnitCost", "Total"]],
      rows: [
        ["Item", "Quantity", "UnitCost", "Total"],
        ["Widget A", 10, 5, 50],
        ["Widget B", 20, 2.5, 50],
      ],
      rowCount: 2,
      formulas: 0,
    };

    const script = `
      assert(artifact.rowCount === 2, "Row count must be 2");
      const rows = artifact.rows.slice(1);
      let grandTotal = 0;
      for (const row of rows) {
        const qty = Number(row[1]);
        const cost = Number(row[2]);
        const total = Number(row[3]);
        assertEqual(qty * cost, total, "Row total must equal qty * cost");
        grandTotal += total;
      }
      assertApprox(grandTotal, 100, 0.01, "Grand total must be 100");
    `;

    const res = await runScriptVerification(script, mockArtifact);
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("reports precise failure messages when script assertion fails", async () => {
    const mockArtifact = {
      filename: "report.csv",
      text: "Item,Total\nWidget A,40\n",
      headings: [],
      sheets: [],
      columns: [["Item", "Total"]],
      rows: [
        ["Item", "Total"],
        ["Widget A", 40],
      ],
      rowCount: 1,
      formulas: 0,
    };

    const script = `
      const total = Number(artifact.rows[1][1]);
      assertEqual(total, 50, "Widget total mismatch");
    `;

    const res = await runScriptVerification(script, mockArtifact);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Widget total mismatch");
    expect(res.error).toContain("Expected 50, received 40");
  });

  it("integrates kind: 'script' in validateWorkArtifacts without model calls", async () => {
    const csvContent = "Product,Price,Quantity,Subtotal\nItem 1,10,2,20\nItem 2,15,3,45\n";
    const artifact = artifactRef(runId, "csv", "output.csv", writeRunFile(runId, "output", "output.csv", csvContent));
    getDb()
      .prepare(
        "INSERT INTO artifacts(artifact_id,run_id,kind,filename,relative_path,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        artifact.artifactId,
        runId,
        artifact.kind,
        artifact.filename,
        artifact.relativePath,
        artifact.sizeBytes,
        artifact.sha256,
        artifact.createdAt,
      );

    const scriptCheck: ArtifactAcceptanceCheck = {
      id: "check-math",
      kind: "script",
      filename: "output.csv",
      expected: "Subtotal math matches",
      script: `
        const rows = artifact.rows.slice(1);
        for (const row of rows) {
          const price = Number(row[1]);
          const qty = Number(row[2]);
          const subtotal = Number(row[3]);
          assertEqual(price * qty, subtotal, "Subtotal check");
        }
      `,
      mandatory: true,
      basis: "Verify price * qty == subtotal",
    };

    const contract: RunContract = {
      schemaVersion: 1,
      runId,
      createdAt: new Date().toISOString(),
      objective: "Generate output.csv with valid math",
      resolution: { status: "resolved" },
      routing: {
        intentType: "document_drafting",
        taskType: "draft",
        driverModel: "primary-model",
        actionable: true,
      },
      response: { required: true, chatOnly: false },
      workspace: { requested: false, operations: [] },
      deliverables: [{ id: "d1", filename: "output.csv", filenameRequired: true, type: "csv" }],
      constraints: { protectedPaths: [], restrictMutationsToTargets: false, userConstraints: [] },
      acceptance: {
        validateWrittenCode: false,
        validatedPythonDeliverables: [],
        artifactChecks: [scriptCheck],
      },
    };

    persistRunContract(contract);
    const gateway = new ModelGateway();
    const reviewerSpy = vi.spyOn(gateway, "chatWithTools");

    const checks = await withRuntimeScope(
      { runId, mode: "work", signal: new AbortController().signal, remainingRecoveryAttempts: 2 },
      () =>
        validateWorkArtifacts(
          {
            runId,
            runContract: contract,
            gateway,
            resultStore: new RunResultStore(runId),
            workspaceRoot: runRoot(runId),
          },
          true,
        ),
    );

    const checkResult = checks.find((c) => c.criterionId === "content:check-math");
    expect(checkResult).toBeDefined();
    expect(checkResult?.status).toBe("passed");
    expect(checkResult?.reason).toBe("The deterministic verification script passed.");

    // Critical: kind: 'script' must NOT invoke the model reviewer!
    expect(reviewerSpy).not.toHaveBeenCalled();
  });
});
