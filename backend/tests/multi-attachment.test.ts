import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initDb, closeDb, getDb } from "../src/main/persistence/db.js";
import { RunManager } from "../src/main/run/manager.js";
import { startRunSchema } from "../src/main/ipc/validators.js";
import { createChat } from "../src/main/persistence/chats.js";
import type { ModelRequest, RunEvent } from "../src/shared/contracts.js";

describe("Multi-Attachment Support & Persistence", () => {
  let tempRoot: string;
  let manager: RunManager;
  let runEvents: RunEvent[];
  let capturedRequests: ModelRequest[];

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "wb-multi-att-test-"));
    process.env.WORKBENCH_DATA_ROOT = path.join(tempRoot, "data");
    initDb(path.join(tempRoot, "workbench.sqlite"));

    runEvents = [];
    capturedRequests = [];

    const mockGateway = {
      async execute(req: ModelRequest) {
        capturedRequests.push(req);
        if (req.taskType === "vision") {
          return {
            ok: true,
            value: {
              requestId: req.requestId,
              runId: req.runId,
              modelId: req.modelId,
              taskType: "vision",
              completedAt: new Date().toISOString(),
              result: {
                sourceText: "Inspection report contents",
                findings: [
                  {
                    findingId: "finding-1",
                    title: "Tube wall thickness below minimum allowable",
                    value: "Rows 12–15 measured 3.8–4.2 mm; minimum allowable is 4.6 mm",
                    pageReferenceIds: ["page-ref-1"],
                    confidence: "high",
                    evidence: "Measured 3.8-4.2mm",
                  },
                ],
                pageReferences: [{ id: "page-ref-1", page: 1, text: "Rows 12–15: 3.8–4.2 mm" }],
              },
            },
          };
        }
        if (req.taskType === "draft") {
          return {
            ok: true,
            value: {
              requestId: req.requestId,
              runId: req.runId,
              modelId: req.modelId,
              taskType: "draft",
              completedAt: new Date().toISOString(),
              result: {
                text: "### Approval Note — Heat Exchanger E-201\n\nConditional clearance citing [SOP-114 §3.2].",
              },
            },
          };
        }
        if (req.taskType === "code") {
          if (req.responseFormat === "code-result") {
            return {
              ok: true,
              value: {
                requestId: req.requestId,
                runId: req.runId,
                modelId: req.modelId,
                taskType: "code",
                completedAt: new Date().toISOString(),
                result: {
                  filename: "task.py",
                  source: "import csv\nwith open('repaired-vendor-log.csv', 'w', newline='') as f:\n    f.write('status,count\\nok,4\\n')\nprint('ROWS 5; MALFORMED 1; ABOVE_LIMIT 1')",
                  expectedResult: "ROWS 5; MALFORMED 1; ABOVE_LIMIT 1",
                  inputFiles: ["vendor-maintenance-log.csv"],
                  outputFiles: ["repaired-vendor-log.csv"],
                  allowedImports: ["csv"],
                  outputMode: "artifact",
                  artifactFilename: "repaired-vendor-log.csv",
                  artifactKind: "csv",
                },
              },
            };
          }
          if (req.responseFormat === "code-summary") {
            return {
              ok: true,
              value: {
                requestId: req.requestId,
                runId: req.runId,
                modelId: req.modelId,
                taskType: "code",
                completedAt: new Date().toISOString(),
                result: {
                  summary: "Verified script execution: ROWS 5; MALFORMED 1; ABOVE_LIMIT 1",
                  verified: true,
                },
              },
            };
          }
        }
        return { ok: false, error: { kind: "ai-error", code: "unsupported_task", message: "unsupported", retryable: false } };
      },
      async complete(req: ModelRequest) {
        return this.execute(req);
      },
      health: async () => [],
    } as any;

    manager = new RunManager(mockGateway, (evt) => runEvents.push(evt));
  });

  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("retains the full executed attachment group despite newer registration-only runs", () => {
    const chatId = createChat("Compare reports");
    const first = manager.registerAttachment({ chatId, filename: "first.txt", mediaType: "text/plain", sizeBytes: 12, base64OrBuffer: Buffer.from("first source") });
    const second = manager.registerAttachment({ chatId, filename: "second.txt", mediaType: "text/plain", sizeBytes: 13, base64OrBuffer: Buffer.from("second source") });
    const db = getDb();
    db.prepare("INSERT INTO run_attachments(run_id, attachment_id) VALUES (?, ?)").run(first.runId, second.attachment.attachmentId);
    db.prepare("UPDATE runs SET state='completed', completed_at=? WHERE id=?").run(new Date().toISOString(), first.runId);
    db.prepare("UPDATE runs SET created_at=? WHERE id=?").run("2099-01-01T00:00:00.000Z", second.runId);
    const retained = (manager as any).latestAttachments(chatId);
    expect(retained.map((file: any) => file.filename).sort()).toEqual(["first.txt", "second.txt"]);
  });

  it("validates startRunSchema with attachmentTokens array", () => {
    const validSingle = startRunSchema.safeParse({
      userText: "inspect report",
      attachmentToken: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(validSingle.success).toBe(true);

    const validMultiple = startRunSchema.safeParse({
      userText: "inspect multiple reports",
      attachmentTokens: [
        "123e4567-e89b-12d3-a456-426614174000",
        "223e4567-e89b-12d3-a456-426614174001",
      ],
    });
    expect(validMultiple.success).toBe(true);

    // Empty text without attachments should fail
    const invalidEmpty = startRunSchema.safeParse({
      userText: "",
    });
    expect(invalidEmpty.success).toBe(false);
  });

  it("persists multiple attachments in run_attachments join table", async () => {
    const chatId = createChat("Multi-doc chat");
    const buf1 = Buffer.from("pdf-1-content");
    const buf2 = Buffer.from("pdf-2-content");
    const att1 = manager.registerAttachment({
      chatId,
      filename: "inspection-report-E201-annotated.pdf",
      mediaType: "application/pdf",
      sizeBytes: buf1.length,
      base64OrBuffer: buf1,
    });
    const att2 = manager.registerAttachment({
      chatId,
      filename: "inspection-report-E202-followup.pdf",
      mediaType: "application/pdf",
      sizeBytes: buf2.length,
      base64OrBuffer: buf2,
    });

    const { runId } = await manager.start({
      chatId,
      userText: "Read these inspection reports and draft an approval note.",
      attachmentTokens: [att1.attachment.attachmentId, att2.attachment.attachmentId],
    });

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM run_attachments WHERE run_id = ?")
      .all(runId) as Array<{ run_id: string; attachment_id: string }>;

    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.attachment_id)).toContain(att1.attachment.attachmentId);
    expect(rows.map((r) => r.attachment_id)).toContain(att2.attachment.attachmentId);

    // Wait for the async run to reach confirmation before afterEach tears down DB
    await vi.waitFor(
      () => {
        expect(
          runEvents.some(
            (e) =>
              e.type === "confirmation_required" ||
              (e.type === "run_state" && (e.state === "completed" || e.state === "awaiting_confirmation")),
          ),
        ).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it("executes multi-document inspection without retrieving criteria when grounding is disabled", async () => {
    const chatId = createChat("Flow A chat");
    const buf1 = Buffer.from("Heat Exchanger E-201 Report ID: IR-E201-2026-08-20 RECHECK WELD JOINT 4B - field inspector");
    const buf2 = Buffer.from("Heat Exchanger E-201 Followup Report Maximum pitting depth: 1.8 mm");
    const att1 = manager.registerAttachment({
      chatId,
      filename: "inspection-report-E201-annotated.pdf",
      mediaType: "application/pdf",
      sizeBytes: buf1.length,
      base64OrBuffer: buf1,
    });
    const att2 = manager.registerAttachment({
      chatId,
      filename: "inspection-report-E202-followup.pdf",
      mediaType: "application/pdf",
      sizeBytes: buf2.length,
      base64OrBuffer: buf2,
    });

    const { runId } = await manager.start({
      chatId,
      userText: "Read these inspection reports, pull out the key findings, and draft an approval note for the plant manager.",
      attachmentTokens: [att1.attachment.attachmentId, att2.attachment.attachmentId],
    });

    // Wait for confirmation_required or completion
    await vi.waitFor(
      () => {
        expect(
          runEvents.some(
            (e) =>
              e.type === "confirmation_required" ||
              (e.type === "run_state" && (e.state === "completed" || e.state === "awaiting_confirmation")),
          ),
        ).toBe(true);
      },
      { timeout: 3000 },
    );

    // Verify bundle routing reason
    const visionRoute = runEvents.find((e) => e.type === "routing" && e.taskType === "vision");
    expect(visionRoute).toBeDefined();
    expect((visionRoute as any).reason).toBe("scanned inspection bundle");

    // Grounding is opt-in. The run must not claim or emit criteria retrieval when disabled.
    expect(runEvents.some((e) => e.type === "tool_result" && e.tool === "retrieve_sop")).toBe(false);

    // Verify router transitioned to draft model
    const draftRoute = runEvents.find((e) => e.type === "routing" && e.taskType === "draft");
    expect(draftRoute).toBeDefined();
    expect((draftRoute as any).reason).toBe("compose grounded approval note");

    // Confirm DOCX artifact creation
    const confirmationEvent = runEvents.find(
      (e) => e.type === "confirmation_required",
    ) as Extract<RunEvent, { type: "confirmation_required" }>;
    expect(confirmationEvent).toBeDefined();

    await manager.confirm({
      runId,
      actionId: confirmationEvent.action.actionId,
      approved: true,
    });

    await vi.waitFor(
      () => {
        expect(runEvents.some((e) => e.type === "artifact_ready")).toBe(true);
      },
      { timeout: 2000 },
    );

    const artifactEvent = runEvents.find((e) => e.type === "artifact_ready") as Extract<
      RunEvent,
      { type: "artifact_ready" }
    >;
    expect(artifactEvent.artifact.filename).toBe("approval-note-E201.docx");
  });

  it("executes Flow B script repair with python + csv attachments and artifact generation", async () => {
    const chatId = createChat("Flow B chat");
    const pyCode = Buffer.from("import sys\nsys.exit(1)\n");
    const csvData = Buffer.from("timestamp,temperature_c\n2026-08-20T00:00:00,320.0\n");

    const att1 = manager.registerAttachment({
      chatId,
      filename: "broken-vendor-log-parser.py",
      mediaType: "text/x-python",
      sizeBytes: pyCode.length,
      base64OrBuffer: pyCode,
    });
    const att2 = manager.registerAttachment({
      chatId,
      filename: "vendor-maintenance-log.csv",
      mediaType: "text/csv",
      sizeBytes: csvData.length,
      base64OrBuffer: csvData,
    });

    const { runId } = await manager.start({
      chatId,
      userText: "This is crashing on our vendor log files. Fix it and make sure it actually works.",
      attachmentTokens: [att1.attachment.attachmentId, att2.attachment.attachmentId],
    });

    // Wait for confirmation_required (for execute_python)
    await vi.waitFor(
      () => {
        expect(
          runEvents.some((e) => e.type === "confirmation_required"),
        ).toBe(true);
      },
      { timeout: 3000 },
    );

    // Verify routing decision
    const codeRoute = runEvents.find((e) => e.type === "routing" && e.taskType === "code");
    expect(codeRoute).toBeDefined();
    expect((codeRoute as any).reason).toBe("Python repair and verification");

    // Confirm Python execution
    const confirmationEvent = runEvents.find(
      (e) => e.type === "confirmation_required",
    ) as Extract<RunEvent, { type: "confirmation_required" }>;
    expect(confirmationEvent).toBeDefined();

    await manager.confirm({
      runId,
      actionId: confirmationEvent.action.actionId,
      approved: true,
    });

    // Wait for completion and artifacts
    await vi.waitFor(
      () => {
        expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
      },
      { timeout: 10000 },
    );

    // Verify artifacts generated: both the CSV output and repaired python script
    const artifacts = runEvents
      .filter((e) => e.type === "artifact_ready")
      .map((e: any) => e.artifact.filename);

    expect(artifacts).toContain("repaired-vendor-log.csv");
    expect(artifacts).toContain("repaired-broken-vendor-log-parser.py");

    // Turn 2: Follow-up request to execute code and send the result file
    const turn2StartIndex = runEvents.length;
    const { runId: turn2RunId } = await manager.start({
      chatId,
      userText: "Execute the code and send me the result file",
    });

    // Wait for Turn 2 confirmation_required
    await vi.waitFor(
      () => {
        expect(
          runEvents.slice(turn2StartIndex).some((e) => e.type === "confirmation_required"),
        ).toBe(true);
      },
      { timeout: 3000 },
    );

    const turn2Confirm = runEvents.slice(turn2StartIndex).find(
      (e) => e.type === "confirmation_required",
    ) as Extract<RunEvent, { type: "confirmation_required" }>;

    await manager.confirm({
      runId: turn2RunId,
      actionId: turn2Confirm.action.actionId,
      approved: true,
    });

    await vi.waitFor(
      () => {
        expect(runEvents.slice(turn2StartIndex).some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
      },
      { timeout: 3000 },
    );

    const turn2Artifacts = runEvents
      .slice(turn2StartIndex)
      .filter((e) => e.type === "artifact_ready")
      .map((e: any) => e.artifact.filename);

    expect(turn2Artifacts).toContain("repaired-vendor-log.csv");
  });
});
