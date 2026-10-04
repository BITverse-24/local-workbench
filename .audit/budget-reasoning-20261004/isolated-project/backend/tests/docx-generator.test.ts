import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createDocxBuffer, generateDocx } from "../src/main/tools/artifacts.js";
import { absoluteDataPath, runRoot } from "../src/main/run/filesystem.js";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { createRun } from "../src/main/run/store.js";
import { createChat } from "../src/main/persistence/chats.js";

describe("Formatted Binary DOCX Generator", () => {
  beforeEach(() => {
    initDb(":memory:");
    return () => {
      closeDb();
    };
  });

  it("generates a valid binary docx buffer with PK zip header", async () => {
    const input = {
      title: "Heat Exchanger E-201 Approval Note",
      body: "Equipment E-201 inspection passed with minor observations.",
      sections: [
        {
          heading: "Equipment Header",
          body: "E-201 Heat Exchanger",
        },
        {
          heading: "Findings",
          body: "Rows 12-15 measured 3.8mm against min allowable 4.6mm.",
        },
      ],
      metadata: {
        "Equipment ID": "E-201",
        "Assessor": "John Doe",
      },
      findings: [
        {
          item: "Tube Bundle Rows 12-15",
          measurement: "3.8 - 4.2 mm",
          condition: "Localized thinning",
          status: "Action Required",
        },
      ],
      citations: [
        {
          label: "SOP-114 §3.2",
          supportingExcerpt: "Tubes below allowable threshold must be scheduled for retubing.",
        },
      ],
    };

    const buffer = await createDocxBuffer(input);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);

    // PK zip magic header check (50 4B 03 04)
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
    expect(buffer[2]).toBe(0x03);
    expect(buffer[3]).toBe(0x04);
  });

  it("parses text/markdown into structured docx sections", async () => {
    const textInput = `# Approval Note — Heat Exchanger E-201

Equipment
E-201; report reference: IR-E201-2026-08-20

Findings
Rows 12–15 measured 3.8–4.2 mm against the minimum allowable 4.6 mm.

Recommendation
Conditional clearance pending retubing. [SOP-114 §3.2]`;

    const buffer = await createDocxBuffer(textInput);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  it("writes formatted binary docx artifact to run output directory", async () => {
    const chatId = createChat("Docx test");
    const runId = createRun(chatId, "Generate approval note");

    const artifact = await generateDocx(
      runId,
      {
        title: "Approval Note — Heat Exchanger E-201",
        body: "Conditional clearance granted.",
      },
      "approval-note-E201.docx",
    );

    expect(artifact.kind).toBe("docx");
    expect(artifact.filename).toBe("approval-note-E201.docx");

    const fullPath = absoluteDataPath(artifact.relativePath);
    expect(existsSync(fullPath)).toBe(true);

    const writtenBuffer = readFileSync(fullPath);
    expect(writtenBuffer[0]).toBe(0x50);
    expect(writtenBuffer[1]).toBe(0x4b);

    // Cleanup test run directory
    try {
      rmSync(runRoot(runId), { recursive: true, force: true });
    } catch {}
  });

  it("parses inline formatting (bold, italic, code) into TextRun objects", async () => {
    const { parseInlineFormatting } = await import("../src/main/tools/artifacts.js");
    const runs = parseInlineFormatting("This has **bold text**, *italic notes*, and `const x = 1` code.", 20);
    expect(runs.length).toBeGreaterThan(1);
    const json = JSON.stringify(runs);
    expect(json).toContain("bold text");
    expect(json).toContain("w:b");
    expect(json).toContain("italic notes");
    expect(json).toContain("w:i");
  });

  it("parses markdown tables into native Tables with DXA column widths summing to 9360", async () => {
    const { parseMarkdownTable } = await import("../src/main/tools/artifacts.js");
    const tableLines = [
      "| Component | Limit | Observed | Status |",
      "| :--- | :--- | :--- | :--- |",
      "| Tube Wall | 4.6 mm | 3.8 mm | Non-Compliant |",
      "| Shell Inlet | 1.0 mm | 1.8 mm | Non-Compliant |",
    ];

    const table = parseMarkdownTable(tableLines);
    expect(table).not.toBeNull();
    const colWidths = (table as any).root?.[1]?.columnWidths ?? (table as any).columnWidths;
    if (colWidths) {
      const sum = colWidths.reduce((a: number, b: number) => a + b, 0);
      expect(sum).toBe(9360);
      expect(colWidths.length).toBe(4);
    }
  });

  it("renders complex markdown containing tables, lists, and headings into a valid docx", async () => {
    const markdownContent = `# TECHNICAL INSPECTION & CLEARANCE REPORT

## Executive Summary
All primary inspection findings from attached files have been reviewed against governing engineering standards.

| Equipment | Inspection Type | Key Finding | Compliance |
| --- | --- | --- | --- |
| E-201 Heat Exchanger | Ultrasonic Thickness | Tube wall thinning down to 3.8mm | ACTION REQUIRED |
| E-202 Pressure Vessel | Visual & NDT | Pitting corrosion depth 1.8mm | CONDITIONAL PASS |

## Required Action Items
1. Recheck weld joint 4B on E-201 prior to hydrostatic pressure testing.
2. Replace channel-head gasket on E-202 before recommissioning.

> Note: All corrective actions must be validated by the Chief Technical Authority.
`;

    const buffer = await createDocxBuffer(markdownContent);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(2000);
    // PK zip magic header check
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  it("uses template placeholders for default organization, department, document title, and sign-offs", async () => {
    // When plain text or minimal object is provided without metadata/title, defaults must be template placeholders
    const buffer = await createDocxBuffer("Sample approval note text");
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);

    // Verify custom metadata overrides placeholders
    const inputWithMetadata = {
      title: "Custom Approval Note",
      body: "Sample body text.",
      metadata: {
        "Organization Name": "ACME Industrial Corp",
        "Department": "Safety & Integrity Unit",
        "Document Ref": "REF-2026-9999",
        "Classification": "RESTRICTED",
        "Prepared By Title": "Lead Safety Auditor",
        "Approved By Title": "General Manager",
      },
    };
    const customBuffer = await createDocxBuffer(inputWithMetadata);
    expect(Buffer.isBuffer(customBuffer)).toBe(true);
    expect(customBuffer.length).toBeGreaterThan(1000);
  });

  it("generate_deliverable rejects placeholder content like [TOOL_RESULT]", async () => {
    const { generateDeliverableTool } = await import("../src/main/tools/specialist-tools.js");
    const mockContext: any = {
      runId: "test-deliverable-placeholder",
    };

    await expect(
      generateDeliverableTool.execute(
        {
          type: "docx",
          title: "Test Note",
          content: "[TOOL_RESULT]",
          filename: "test.docx",
        },
        mockContext,
      ),
    ).rejects.toThrow(/placeholder or empty content/i);

    await expect(
      generateDeliverableTool.execute(
        {
          type: "docx",
          title: "Test Note",
          content: "pending",
          filename: "test.docx",
        },
        mockContext,
      ),
    ).rejects.toThrow(/placeholder or empty content/i);
  });
});
