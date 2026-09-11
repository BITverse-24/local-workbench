import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { artifactRef, resolveRunPath, writeRunFile } from "../run/filesystem.js";
import type { ArtifactRef, PythonExecutionResult } from "../../shared/contracts.js";

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(cur);
      cur = "";
    } else {
      cur += char;
    }
  }
  result.push(cur);
  return result;
}

export async function generateXlsx(runId: string, execution: PythonExecutionResult, requestedFilename?: string): Promise<ArtifactRef> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");

  let populated = false;
  const csvFile = execution.outputFiles.find((f) => /\.csv$/i.test(f));
  if (csvFile) {
    try {
      const csvPath = resolveRunPath(runId, `output/${csvFile}`, "output");
      if (existsSync(csvPath)) {
        const content = readFileSync(csvPath, "utf8");
        const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
        for (const line of lines) {
          sheet.addRow(parseCsvLine(line));
        }
        populated = true;
      }
    } catch {
      populated = false;
    }
  }

  if (!populated) {
    const lines = (execution.stdout || "").split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      for (const line of lines) {
        if (line.includes(",")) {
          sheet.addRow(parseCsvLine(line));
        } else if (line.includes("\t")) {
          sheet.addRow(line.split("\t"));
        } else {
          sheet.addRow([line]);
        }
      }
    } else {
      sheet.addRow(["Execution completed with exit code", execution.exitCode]);
    }
  }

  const data = await workbook.xlsx.writeBuffer();
  let candidate = requestedFilename?.trim() || "summary.xlsx";
  if (!/\.xlsx$/i.test(candidate)) {
    candidate = candidate.replace(/\.[^.]+$/, "") + ".xlsx";
  }
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*\.xlsx$/i.test(candidate) ? candidate : "summary.xlsx";
  const rel = writeRunFile(runId, "output", name, Buffer.from(data));
  return artifactRef(runId, "xlsx", name, rel);
}

export interface DocxDraftInput {
  title?: string;
  body?: string;
  sections?: Array<{ id?: string; heading?: string; body?: string }>;
  citations?: Array<{ label?: string; supportingExcerpt?: string; inlineText?: string }>;
  metadata?: Record<string, string>;
  findings?: Array<{ item?: string; measurement?: string; condition?: string; status?: string }>;
}

