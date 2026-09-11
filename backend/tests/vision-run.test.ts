import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { RunManager } from "../src/main/run/manager.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import type { ModelRequest, RunEvent, VisionResult } from "../src/shared/contracts.js";

describe("Vision Task Execution (Architecture Collapse)", () => {
  let tempRoot: string;
  let manager: RunManager;
  let runEvents: RunEvent[];
  let capturedRequests: ModelRequest[];

  beforeEach(() => {
    tempRoot = path.join(
      os.tmpdir(),
      `wb-vision-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tempRoot, { recursive: true });
    process.env.WORKBENCH_DATA_ROOT = path.join(tempRoot, "data");
    initDb(path.join(tempRoot, "workbench.sqlite"));

    runEvents = [];
    capturedRequests = [];
  });

  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function createMockGateway(visionResult: VisionResult) {
    const fn = vi.fn().mockImplementation(async (req: ModelRequest) => {
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
            result: visionResult,
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
            result: { text: "Generated Approval Note for Inspection" },
          },
        };
      }
      return {
        ok: false,
        error: { kind: "ai-error", code: "unsupported_task", message: "unsupported" },
      };
    });

    return {
      registry: new Map(),
      execute: fn,
      complete: fn,
    } as any;
  }

  it("routes PDF/image attachments directly to executeVisionTask and outputs structured findings", async () => {
    const mockFindings: VisionResult = {
      sourceText: "Inspection Report 101. Tube wall thickness is 3.5mm.",
      findings: [
        {
          findingId: "f-1",
          title: "Tube wall thickness below threshold",
          value: "Measured 3.5mm (minimum 4.2mm)",
          pageReferenceIds: ["p-1"],
          confidence: "high",
          evidence: "Report section 4 specifies 4.2mm threshold.",
        },
      ],
      pageReferences: [{ id: "p-1", page: 1, text: "wall thickness 3.5mm", location: "table 2" }],
      warnings: ["Minor glare on bottom margin"],
    };

    const mockGateway = createMockGateway(mockFindings);
    manager = new RunManager(mockGateway, (evt) => runEvents.push(evt));

    const chatId = createChat("Vision Run");
    const buffer = Buffer.from("%PDF-1.4 mock content");
    const { attachment } = manager.registerAttachment({
      chatId,
      filename: "inspection_report.pdf",
      mediaType: "application/pdf",
      sizeBytes: buffer.length,
      base64OrBuffer: buffer,
    });

    await manager.start({
      chatId,
      userText: "Review this report and identify defects",
      attachmentToken: attachment.attachmentId,
    });

    await vi.waitFor(
      () => {
        expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    const routingEvt = runEvents.find((e) => e.type === "routing");
    expect(routingEvt).toBeDefined();
    expect((routingEvt as any).taskType).toBe("vision");
    expect((routingEvt as any).modelId).toBe("vision-qwen25vl");

    const msgEvt = runEvents.find((e) => e.type === "assistant_message") as any;
    expect(msgEvt).toBeDefined();
    expect(msgEvt.modelId).toBe("vision-qwen25vl");
    expect(msgEvt.text).toContain("Tube wall thickness below threshold");
    expect(msgEvt.text).toContain("Minor glare on bottom margin");

    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0].taskType).toBe("vision");
  });

  it("chains vision findings seamlessly into draft when user requests an approval note in single turn", async () => {
    const mockFindings: VisionResult = {
      sourceText: "Reactor Pressure Vessel Inspection: crack detected.",
      findings: [
        {
          findingId: "f-1",
          title: "Stress crack on weld seam",
          value: "Length 12mm",
          pageReferenceIds: ["p-1"],
          confidence: "high",
          evidence: "Ultrasonic testing log entry 4",
        },
      ],
      pageReferences: [{ id: "p-1", page: 1, text: "crack 12mm", location: "weld 3" }],
      warnings: [],
    };

    const mockGateway = createMockGateway(mockFindings);
    manager = new RunManager(mockGateway, (evt) => runEvents.push(evt));

    const chatId = createChat("Vision Draft Chained Run");
    const buffer = Buffer.from("mock png bytes");
    const { attachment } = manager.registerAttachment({
      chatId,
      filename: "vessel_scan.png",
      mediaType: "image/png",
      sizeBytes: buffer.length,
      base64OrBuffer: buffer,
    });

    await manager.start({
      chatId,
      userText: "Extract findings from this scan and draft an approval note docx",
      attachmentToken: attachment.attachmentId,
    });

    await vi.waitFor(
      () => {
        expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    expect(capturedRequests.length).toBe(2);
    expect(capturedRequests[0].taskType).toBe("vision");
    expect(capturedRequests[1].taskType).toBe("draft");

    expect(capturedRequests[1].userPrompt).toContain("Stress crack on weld seam");

    const artifactEvt = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifactEvt).toBeDefined();
    expect((artifactEvt as any).artifact.filename).toBe("approval-note.docx");
  });
});
