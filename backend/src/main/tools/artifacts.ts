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

/**
 * Tokenizes markdown inline formatting (bold, italic, code) into native docx TextRun objects.
 */
export function parseInlineFormatting(text: string, baseSize = 20, forceBold = false): TextRun[] {
  if (!text) return [];

  // Strip accidental tool markers
  const clean = text
    .replace(/\[\/?(?:TOOL_RESULT|END_TOOL_RESULT|TOOL_CALL|END_TOOL_CALL)\]/gi, "")
    .trim();

  if (!clean) return [];

  const runs: TextRun[] = [];
  // Matches: ***bold italic*** | **bold** | *italic* | __bold__ | _italic_ | `code`
  const regex = /(\*\*\*([^*]+)\*\*\*)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(__([^_]+)__)|(_([^_]+)_)|(`([^`]+)`)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(clean)) !== null) {
    if (match.index > lastIndex) {
      runs.push(
        new TextRun({
          text: clean.slice(lastIndex, match.index),
          bold: forceBold,
          size: baseSize,
        }),
      );
    }

    if (match[2]) {
      // ***bold italic***
      runs.push(new TextRun({ text: match[2], bold: true, italics: true, size: baseSize }));
    } else if (match[4]) {
      // **bold**
      runs.push(new TextRun({ text: match[4], bold: true, size: baseSize }));
    } else if (match[6]) {
      // *italic*
      runs.push(new TextRun({ text: match[6], bold: forceBold, italics: true, size: baseSize }));
    } else if (match[8]) {
      // __bold__
      runs.push(new TextRun({ text: match[8], bold: true, size: baseSize }));
    } else if (match[10]) {
      // _italic_
      runs.push(new TextRun({ text: match[10], bold: forceBold, italics: true, size: baseSize }));
    } else if (match[12]) {
      // `code`
      runs.push(
        new TextRun({
          text: match[12],
          font: "Consolas",
          size: Math.max(16, baseSize - 2),
          shading: { fill: "F1F5F9" },
        }),
      );
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < clean.length) {
    runs.push(
      new TextRun({
        text: clean.slice(lastIndex),
        bold: forceBold,
        size: baseSize,
      }),
    );
  }

  return runs.length > 0 ? runs : [new TextRun({ text: clean, bold: forceBold, size: baseSize })];
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

export function parseMarkdownTable(tableLines: string[]): Table | null {
  if (tableLines.length < 2) return null;

  const rawRows: string[][] = [];
  for (const line of tableLines) {
    // Check if it's a separator line like |:---|---:| or |---|---|
    if (/^\s*\|?\s*[-:]+[-| :]*\|?\s*$/.test(line)) {
      continue;
    }
    const row = parseMarkdownTableRow(line);
    if (row.length > 0 && row.some((c) => c.length > 0)) {
      rawRows.push(row);
    }
  }

  if (rawRows.length === 0) return null;

  const colCount = Math.max(...rawRows.map((r) => r.length));
  if (colCount === 0) return null;

  const totalWidthDxa = 9360;
  const colWidth = Math.floor(totalWidthDxa / colCount);
  const columnWidths = Array(colCount).fill(colWidth);
  columnWidths[colCount - 1] += totalWidthDxa - colWidth * colCount;

  const headerRowCells = rawRows[0];
  const bodyRowsCells = rawRows.slice(1);

  const headerRow = new TableRow({
    tableHeader: true,
    children: Array.from({ length: colCount }).map((_, idx) => {
      const text = headerRowCells[idx] || "";
      return new TableCell({
        width: { size: columnWidths[idx], type: WidthType.DXA },
        shading: { fill: "F1F5F9" },
        margins: { top: 120, bottom: 120, left: 150, right: 150 },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
          bottom: { style: BorderStyle.SINGLE, size: 6, color: "94A3B8" },
          left: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
          right: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
        },
        children: [
          new Paragraph({
            children: parseInlineFormatting(text, 18, true),
          }),
        ],
      });
    }),
  });

  const bodyRows = bodyRowsCells.map((rowCells) => {
    return new TableRow({
      children: Array.from({ length: colCount }).map((_, idx) => {
        const text = rowCells[idx] || "";
        return new TableCell({
          width: { size: columnWidths[idx], type: WidthType.DXA },
          margins: { top: 100, bottom: 100, left: 150, right: 150 },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
            left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
            right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
          },
          children: [
            new Paragraph({
              children: parseInlineFormatting(text, 18),
            }),
          ],
        });
      }),
    });
  });

  return new Table({
    width: { size: totalWidthDxa, type: WidthType.DXA },
    columnWidths,
    rows: [headerRow, ...bodyRows],
  });
}

/**
 * Transforms arbitrary markdown into structured OpenXML Word elements (headings, styled tables, bullet lists, blockquotes).
 */
export function renderMarkdownToDocxElements(markdown: string): Array<Paragraph | Table> {
  const cleaned = markdown
    .replace(/\[\/?(?:TOOL_RESULT|END_TOOL_RESULT|TOOL_CALL|END_TOOL_CALL)\]/gi, "")
    .trim();

  if (!cleaned) return [];

  const elements: Array<Paragraph | Table> = [];
  const lines = cleaned.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. Markdown Headings (#, ##, ###, ####)
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      let headingLevel: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1;
      let size = 24;
      let before = 280;
      let after = 140;

      if (level === 1) {
        headingLevel = HeadingLevel.HEADING_1;
        size = 24;
        before = 280;
        after = 140;
      } else if (level === 2) {
        headingLevel = HeadingLevel.HEADING_2;
        size = 22;
        before = 240;
        after = 120;
      } else if (level === 3) {
        headingLevel = HeadingLevel.HEADING_3;
        size = 20;
        before = 200;
        after = 100;
      } else {
        headingLevel = HeadingLevel.HEADING_4;
        size = 18;
        before = 160;
        after = 80;
      }

      elements.push(
        new Paragraph({
          heading: headingLevel,
          spacing: { before, after },
          children: parseInlineFormatting(text, size, true),
        }),
      );
      i++;
      continue;
    }

    // 2. Horizontal Rules (---, ***, ___)
    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      elements.push(
        new Paragraph({
          spacing: { before: 180, after: 180 },
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: "CBD5E1" },
          },
        }),
      );
      i++;
      continue;
    }

    // 3. Blockquotes (> ...)
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s*/, ""));
        i++;
      }
      elements.push(
        new Paragraph({
          spacing: { before: 120, after: 120 },
          indent: { left: 400 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 16, color: "3B82F6" },
          },
          children: parseInlineFormatting(quoteLines.join(" "), 18),
        }),
      );
      continue;
    }

    // 4. Markdown Tables (| ... |)
    const lineCleanTable = trimmed.replace(/^[-*+]\s+/, "").trim();
    if (lineCleanTable.startsWith("|") && lineCleanTable.endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length) {
        const nextClean = lines[i].trim().replace(/^[-*+]\s+/, "").trim();
        if (nextClean.startsWith("|") && nextClean.endsWith("|")) {
          tableLines.push(nextClean);
          i++;
        } else {
          break;
        }
      }

      const parsedTable = parseMarkdownTable(tableLines);
      if (parsedTable) {
        elements.push(parsedTable);
        elements.push(new Paragraph({ spacing: { after: 160 } }));
        continue;
      }
    }

    // 5. Bullet Lists (- , * , + )
    const bulletMatch = rawLine.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bulletMatch) {
      const indentSpaces = bulletMatch[1].length;
      const bulletText = bulletMatch[3];
      const level = Math.min(Math.floor(indentSpaces / 2), 3);

      elements.push(
        new Paragraph({
          bullet: { level },
          spacing: { after: 80 },
          children: parseInlineFormatting(bulletText, 20),
        }),
      );
      i++;
      continue;
    }

    // 6. Numbered Lists (1. , 2. )
    const numberedMatch = rawLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numberedMatch) {
      const num = numberedMatch[2];
      const numText = numberedMatch[3];

      elements.push(
        new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({ text: `${num}. `, bold: true, size: 20 }),
            ...parseInlineFormatting(numText, 20),
          ],
        }),
      );
      i++;
      continue;
    }

    // 7. Regular paragraph text: collect consecutive non-special lines
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !lines[i].trim().startsWith("#") &&
      !lines[i].trim().startsWith(">") &&
      !(lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) &&
      !/^(\s*)[-*+]\s+/.test(lines[i]) &&
      !/^(\s*)\d+\.\s+/.test(lines[i]) &&
      !/^[-*_]{3,}\s*$/.test(lines[i].trim())
    ) {
      paragraphLines.push(lines[i].trim());
      i++;
    }

    if (paragraphLines.length > 0) {
      elements.push(
        new Paragraph({
          spacing: { after: 140 },
          children: parseInlineFormatting(paragraphLines.join(" "), 20),
        }),
      );
    }
  }

  return elements;
}

export async function createDocxBuffer(input: DocxDraftInput | string): Promise<Buffer> {
  let data: DocxDraftInput;
  if (typeof input === "string") {
    data = parseDocxText(input);
  } else {
    data = input;
  }

  // Clean placeholder tokens if present
  if (data.title) {
    data.title = data.title.replace(/\[\/?(?:TOOL_RESULT|END_TOOL_RESULT|TOOL_CALL|END_TOOL_CALL)\]/gi, "").trim();
  }
  if (data.body) {
    data.body = data.body.replace(/\[\/?(?:TOOL_RESULT|END_TOOL_RESULT|TOOL_CALL|END_TOOL_CALL)\]/gi, "").trim();
    data.body = data.body.replace(/(?:^|\n)\s*[-*+]\s+(\|.*\|\s*)(?=\r?\n|$)/g, "\n$1");
  }
  if (Array.isArray(data.sections)) {
    for (const sec of data.sections) {
      if (sec.body) {
        sec.body = sec.body.replace(/(?:^|\n)\s*[-*+]\s+(\|.*\|\s*)(?=\r?\n|$)/g, "\n$1");
      }
    }
  }

  const children: any[] = [];

  // Header / Enterprise Letterhead
  const orgName = data.metadata?.["Organization Name"] || data.metadata?.["Organization"] || "[ORGANIZATION NAME]";
  const deptName = data.metadata?.["Department"] || data.metadata?.["Division"] || "[DEPARTMENT / DIVISION NAME]";

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: orgName,
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
          text: deptName,
          bold: true,
          size: 20,
        }),
      ],
    }),
  );

  // Document Title
  const docTitle = data.title || "[DOCUMENT TITLE]";
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

  // Metadata Grid Table with explicit DXA column widths (total: 9360 dxa)
  const metaRows: TableRow[] = [];
  const currentDate = new Date().toISOString().split("T")[0];
  const metadataMap: Record<string, string> = {
    "Document Ref": data.metadata?.["Document Ref"] || "[REF_NUMBER]",
    "Date": data.metadata?.["Date"] || currentDate,
    "Classification": data.metadata?.["Classification"] || "[CLASSIFICATION]",
    ...(data.metadata || {}),
  };

  const metaEntries = Object.entries(metadataMap);
  const metaColWidths = [2000, 2680, 2000, 2680]; // Sum = 9360 dxa
  for (let i = 0; i < metaEntries.length; i += 2) {
    const [k1, v1] = metaEntries[i];
    const pair2 = metaEntries[i + 1];

    metaRows.push(
      new TableRow({
        children: [
          new TableCell({
            width: { size: metaColWidths[0], type: WidthType.DXA },
            shading: { fill: "F8FAFC" },
            margins: { top: 100, bottom: 100, left: 150, right: 150 },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
            },
            children: [new Paragraph({ children: [new TextRun({ text: k1, bold: true, size: 18 })] })],
          }),
          new TableCell({
            width: { size: metaColWidths[1], type: WidthType.DXA },
            margins: { top: 100, bottom: 100, left: 150, right: 150 },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
            },
            children: [new Paragraph({ children: [new TextRun({ text: v1, size: 18 })] })],
          }),
          new TableCell({
            width: { size: metaColWidths[2], type: WidthType.DXA },
            shading: { fill: "F8FAFC" },
            margins: { top: 100, bottom: 100, left: 150, right: 150 },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
            },
            children: [
              new Paragraph({
                children: [new TextRun({ text: pair2 ? pair2[0] : "", bold: true, size: 18 })],
              }),
            ],
          }),
          new TableCell({
            width: { size: metaColWidths[3], type: WidthType.DXA },
            margins: { top: 100, bottom: 100, left: 150, right: 150 },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
            },
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
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: metaColWidths,
        rows: metaRows,
      }),
    );
    children.push(new Paragraph({ spacing: { after: 240 } }));
  }

  // Sections or Body Content with markdown parsing
  if (data.sections && data.sections.length > 0) {
    for (const sec of data.sections) {
      if (sec.heading) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 240, after: 120 },
            children: parseInlineFormatting(sec.heading, 22, true),
          }),
        );
      }

      if (sec.body) {
        children.push(...renderMarkdownToDocxElements(sec.body));
      }
    }
  } else if (data.body) {
    children.push(...renderMarkdownToDocxElements(data.body));
  }

  // Findings Table (if present) with explicit DXA column widths
  if (data.findings && data.findings.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text: "Inspection Findings Summary", bold: true, size: 20 })],
      }),
    );

    const findingColWidths = [2400, 2000, 3400, 1560]; // Sum = 9360 dxa
    const tableHeader = new TableRow({
      tableHeader: true,
      children: [
        new TableCell({
          width: { size: findingColWidths[0], type: WidthType.DXA },
          shading: { fill: "F1F5F9" },
          margins: { top: 120, bottom: 120, left: 150, right: 150 },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
            bottom: { style: BorderStyle.SINGLE, size: 6, color: "94A3B8" },
            left: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
            right: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
          },
          children: [new Paragraph({ children: [new TextRun({ text: "Item / Location", bold: true, size: 18 })] })],
        }),
        new TableCell({
          width: { size: findingColWidths[1], type: WidthType.DXA },
          shading: { fill: "F1F5F9" },
          margins: { top: 120, bottom: 120, left: 150, right: 150 },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
            bottom: { style: BorderStyle.SINGLE, size: 6, color: "94A3B8" },
            left: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
            right: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
          },
          children: [new Paragraph({ children: [new TextRun({ text: "Measurement", bold: true, size: 18 })] })],
        }),
        new TableCell({
          width: { size: findingColWidths[2], type: WidthType.DXA },
          shading: { fill: "F1F5F9" },
          margins: { top: 120, bottom: 120, left: 150, right: 150 },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
            bottom: { style: BorderStyle.SINGLE, size: 6, color: "94A3B8" },
            left: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
            right: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
          },
          children: [new Paragraph({ children: [new TextRun({ text: "Condition / Obs", bold: true, size: 18 })] })],
        }),
        new TableCell({
          width: { size: findingColWidths[3], type: WidthType.DXA },
          shading: { fill: "F1F5F9" },
          margins: { top: 120, bottom: 120, left: 150, right: 150 },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
            bottom: { style: BorderStyle.SINGLE, size: 6, color: "94A3B8" },
            left: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
            right: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
          },
          children: [new Paragraph({ children: [new TextRun({ text: "Status", bold: true, size: 18 })] })],
        }),
      ],
    });

    const findingRows = data.findings.map(
      (f) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: findingColWidths[0], type: WidthType.DXA },
              margins: { top: 100, bottom: 100, left: 150, right: 150 },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              },
              children: [new Paragraph({ children: parseInlineFormatting(f.item || "-", 18) })],
            }),
            new TableCell({
              width: { size: findingColWidths[1], type: WidthType.DXA },
              margins: { top: 100, bottom: 100, left: 150, right: 150 },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              },
              children: [new Paragraph({ children: parseInlineFormatting(f.measurement || "-", 18) })],
            }),
            new TableCell({
              width: { size: findingColWidths[2], type: WidthType.DXA },
              margins: { top: 100, bottom: 100, left: 150, right: 150 },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              },
              children: [new Paragraph({ children: parseInlineFormatting(f.condition || "-", 18) })],
            }),
            new TableCell({
              width: { size: findingColWidths[3], type: WidthType.DXA },
              margins: { top: 100, bottom: 100, left: 150, right: 150 },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                left: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
                right: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
              },
              children: [new Paragraph({ children: parseInlineFormatting(f.status || "-", 18) })],
            }),
          ],
        }),
    );

    children.push(
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: findingColWidths,
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

  // Signature Block with explicit DXA column widths (2 columns: 4680, 4680 dxa)
  const preparedByTitle = data.metadata?.["Prepared By Title"] || "[PREPARED_BY_TITLE]";
  const approvedByTitle = data.metadata?.["Approved By Title"] || "[APPROVED_BY_TITLE]";

  children.push(new Paragraph({ spacing: { before: 360, after: 120 } }));
  children.push(
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [4680, 4680],
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 4680, type: WidthType.DXA },
              margins: { top: 120, bottom: 120, left: 150, right: 150 },
              borders: {
                top: { style: BorderStyle.NONE },
                bottom: { style: BorderStyle.NONE },
                left: { style: BorderStyle.NONE },
                right: { style: BorderStyle.NONE },
              },
              children: [
                new Paragraph({ children: [new TextRun({ text: "Prepared By:", bold: true, size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: "___________________________", size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: preparedByTitle, size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: `Date: ${currentDate}`, size: 18 })] }),
              ],
            }),
            new TableCell({
              width: { size: 4680, type: WidthType.DXA },
              margins: { top: 120, bottom: 120, left: 150, right: 150 },
              borders: {
                top: { style: BorderStyle.NONE },
                bottom: { style: BorderStyle.NONE },
                left: { style: BorderStyle.NONE },
                right: { style: BorderStyle.NONE },
              },
              children: [
                new Paragraph({ children: [new TextRun({ text: "Approved By:", bold: true, size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: "___________________________", size: 18 })] }),
                new Paragraph({ children: [new TextRun({ text: approvedByTitle, size: 18 })] }),
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

export function parseDocxText(text: string): DocxDraftInput {
  try {
    const jsonParsed = JSON.parse(text);
    if (jsonParsed && typeof jsonParsed === "object") {
      return jsonParsed as DocxDraftInput;
    }
  } catch {}

  // Parse markdown / key-value format
  // Normalize bulleted or indented markdown table rows: e.g. "- | Equipment | ... |" -> "| Equipment | ... |"
  text = text.replace(/(?:^|\n)\s*[-*+]\s+(\|.*\|\s*)(?=\r?\n|$)/g, "\n$1");
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

  let title = "[DOCUMENT TITLE]";
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
  const rel = writeRunFile(runId, "output", name, buffer, true);
  return artifactRef(runId, "docx", name, rel);
}