export async function createDocxBuffer(input: DocxDraftInput | string): Promise<Buffer> {
  let data: DocxDraftInput;
  if (typeof input === "string") {
    data = parseDocxText(input);
  } else {
    data = input;
  }

  const children: any[] = [];

  // Header / Enterprise Letterhead
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: "SOVEREIGN ENGINEERING & DEFENCE SERVICES",
          bold: true,
          size: 28,
        }),
      ],
    }),
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 },
      children: [
        new TextRun({
          text: "TECHNICAL INSPECTION & COMPLIANCE DIVISION",
          bold: true,
          size: 20,
        }),
      ],
    }),
  );

  // Document Title
  const docTitle = data.title || "Technical Inspection Approval Note";
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 240 },
      children: [
        new TextRun({
          text: docTitle,
          bold: true,
          size: 24,
        }),
      ],
    }),
  );

  // Metadata Grid Table
  const metaRows: TableRow[] = [];
  const currentDate = new Date().toISOString().split("T")[0];
  const metadataMap: Record<string, string> = {
    "Document Ref": "AN-E201-2026-01",
    "Date": currentDate,
    "Classification": "OFFICIAL / SENSITIVE",
    "Governing Standard": "SOP-114 §3.2",
    ...(data.metadata || {}),
  };

  const metaEntries = Object.entries(metadataMap);
  for (let i = 0; i < metaEntries.length; i += 2) {
    const [k1, v1] = metaEntries[i];
    const pair2 = metaEntries[i + 1];

    metaRows.push(
      new TableRow({
        children: [
          new TableCell({
            width: { size: 20, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: k1, bold: true, size: 18 })] })],
          }),
          new TableCell({
            width: { size: 30, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: v1, size: 18 })] })],
          }),
          new TableCell({
            width: { size: 20, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [new TextRun({ text: pair2 ? pair2[0] : "", bold: true, size: 18 })],
              }),
            ],
          }),
          new TableCell({
            width: { size: 30, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [new TextRun({ text: pair2 ? pair2[1] : "", size: 18 })],
              }),
            ],
          }),
        ],
      }),
    );
  }

  if (metaRows.length > 0) {
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: metaRows,
      }),
    );
    children.push(new Paragraph({ spacing: { after: 240 } }));
  }

  // Sections or Body Content
  if (data.sections && data.sections.length > 0) {
    for (const sec of data.sections) {
      if (sec.heading) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 240, after: 120 },
            children: [
              new TextRun({
                text: sec.heading,
                bold: true,
                size: 20,
              }),
            ],
          }),
        );
      }

      if (sec.body) {
        const lines = sec.body.split(/\r?\n/).filter((l) => l.trim().length > 0);
        for (const line of lines) {
          children.push(
            new Paragraph({
              spacing: { after: 120 },
              children: [new TextRun({ text: line, size: 20 })],
            }),
          );
        }
      }
    }
  } else if (data.body) {
    const lines = data.body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      children.push(
        new Paragraph({
          spacing: { after: 120 },
          children: [new TextRun({ text: line, size: 20 })],
        }),
      );
    }
  }

  // Findings Table (if present)
  if (data.findings && data.findings.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text: "Inspection Findings Summary", bold: true, size: 20 })],
      }),
    );

    const tableHeader = new TableRow({
      tableHeader: true,
      children: [
        new TableCell({
          width: { size: 25, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: "Item / Location", bold: true, size: 18 })] })],
        }),
        new TableCell({
          width: { size: 25, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: "Measurement", bold: true, size: 18 })] })],
        }),
        new TableCell({
          width: { size: 30, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: "Condition / Obs", bold: true, size: 18 })] })],
        }),
        new TableCell({
          width: { size: 20, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: "Status", bold: true, size: 18 })] })],
        }),
      ],
    });

    const findingRows = data.findings.map(
      (f) =>
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: f.item || "-", size: 18 })] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: f.measurement || "-", size: 18 })] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: f.condition || "-", size: 18 })] })] }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: f.status || "-", size: 18 })] })] }),
          ],
        }),
    );

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [tableHeader, ...findingRows],
      }),
    );
    children.push(new Paragraph({ spacing: { after: 240 } }));
  }

  // Grounding / Citations Footer Section
  if (data.citations && data.citations.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text: "Grounding & Standard Citations", bold: true, size: 20 })],
      }),
    );

    for (const cit of data.citations) {
      children.push(
        new Paragraph({
          spacing: { after: 120 },
          children: [
            new TextRun({ text: `${cit.label || cit.inlineText || "Citation"}: `, bold: true, size: 18 }),
            new TextRun({ text: cit.supportingExcerpt || "", size: 18, italics: true }),
          ],
        }),
      );
    }
  }

  // Signature Block
  children.push(new Paragraph({ spacing: { before: 360, after: 120 } }));
  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              borders: {
                top: { style: BorderStyle.NONE },
                bottom: { style: BorderStyle.NONE },
                left: { style: BorderStyle.NONE },
                right: { style: BorderStyle.NONE },
              },
              children: [
                new Paragraph({ children: [new TextRun({ text: "Prepared By:", bold: true, size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: "___________________________", size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: "Inspection Engineer / Assessor", size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: `Date: ${currentDate}`, size: 18 })] }),
              ],
            }),
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              borders: {
                top: { style: BorderStyle.NONE },
                bottom: { style: BorderStyle.NONE },
                left: { style: BorderStyle.NONE },
                right: { style: BorderStyle.NONE },
              },
              children: [
                new Paragraph({ children: [new TextRun({ text: "Approved By:", bold: true, size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: "___________________________", size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: "Chief Technical Authority", size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: `Date: ${currentDate}`, size: 18 })] }),
              ],
            }),
          ],
        }),
      ],
    }),
  );

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

function parseDocxText(text: string): DocxDraftInput {
  try {
    const jsonParsed = JSON.parse(text);
    if (jsonParsed && typeof jsonParsed === "object") {
      return jsonParsed as DocxDraftInput;
    }
  } catch {}

  // Parse markdown / key-value format
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = text.split(/\r?\n/);

  let currentHeading = "Summary";
  let currentBodyLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#+\s+(.*)$/) || line.match(/^\[section:([^\]]+)\]\s*(.*)$/);
    if (headingMatch) {
      if (currentBodyLines.length > 0 || currentHeading !== "Summary") {
        sections.push({ heading: currentHeading, body: currentBodyLines.join("\n").trim() });
        currentBodyLines = [];
      }
      currentHeading = headingMatch[1].trim() || headingMatch[2].trim();
    } else {
      currentBodyLines.push(line);
    }
  }

  if (currentBodyLines.length > 0 || sections.length === 0) {
    sections.push({ heading: currentHeading, body: currentBodyLines.join("\n").trim() });
  }

  let title = "Approval Note";
  if (sections.length > 0 && sections[0].heading.toLowerCase().includes("approval")) {
    title = sections[0].heading;
  }

  return {
    title,
    sections,
    body: text,
  };
}

export async function generateDocx(
  runId: string,
  input: DocxDraftInput | string,
  requestedFilename?: string,
): Promise<ArtifactRef> {
  const buffer = await createDocxBuffer(input);

  let candidate = requestedFilename?.trim() || "approval-note.docx";
  if (!/\.docx$/i.test(candidate)) {
    candidate = candidate.replace(/\.[^.]+$/, "") + ".docx";
  }
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*\.docx$/i.test(candidate) ? candidate : "approval-note.docx";
  const rel = writeRunFile(runId, "output", name, buffer);
  return artifactRef(runId, "docx", name, rel);
}
