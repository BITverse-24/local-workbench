import { describe, it, expect } from "vitest";
import path from "node:path";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell } from "docx";
import {
  isPdfFile,
  isDocxFile,
  isTextExtractableDocument,
  parseDocxXml,
  extractDocxText,
  extractPdfText,
  readDocumentContent,
} from "../src/main/tools/document-reader.js";
import { readFileTool } from "../src/main/tools/workspace-tools.js";
import { extractDocumentTool } from "../src/main/tools/specialist-tools.js";

describe("Document Reader Utility", () => {
  const fixturePdf = path.resolve(process.cwd(), "demo", "flow_a", "inspection-report-E201-annotated.pdf");
  const tmpDir = path.resolve(process.cwd(), "data", "test-doc-reader");

  it("identifies document extensions correctly", () => {
    expect(isPdfFile("report.pdf")).toBe(true);
    expect(isPdfFile("REPORT.PDF")).toBe(true);
    expect(isPdfFile("report.docx")).toBe(false);

    expect(isDocxFile("memo.docx")).toBe(true);
    expect(isDocxFile("legacy.doc")).toBe(true);
    expect(isDocxFile("report.pdf")).toBe(false);

    expect(isTextExtractableDocument("file.pdf")).toBe(true);
    expect(isTextExtractableDocument("file.docx")).toBe(true);
    expect(isTextExtractableDocument("file.txt")).toBe(false);
    expect(isTextExtractableDocument("file.ts")).toBe(false);
  });

  it("parses docx XML paragraphs and tables accurately into Markdown", () => {
    const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Engineering Inspection Summary</w:t></w:r></w:p>
          <w:p><w:r><w:t>Status: &lt;CRITICAL&gt; &amp; Attention Required</w:t></w:r></w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Component</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Measurement</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Limit</w:t></w:r></w:p></w:tc>
            </w:tr>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Tube Wall</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>3.8 mm</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>4.6 mm</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body>
      </w:document>`;

    const parsed = parseDocxXml(sampleXml);
    expect(parsed).toContain("Engineering Inspection Summary");
    expect(parsed).toContain("Status: <CRITICAL> & Attention Required");
    expect(parsed).toContain("| Component | Measurement | Limit |");
    expect(parsed).toContain("| Tube Wall | 3.8 mm | 4.6 mm |");
  });

  it("extracts text and tables from real DOCX binary buffer", async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: [new TextRun("Refinery Plant Audit")],
            }),
            new Paragraph({
              children: [new TextRun("Key finding: localized pitting detected at inlet nozzle.")],
            }),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Parameter")] }),
                    new TableCell({ children: [new Paragraph("Observation")] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Max Pit Depth")] }),
                    new TableCell({ children: [new Paragraph("1.8 mm")] }),
                  ],
                }),
              ],
            }),
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    const result = await extractDocxText(buffer);

    expect(result.hasText).toBe(true);
    expect(result.text).toContain("Refinery Plant Audit");
    expect(result.text).toContain("localized pitting detected at inlet nozzle.");
    expect(result.text).toContain("| Parameter | Observation |");
    expect(result.text).toContain("| Max Pit Depth | 1.8 mm |");
  });

  it("extracts page-by-page text from digital PDF fixture", async () => {
    if (!existsSync(fixturePdf)) return;

    const result = await extractPdfText(fixturePdf);
    expect(result.hasText).toBe(true);
    expect(result.numPages).toBe(2);
    expect(result.pages.length).toBe(2);
    expect(result.text).toContain("--- Page 1 ---");
    expect(result.text).toContain("NORTH ZONE REFINERY");
    expect(result.text).toContain("Tube wall thickness");
    expect(result.text).toContain("--- Page 2 ---");
    expect(result.text).toContain("follow-up observations");
  });

  it("readDocumentContent produces clear formatted output", async () => {
    if (!existsSync(fixturePdf)) return;

    const res = await readDocumentContent(fixturePdf);
    expect(res.format).toBe("pdf");
    expect(res.hasText).toBe(true);
    expect(res.pageCount).toBe(2);
    expect(res.text).toContain("[Document: inspection-report-E201-annotated.pdf (PDF, 2 pages");
    expect(res.summary).toContain("PDF, 2 pages");
  });

  describe("readFileTool with PDF documents", () => {
    it("extracts readable text rather than raw binary bytes", async () => {
      if (!existsSync(fixturePdf)) return;

      const context: any = {
        workspaceRoot: path.dirname(fixturePdf),
        runId: undefined,
      };

      const result = await readFileTool.execute({ path: path.basename(fixturePdf) }, context);
      expect(result.output).not.toContain("%PDF-1.4");
      expect(result.output).toContain("NORTH ZONE REFINERY");
      expect(result.output).toContain("Tube wall thickness");
      expect(result.summary).toContain("PDF, 2 pages");
    });
  });

  describe("extractDocumentTool with digital PDF documents", () => {
    it("extracts text directly into findings without calling vision gateway", async () => {
      if (!existsSync(fixturePdf)) return;

      const testRunId = "11111111-2222-4333-8444-555555555555";
      mkdirSync(path.join(tmpDir, "runs", testRunId, "input"), { recursive: true });
      const targetPath = path.join(tmpDir, "runs", testRunId, "input", "sample.pdf");
      const { copyFileSync } = await import("node:fs");
      copyFileSync(fixturePdf, targetPath);

      let gatewayCalled = false;
      const context: any = {
        runId: testRunId,
        workspaceRoot: tmpDir,
        gateway: {
          execute: async () => {
            gatewayCalled = true;
            return { ok: true, value: { result: { findings: [] } } };
          },
        },
      };

      // Mock resolveRunPath by putting the file in input dir
      const { runRoot } = await import("../src/main/run/filesystem.js");
      const originalRunRoot = path.join(runRoot(testRunId), "input");
      mkdirSync(originalRunRoot, { recursive: true });
      copyFileSync(fixturePdf, path.join(originalRunRoot, "sample.pdf"));

      const result = await extractDocumentTool.execute({ filename: "sample.pdf" }, context);

      // Verify vision gateway was NOT called because digital text was extracted natively
      expect(gatewayCalled).toBe(false);
      expect(result.output).toContain("digital_text");
      expect(result.output).toContain("NORTH ZONE REFINERY");
      expect(result.summary).toContain("Extracted digital text across 2 pages");

      // Clean up
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });
  });
});
