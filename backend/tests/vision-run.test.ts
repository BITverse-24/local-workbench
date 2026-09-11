import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { RunManager } from "../src/main/run/manager.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { rankPagesByVisualDensity } from "../src/main/run/images.js";
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

  it("automatically uses Tier 1 Fast Text extraction for clean digital PDF, saving vision tokens", async () => {
    const mockFindings: VisionResult = {
      sourceText: "",
      findings: [],
      pageReferences: [],
      warnings: [],
    };
    const mockGateway = createMockGateway(mockFindings);
    manager = new RunManager(mockGateway, (evt) => runEvents.push(evt));

    const chatId = createChat("Tier 1 Text Run");
    // Synthetic PDF with text stream Tj operators (>= 150 chars)
    const pdfContent = `%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>> endobj
4 0 obj <</Length 200>>
stream
BT
/F1 12 Tf
(This is a clean typed digital engineering specification report detailing equipment parameters and operational limits for refinery steam boiler units across Section A and Section B.) Tj
ET
endstream
endobj
xref
0 5
trailer <</Root 1 0 R>>
%%EOF`;

    const buffer = Buffer.from(pdfContent);
    const { attachment } = manager.registerAttachment({
      chatId,
      filename: "digital_spec.pdf",
      mediaType: "application/pdf",
      sizeBytes: buffer.length,
      base64OrBuffer: buffer,
    });

    await manager.start({
      chatId,
      userText: "Summarize this boiler specification document",
      attachmentToken: attachment.attachmentId,
    });

    await vi.waitFor(
      () => {
        expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    // Should have routed to draft-qwen3 via Tier 1, burning ZERO vision tokens
    const routingEvt = runEvents.find((e) => e.type === "routing") as any;
    expect(routingEvt).toBeDefined();
    expect(routingEvt.taskType).toBe("draft");
    expect(routingEvt.modelId).toBe("draft-qwen3");
    expect(routingEvt.tier).toBe("text");
    expect(routingEvt.tokensSaved).toBeGreaterThan(1000);

    // Gateway should only have received a draft request, NO vision model request
    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0].taskType).toBe("draft");
    expect(capturedRequests[0].userPrompt).toContain("clean typed digital engineering specification");
  });

  it("forces Tier 2 Vision model when user prompt specifically mentions engineering drawing / P&ID", async () => {
    const mockFindings: VisionResult = {
      sourceText: "Drawing schematic values: pump P-101 suction pressure 4.5 bar",
      findings: [
        {
          findingId: "f-drawing-1",
          title: "Pump suction line",
          value: "4.5 bar",
          pageReferenceIds: ["p-1"],
          confidence: "high",
          evidence: "P&ID tag P-101",
        },
      ],
      pageReferences: [{ id: "p-1", page: 1, text: "P-101 4.5 bar", location: "suction line" }],
      warnings: [],
    };
    const mockGateway = createMockGateway(mockFindings);
    manager = new RunManager(mockGateway, (evt) => runEvents.push(evt));

    const chatId = createChat("Tier 2 Drawing Run");
    // Synthetic PDF with text stream, but prompt explicitly asks for drawing / P&ID
    const pdfContent = `%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>> endobj
4 0 obj <</Length 200>>
stream
BT
/F1 12 Tf
(Drawing label: P&ID layout for cooling water recirculation loop and pump skid system.) Tj
ET
endstream
endobj
xref
0 5
trailer <</Root 1 0 R>>
%%EOF`;

    const buffer = Buffer.from(pdfContent);
    const { attachment } = manager.registerAttachment({
      chatId,
      filename: "pump_skid_pid.pdf",
      mediaType: "application/pdf",
      sizeBytes: buffer.length,
      base64OrBuffer: buffer,
    });

    await manager.start({
      chatId,
      userText: "Inspect this engineering drawing and check the pump skid P&ID layout",
      attachmentToken: attachment.attachmentId,
    });

    await vi.waitFor(
      () => {
        expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    // Should have routed to vision-qwen25vl via Tier 2 because of visual keywords
    const routingEvt = runEvents.find((e) => e.type === "routing") as any;
    expect(routingEvt).toBeDefined();
    expect(routingEvt.taskType).toBe("vision");
    expect(routingEvt.modelId).toBe("vision-qwen25vl");
    expect(routingEvt.tier).toBe("vision");

    // Gateway should have received a vision request
    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0].taskType).toBe("vision");
  });

  it("selectively slices multi-page documents, sending only top visual pages and preserving text context", async () => {
    const mockFindings: VisionResult = {
      sourceText: "Extracted P&ID diagram findings for Feed Pump P-201",
      findings: [
        {
          findingId: "f-p201",
          title: "Pump P-201 bypass valve",
          value: "Normally closed",
          pageReferenceIds: ["p-2"],
          confidence: "high",
          evidence: "Schematic block on Page 2 shows valve NC",
        },
      ],
      pageReferences: [{ id: "p-2", page: 2, text: "valve NC", location: "bypass line" }],
      warnings: [],
    };
    const mockGateway = createMockGateway(mockFindings);
    manager = new RunManager(mockGateway, (evt) => runEvents.push(evt));

    const chatId = createChat("Selective Slicing Run");
    // 3-page synthetic PDF: Page 1 is generic intro, Page 2 is P&ID drawing with pump P-201, Page 3 is warranty
    const pdfContent = `%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>> endobj
4 0 obj <</Length 120>>
stream
BT
/F1 12 Tf
(Introduction and general equipment overview. This vendor package describes feed pump systems.) Tj
ET
endstream
endobj
5 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 1191 842] /Contents 6 0 R>> endobj
6 0 obj <</Length 180>>
stream
BT
/F1 12 Tf
(P&ID SCHEMATIC: PUMP P-201 SUCTION AND DISCHARGE PIPING LAYOUT WITH CONTROL VALVES AND BYPASS.) Tj
ET
endstream
endobj
7 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R>> endobj
8 0 obj <</Length 100>>
stream
BT
/F1 12 Tf
(Warranty terms and conditions. Maintenance schedule requires quarterly inspections.) Tj
ET
endstream
endobj
xref
0 9
trailer <</Root 1 0 R>>
%%EOF`;

    const buffer = Buffer.from(pdfContent);
    const { attachment } = manager.registerAttachment({
      chatId,
      filename: "vendor_manual_p201.pdf",
      mediaType: "application/pdf",
      sizeBytes: buffer.length,
      base64OrBuffer: buffer,
    });

    await manager.start({
      chatId,
      userText: "Inspect the drawing for pump P-201 and check bypass valve status",
      attachmentToken: attachment.attachmentId,
    });

    await vi.waitFor(
      () => {
        expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed")).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    // Verify vision request was generated
    expect(capturedRequests.length).toBe(1);
    const vReq = capturedRequests[0] as any;
    expect(vReq.taskType).toBe("vision");

    // Page 2 should be selected because it has landscape format (1191x842), P&ID keywords, and matches P-201!
    expect(vReq.attachment.selectedPages).toBeDefined();
    expect(vReq.attachment.selectedPages).toContain(2);

    // Unselected pages text (Page 1 or 3) should be injected as context in userPrompt
    expect(vReq.userPrompt).toContain("vendor_manual_p201.pdf");
    expect(vReq.userPrompt).toContain("Context from other pages");
  });
});


