import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initDb, closeDb, getDb } from "../src/main/persistence/db.js";
import {
  RunManager,
  isMarkdownDeliverableRequested,
  deriveMarkdownFilename,
} from "../src/main/run/manager.js";
import { createChat } from "../src/main/persistence/chats.js";
import type { ModelRequest, RunEvent } from "../src/shared/contracts.js";

describe("Generic Markdown Deliverable Generation", () => {
  let tempRoot: string;
  let manager: RunManager;
  let runEvents: RunEvent[];
  let capturedRequests: ModelRequest[];

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "wb-md-deliverable-test-"));
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
                sourceText: "Inspection report contents for E-201",
                findings: [
                  {
                    findingId: "f-1",
                    title: "Wall thickness below minimum limit",
                    value: "2.8mm observed, limit is 3.2mm",
                    pageReferenceIds: ["p-1"],
                    confidence: "high",
                    evidence: "Ultrasonic thickness measurement: 2.8mm",
                  },
                ],
                pageReferences: [{ id: "p-1", page: 1, text: "2.8mm measured" }],
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
                text: `# Engineering Compliance Review Note\n\n| Item | Observed | Required | Status |\n|---|---|---|---|\n| Wall Thickness | 2.8mm | >= 3.2mm | REJECTED |\n\n### Findings\nWall thickness does not meet governing criteria.`,
              },
            },
          };
        }
        return {
          ok: true,
          value: {
            requestId: req.requestId,
            runId: req.runId,
            modelId: req.modelId,
            taskType: "code",
            completedAt: new Date().toISOString(),
            result: { text: "ok" },
          },
        };
      },
      async complete(req: ModelRequest) {
        return this.execute(req);
      },
      health: async () => [],
      models: () => [],
    };

    manager = new RunManager(
      mockGateway as never,
      (evt) => runEvents.push(evt),
    );
  });

  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  });

  describe("Helper Functions", () => {
    it("identifies markdown deliverable requests accurately", () => {
      expect(isMarkdownDeliverableRequested("Draft a compliance note for E-201")).toBe(true);
      expect(isMarkdownDeliverableRequested("Write a review note on the inspection")).toBe(true);
      expect(isMarkdownDeliverableRequested("Prepare an audit memo for the pump skid")).toBe(true);
      expect(isMarkdownDeliverableRequested("Generate a corrective-action note")).toBe(true);
      expect(isMarkdownDeliverableRequested("Provide an audit note for reactor shutdown")).toBe(true);
      expect(isMarkdownDeliverableRequested("Create clearance note for vessel V-101")).toBe(true);
      expect(isMarkdownDeliverableRequested("Save as memo.md")).toBe(true);
      expect(isMarkdownDeliverableRequested("Save output to review-summary.md")).toBe(true);

      // Excludes full Word document requests
      expect(isMarkdownDeliverableRequested("Draft a compliance note and save as a word document")).toBe(false);
      expect(isMarkdownDeliverableRequested("Review note as a .docx file")).toBe(false);
      expect(isMarkdownDeliverableRequested("Approval note .docx")).toBe(false);
      expect(isMarkdownDeliverableRequested("Draft an approval note")).toBe(false);
    });

    it("derives descriptive markdown filenames dynamically", () => {
      expect(deriveMarkdownFilename("Draft a compliance note for E-201", "E-201")).toBe("E201-compliance-note.md");
      expect(deriveMarkdownFilename("Write an audit memo for reactor P-102", "P-102")).toBe("P102-audit-memo.md");
      expect(deriveMarkdownFilename("Create a corrective action note for pump-skid")).toBe("corrective-action-note.md");
      expect(deriveMarkdownFilename("Draft a review note for vessel V101", "V101")).toBe("V101-review-note.md");
      expect(deriveMarkdownFilename("Save output as final-inspection.md")).toBe("final-inspection.md");
      expect(deriveMarkdownFilename("Generate an audit note")).toBe("audit-note.md");
      expect(deriveMarkdownFilename("Write a clearance note for unit C-50", "C-50")).toBe("C50-clearance-note.md");
    });
  });

  describe("executeChatTask Deliverable Generation", () => {
    it("creates <item>-compliance-note.md artifact in output/ when compliance note requested", async () => {
      const chatId = createChat("Chat 1");
      const { runId } = await manager.start({
        chatId,
        userText: "Draft a compliance note for E-201 based on recent inspection findings",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "artifact_ready")).toBe(true);
        },
        { timeout: 2000 },
      );

      const artifactEvt = runEvents.find((e) => e.type === "artifact_ready") as Extract<
        RunEvent,
        { type: "artifact_ready" }
      >;
      expect(artifactEvt).toBeDefined();
      expect(artifactEvt.artifact.kind).toBe("md");
      expect(artifactEvt.artifact.filename).toBe("E201-compliance-note.md");

      // Verify file written to disk in data/runs/<runId>/output/
      const filePath = path.join(
        process.env.WORKBENCH_DATA_ROOT!,
        "runs",
        runId,
        "output",
        "E201-compliance-note.md",
      );
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("Engineering Compliance Review Note");
      expect(content).toContain("REJECTED");

      // Verify persisted in SQLite database
      const row = getDb()
        .prepare("SELECT * FROM artifacts WHERE run_id = ? AND filename = ?")
        .get(runId, "E201-compliance-note.md") as { kind: string; filename: string };
      expect(row).toBeDefined();
      expect(row.kind).toBe("md");
    });

    it("creates audit-memo.md artifact when audit memo requested without item", async () => {
      const chatId = createChat("Chat 2");
      const { runId } = await manager.start({
        chatId,
        userText: "Please draft an audit memo for the maintenance outage",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "artifact_ready")).toBe(true);
        },
        { timeout: 2000 },
      );

      const artifactEvt = runEvents.find((e) => e.type === "artifact_ready") as Extract<
        RunEvent,
        { type: "artifact_ready" }
      >;
      expect(artifactEvt).toBeDefined();
      expect(artifactEvt.artifact.filename).toBe("audit-memo.md");
      expect(artifactEvt.artifact.kind).toBe("md");
    });

    it("respects explicit .md deliverable filename from prompt", async () => {
      const chatId = createChat("Chat 3");
      const { runId } = await manager.start({
        chatId,
        userText: "Review the reactor logs and save as custom-review-note.md",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "artifact_ready")).toBe(true);
        },
        { timeout: 2000 },
      );

      const artifactEvt = runEvents.find((e) => e.type === "artifact_ready") as Extract<
        RunEvent,
        { type: "artifact_ready" }
      >;
      expect(artifactEvt).toBeDefined();
      expect(artifactEvt.artifact.filename).toBe("custom-review-note.md");
      expect(artifactEvt.artifact.kind).toBe("md");
    });

    it("continues generating docx without regression when Word document requested", async () => {
      const chatId = createChat("Chat 4");
      const { runId } = await manager.start({
        chatId,
        userText: "Draft an approval note and save as a word document",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "artifact_ready")).toBe(true);
        },
        { timeout: 2000 },
      );

      const artifactEvt = runEvents.find((e) => e.type === "artifact_ready") as Extract<
        RunEvent,
        { type: "artifact_ready" }
      >;
      expect(artifactEvt).toBeDefined();
      expect(artifactEvt.artifact.filename).toBe("approval-note.docx");
      expect(artifactEvt.artifact.kind).toBe("docx");
    });
  });

  describe("executeVisionTask Multi-Doc Chaining to Markdown Deliverable", () => {
    it("generates markdown deliverable for multi-attachment bundle when compliance note requested", async () => {
      const chatId = createChat("Chat Vision");
      const pdfBuffer = Buffer.from("%PDF-1.4 mock pdf content");

      const att1 = manager.registerAttachment({
        chatId,
        filename: "inspection-report-E201.pdf",
        mediaType: "application/pdf",
        sizeBytes: pdfBuffer.length,
        base64OrBuffer: pdfBuffer,
      });

      const att2 = manager.registerAttachment({
        chatId,
        filename: "thickness-survey-E201.pdf",
        mediaType: "application/pdf",
        sizeBytes: pdfBuffer.length,
        base64OrBuffer: pdfBuffer,
      });

      const { runId } = await manager.start({
        chatId,
        attachmentTokens: [att1.attachment.attachmentId, att2.attachment.attachmentId],
        userText: "Read these inspection reports and draft a compliance note for E-201",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "artifact_ready")).toBe(true);
        },
        { timeout: 2500 },
      );

      const artifactEvt = runEvents.find((e) => e.type === "artifact_ready") as Extract<
        RunEvent,
        { type: "artifact_ready" }
      >;
      expect(artifactEvt).toBeDefined();
      expect(artifactEvt.artifact.filename).toBe("E201-compliance-note.md");
      expect(artifactEvt.artifact.kind).toBe("md");

      // Verify the run finished without needing confirmAction
      const stateEvt = runEvents.find((e) => e.type === "run_state" && (e as any).state === "completed");
      expect(stateEvt).toBeDefined();
    });
  });
});
