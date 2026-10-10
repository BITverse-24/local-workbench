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
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
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

    const mockGateway=new ModelGateway();
    const names=[['Draft a compliance note for E-201','E201-compliance-note.md'],['Please draft an audit memo','audit-memo.md'],['custom-review-note.md','custom-review-note.md'],['word document','approval-note.docx'],['Read these inspection reports','E201-compliance-note.md']];
    vi.spyOn(mockGateway,'execute').mockImplementation(async req=>{
      capturedRequests.push(req);
      const filename=names.find(([fragment])=>req.userPrompt.includes(fragment))?.[1];
      if(!filename)throw new Error('Unexpected fixture request');
      return {ok:true,value:{result:{intentType:'document_drafting',driverModel:'primary-model',taskType:'draft',primaryGoal:'Prepare the requested note',isActionable:true,chatResponseOnly:false,workspaceMutationRequested:false,expectedDeliverables:[{filename,type:filename.endsWith('.docx')?'docx':'md'}]}}} as any;
    });
    vi.spyOn(mockGateway,'chatWithTools').mockImplementation(async (_model,messages,_tools,options)=>{
      const schema=options?.responseSchema?.name;
      let content='';
      if(schema==='work_requirements')content='{"checks":[]}';
      else if(schema==='work_content_review'){
        const sourceQuote=/Source ID:[^\n]+/.exec(messages[1].content)?.[0];
        content=JSON.stringify({checks:[{id:'content:complete_request',status:'passed',reason:'The requested note is saved.',outputQuotes:['Engineering Compliance Review Note'],sourceQuotes:sourceQuote?[sourceQuote]:[]}],coverageGaps:[]});
      }
      else content='# Engineering Compliance Review Note\n\n| Item | Observed | Required | Status |\n|---|---|---|---|\n| Wall Thickness | 3.8-4.2 mm | 4.6 mm | REJECTED |\n\nWall thickness does not meet governing criteria.\n\n'+String(messages[0].content).split('SOURCES:\n')[1];
      return {ok:true,value:{content,tool_calls:[],finishReason:'stop'}} as any;
    });
    manager=new RunManager(mockGateway,event=>runEvents.push(event));
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

  describe("Work Deliverable Generation", () => {
    it("creates <item>-compliance-note.md artifact in output/ when compliance note requested", async () => {
      const chatId = createChat("Chat 1");
      const { runId } = await manager.start({
        mode:"work",
        chatId,
        userText: "Draft a compliance note for E-201 based on recent inspection findings",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed"),JSON.stringify(getDb().prepare('SELECT checks_json FROM run_artifact_validations').all())).toBe(true);
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
        mode:"work",
        chatId,
        userText: "Please draft an audit memo for the maintenance outage",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed"),JSON.stringify(getDb().prepare('SELECT checks_json FROM run_artifact_validations').all())).toBe(true);
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
        mode:"work",
        chatId,
        userText: "Review the reactor logs and save as custom-review-note.md",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed"),JSON.stringify(getDb().prepare('SELECT checks_json FROM run_artifact_validations').all())).toBe(true);
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
        mode:"work",
        chatId,
        userText: "Draft an approval note and save as a word document",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed"),JSON.stringify(getDb().prepare('SELECT checks_json FROM run_artifact_validations').all())).toBe(true);
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

  describe("Work Multi-Document Deliverables", () => {
    it("generates markdown deliverable for multi-attachment bundle when compliance note requested", async () => {
      const chatId = createChat("Chat Vision");
      const pdfBuffer = readFileSync(path.resolve("demo/flow_a/inspection-report-E201.pdf"));

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
        mode:"work",
        chatId,
        attachmentTokens: [att1.attachment.attachmentId, att2.attachment.attachmentId],
        userText: "Read these inspection reports and draft a compliance note for E-201",
      });

      await vi.waitFor(
        () => {
          expect(runEvents.some((e) => e.type === "run_state" && e.state === "completed"),JSON.stringify(getDb().prepare('SELECT checks_json FROM run_artifact_validations').all())).toBe(true);
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
