import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
import { extractDocxText } from "./document-reader.js";
import { artifactRef, resolveRunPath, writeRunFile, dataRoot, runRoot } from "../run/filesystem.js";
import type { ArtifactKind, ArtifactRef, PythonExecutionResult } from "../../shared/contracts.js";

export interface ArtifactVerificationOptions {
  runId?: string;
  expectedKind?: ArtifactKind;
  originalContent?: string;
  allowEmpty?: boolean;
}

export interface ArtifactVerificationResult {
  valid: boolean;
  filePath: string;
  kind: ArtifactKind;
  sizeBytes: number;
  checks: {
    exists: boolean;
    withinAuthorizedDir: boolean;
    nonEmpty: boolean;
    extensionMatches: boolean;
    parserOpened: boolean;
    structuralValid: boolean;
  };
  details: {
    sheetCount?: number;
    rowCount?: number;
    paragraphCount?: number;
    tableCount?: number;
    contentMatch?: boolean;
    error?: string;
  };
}

export function inferArtifactKind(filename: string): ArtifactKind {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, "");
  if (["xlsx", "xls"].includes(ext)) return "xlsx";
  if (["docx", "doc"].includes(ext)) return "docx";
  if (["csv"].includes(ext)) return "csv";
  if (["json"].includes(ext)) return "json";
  if (["md", "markdown"].includes(ext)) return "md";
  if (["pdf"].includes(ext)) return "pdf";
  return "txt";
}

export function isAuthorizedArtifactPath(targetPath: string, runId?: string): boolean {
  try {
    const resolved = path.resolve(targetPath);
    if (runId) {
      const rRoot = path.resolve(runRoot(runId));
      return resolved.startsWith(rRoot + path.sep) || resolved === rRoot;
    }
    const dRoot = path.resolve(dataRoot());
    return resolved.startsWith(dRoot + path.sep) || resolved === dRoot;
  } catch {}
  return false;
}

export async function verifyArtifactFile(
  filePath: string,
  options?: ArtifactVerificationOptions,
): Promise<ArtifactVerificationResult> {
  const kind = options?.expectedKind || inferArtifactKind(filePath);
  const result: ArtifactVerificationResult = {
    valid: false,
    filePath,
    kind,
    sizeBytes: 0,
    checks: {
      exists: false,
      withinAuthorizedDir: false,
      nonEmpty: false,
      extensionMatches: false,
      parserOpened: false,
      structuralValid: false,
    },
    details: {},
  };

  // 1. File exists
  if (!existsSync(filePath)) {
    result.details.error = `Artifact file does not exist at "${filePath}"`;
    return result;
  }
  result.checks.exists = true;

  // 2. Path within authorized directory
  if (options?.runId && !isAuthorizedArtifactPath(filePath, options.runId)) {
    result.details.error = `Artifact path "${filePath}" is outside authorized run directory for run "${options.runId}"`;
    return result;
  }
  result.checks.withinAuthorizedDir = true;

  // 3. File is non-empty
  let stat;
  try {
    stat = statSync(filePath);
    result.sizeBytes = stat.size;
  } catch (err: any) {
    result.details.error = `Failed to stat artifact file: ${err?.message || String(err)}`;
    return result;
  }

  if (stat.size === 0 && !options?.allowEmpty) {
    result.details.error = `Artifact file "${path.basename(filePath)}" is empty (0 bytes)`;
    return result;
  }
  result.checks.nonEmpty = true;

  // 4. File extension agrees with requested type
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  const expectedExts: Record<ArtifactKind, string[]> = {
    xlsx: ["xlsx", "xls"],
    docx: ["docx", "doc"],
    md: ["md", "markdown"],
    csv: ["csv"],
    json: ["json"],
    pdf: ["pdf"],
    txt: ["txt", "py", "sh", "sql", "log"],
  };

  const allowedExts = expectedExts[kind] || [kind];
  if (!allowedExts.includes(ext)) {
    result.details.error = `File extension ".${ext}" does not agree with requested artifact type "${kind}"`;
    return result;
  }
  result.checks.extensionMatches = true;

  // 5 & 6. Parser opening and structural validation
  if (kind === "xlsx") {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      result.checks.parserOpened = true;

      if (!workbook.worksheets || workbook.worksheets.length === 0) {
        result.details.error = "XLSX workbook contains no worksheets";
        return result;
      }

      let totalRowsWithData = 0;
      let hasProhibitedCompletedPlaceholder = false;

      for (const sheet of workbook.worksheets) {
        let sheetRowsWithData = 0;
        sheet.eachRow((row) => {
          const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
          if (vals.some((v) => v !== null && v !== undefined && String(v).trim().length > 0)) {
            sheetRowsWithData++;
            totalRowsWithData++;
          }
        });

        if (sheetRowsWithData === 2) {
          const r1 = String(sheet.getRow(1).values).toLowerCase();
          const r2 = String(sheet.getRow(2).values).toLowerCase();
          if (r1.includes("report") && r2.includes("status") && r2.includes("completed")) {
            hasProhibitedCompletedPlaceholder = true;
          }
        }
      }

      if (hasProhibitedCompletedPlaceholder && totalRowsWithData <= 2) {
        result.details.error = "XLSX workbook contains prohibited fabricated-success placeholder ('Status: Completed') with no substantive data rows";
        return result;
      }

      if (totalRowsWithData === 0 && !options?.allowEmpty) {
        result.details.error = "XLSX workbook contains no substantive data rows across any worksheet";
        return result;
      }

      result.checks.structuralValid = true;
      result.details.sheetCount = workbook.worksheets.length;
      result.details.rowCount = totalRowsWithData;
    } catch (err: any) {
      result.details.error = `Failed to parse XLSX workbook: ${err?.message || String(err)}`;
      return result;
    }
  } else if (kind === "docx") {
    try {
      const docxResult = await extractDocxText(filePath);
      result.checks.parserOpened = true;

      const text = docxResult.text.trim();
      if (text.length < 15 && !options?.allowEmpty) {
        result.details.error = "DOCX document contains insufficient or empty text content";
        return result;
      }

      result.checks.structuralValid = true;
      result.details.paragraphCount = text.split(/\n\s*\n/).filter(Boolean).length;
      result.details.contentMatch = true;
    } catch (err: any) {
      result.details.error = `Failed to open or parse DOCX package: ${err?.message || String(err)}`;
      return result;
    }
  } else if (kind === "json") {
    try {
      const content = readFileSync(filePath, "utf8");
      result.checks.parserOpened = true;
      JSON.parse(content);
      result.checks.structuralValid = true;
      result.details.contentMatch = true;
    } catch (err: any) {
      result.details.error = `Failed to parse JSON file: ${err?.message || String(err)}`;
      return result;
    }
  } else {
    // Markdown / text / CSV
    try {
      const content = readFileSync(filePath, "utf8");
      result.checks.parserOpened = true;

      if (content.trim().length === 0 && !options?.allowEmpty) {
        result.details.error = "File content is empty";
        return result;
      }

      if (options?.originalContent !== undefined) {
        const normActual = content.trim();
        const normExpected = options.originalContent.trim();
        if (normActual !== normExpected) {
          result.details.error = "File content does not match submitted content";
          result.details.contentMatch = false;
          return result;
        }
      }

      result.checks.structuralValid = true;
      result.details.contentMatch = true;
    } catch (err: any) {
      result.details.error = `Failed to read file: ${err?.message || String(err)}`;
      return result;
    }
  }

  result.valid =
    result.checks.exists &&
    result.checks.withinAuthorizedDir &&
    result.checks.nonEmpty &&
    result.checks.extensionMatches &&
    result.checks.parserOpened &&
    result.checks.structuralValid;

  return result;
}

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
    const delimitedLines = lines.filter((l) => l.includes(",") || l.includes("\t") || l.includes(";") || (l.startsWith("|") && l.endsWith("|")));
    if (delimitedLines.length > 0) {
      for (const line of delimitedLines) {
        if (line.includes(",")) {
          sheet.addRow(parseCsvLine(line));
        } else if (line.includes("\t")) {
          sheet.addRow(line.split("\t"));
        } else if (line.includes(";")) {
          sheet.addRow(line.split(";"));
        } else if (line.startsWith("|") && line.endsWith("|")) {
          const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
          sheet.addRow(cells);
        }
      }
      populated = true;
    }
  }

  if (!populated) {
    throw new Error("Failed to generate XLSX: Execution output contains no CSV or tabular rows to populate workbook.");
  }

  const data = await workbook.xlsx.writeBuffer();
  let candidate = requestedFilename?.trim() || "summary.xlsx";
  if (!/\.xlsx$/i.test(candidate)) {
    candidate = candidate.replace(/\.[^.]+$/, "") + ".xlsx";
  }
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*\.xlsx$/i.test(candidate) ? candidate : "summary.xlsx";

  // Staging -> Verification -> Promotion lifecycle
  const tempName = `staging-${randomUUID()}-${name}`;
  writeRunFile(runId, "intermediate", tempName, Buffer.from(data), true);
  const tempPath = resolveRunPath(runId, `intermediate/${tempName}`, "intermediate");

  const verification = await verifyArtifactFile(tempPath, {
    runId,
    expectedKind: "xlsx",
  });

  if (!verification.valid) {
    try { rmSync(tempPath, { force: true }); } catch {}
    throw new Error(`Artifact verification failed for XLSX "${name}": ${verification.details.error}`);
  }

  const rel = writeRunFile(runId, "output", name, Buffer.from(data), true);
  try { rmSync(tempPath, { force: true }); } catch {}

  const art = artifactRef(runId, "xlsx", name, rel);
  art.verified = true;
  art.verificationDetails = verification.details;
  return art;
}

export async function generateXlsxFromContent(
  runId: string,
  content: string,
  requestedFilename?: string,
  title?: string,
): Promise<ArtifactRef> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title?.slice(0, 30) || "Data");

  const lines = (content || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Preserve all tables and surrounding source notes. Citations and explicit
  // missing-measurement statements often live outside the measurement table.
  const tableLines = lines.filter((line) => /^\|.*\|$/.test(line));
  let proseLines = tableLines.length >= 2
    ? lines.filter((line) => !tableLines.includes(line) && !/^```/.test(line))
    : [];

  const rowsToAdd: string[][] = [];

  if (tableLines.length >= 2) {
    for (const tl of tableLines) {
      if (/^\s*\|?\s*[-:]+[-| :]*\|?\s*$/.test(tl)) continue;
      const inner = tl.replace(/^\|/, "").replace(/\|$/, "");
      const cells = inner.split("|").map((c) => c.trim());
      if (cells.length > 0 && cells.some((c) => c.length > 0)) {
        rowsToAdd.push(cells);
      }
    }
  } else {
    const fields = lines.filter((line) => !/^#/.test(line)).flatMap((line) => {
      const clean = line.replace(/^[-*]\s+/, "").replace(/\*\*/g, "");
      return clean.split(/\.\s+(?=[A-Z][^.:]*:)/).flatMap((part) => {
        const field = part.match(/^([A-Za-z][^:]{0,99}):\s*(\S[\s\S]*)$/);
        return field ? [[field[1].trim(), field[2].trim()]] : [];
      });
    });
    if (fields.length > 0) {
      rowsToAdd.push(["Field", "Value"], ...fields);
      proseLines = lines;
    }
    const delimitedLines = lines.filter((l) => l.includes(",") || l.includes("\t") || l.includes(";"));
    for (const line of rowsToAdd.length ? [] : delimitedLines) {
      if (line.includes(",")) {
        rowsToAdd.push(parseCsvLine(line));
      } else if (line.includes("\t")) {
        rowsToAdd.push(line.split("\t").map((c) => c.trim()));
      } else if (line.includes(";")) {
        rowsToAdd.push(line.split(";").map((c) => c.trim()));
      }
    }
  }

  // A failed parse must never generate a workbook claiming completion
  if (rowsToAdd.length === 0) {
    throw new Error("Failed to generate XLSX: Content contains no tabular rows or valid CSV/Markdown table data.");
  }

  const hasSubstantiveData = rowsToAdd.some((row) =>
    row.some((cell) => cell && cell.trim().length > 0 && !/^(?:report|status|summary|completed)$/i.test(cell.trim())),
  );
  if (!hasSubstantiveData) {
    throw new Error("Failed to generate XLSX: Content contains no substantive tabular data rows.");
  }

  // Add rows with clean styling
  for (let rIdx = 0; rIdx < rowsToAdd.length; rIdx++) {
    const rowData = rowsToAdd[rIdx];
    const excelRow = sheet.addRow(rowData);
    if (rIdx === 0 && rowsToAdd.length > 1) {
      excelRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FF0F172A" }, size: 11 };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF1F5F9" },
        };
        cell.border = {
          top: { style: "thin", color: { argb: "FFCBD5E1" } },
          bottom: { style: "medium", color: { argb: "FF94A3B8" } },
          left: { style: "thin", color: { argb: "FFCBD5E1" } },
          right: { style: "thin", color: { argb: "FFCBD5E1" } },
        };
        cell.alignment = { vertical: "middle", horizontal: "left" };
      });
      excelRow.height = 24;
    } else {
      excelRow.eachCell((cell) => {
        cell.font = { size: 10, color: { argb: "FF334155" } };
        cell.border = {
          top: { style: "thin", color: { argb: "FFE2E8F0" } },
          bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
          left: { style: "thin", color: { argb: "FFE2E8F0" } },
          right: { style: "thin", color: { argb: "FFE2E8F0" } },
        };
        cell.alignment = { vertical: "middle", horizontal: "left" };
      });
      excelRow.height = 20;
    }
  }

  if (proseLines.length > 0) {
    const notes = workbook.addWorksheet(sheet.name === "Source Notes" ? "Source Notes 2" : "Source Notes");
    notes.getColumn(1).width = 90;
    for (const line of proseLines) {
      const row = notes.addRow([line.replace(/^#{1,6}\s+/, "").replace(/\*\*(.*?)\*\*/g, "$1")]);
      row.getCell(1).alignment = { vertical: "top", wrapText: true };
      row.height = Math.max(20, Math.ceil(String(row.getCell(1).value).length / 90) * 16);
    }
  }

  sheet.columns.forEach((column) => {
    let maxLength = 12;
    if (column && column.eachCell) {
      column.eachCell({ includeEmpty: true }, (cell) => {
        const valStr = cell.value ? String(cell.value) : "";
        if (valStr.length > maxLength) {
          maxLength = Math.min(valStr.length + 3, 50);
        }
      });
    }
    column.width = maxLength;
  });

  const data = await workbook.xlsx.writeBuffer();
  let candidate = requestedFilename?.trim() || "deliverable.xlsx";
  if (!/\.xlsx$/i.test(candidate)) {
    candidate = candidate.replace(/\.[^.]+$/, "") + ".xlsx";
  }
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*\.xlsx$/i.test(candidate) ? candidate : "deliverable.xlsx";

  // Staging -> Verification -> Promotion lifecycle
  const tempName = `staging-${randomUUID()}-${name}`;
  writeRunFile(runId, "intermediate", tempName, Buffer.from(data), true);
  const tempPath = resolveRunPath(runId, `intermediate/${tempName}`, "intermediate");

  const verification = await verifyArtifactFile(tempPath, {
    runId,
    expectedKind: "xlsx",
  });

  if (!verification.valid) {
    try { rmSync(tempPath, { force: true }); } catch {}
    throw new Error(`Artifact verification failed for XLSX "${name}": ${verification.details.error}`);
  }

  const rel = writeRunFile(runId, "output", name, Buffer.from(data), true);
  try { rmSync(tempPath, { force: true }); } catch {}

  const art = artifactRef(runId, "xlsx", name, rel);
  art.verified = true;
  art.verificationDetails = verification.details;
  return art;
}

export interface DocxDraftInput {
  title?: string;
  body?: string;
  sections?: Array<{ id?: string; heading?: string; body?: string }>;
  citations?: Array<{ label?: string; supportingExcerpt?: string; inlineText?: string }>;
  metadata?: Record<string, string>;
  findings?: Array<{ identifier?: string; observation?: string; requirement?: string; assessment?: string; action?: string; evidence?: string; item?: string; measurement?: string; condition?: string; status?: string }>;
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
  if (tableLines.length === 0) return null;

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
  let cleaned = markdown
    .replace(/\[\/?(?:TOOL_RESULT|END_TOOL_RESULT|TOOL_CALL|END_TOOL_CALL)\]/gi, "")
    .trim();

  // Normalize bulleted or indented markdown table rows (e.g. "- | Equipment | ... |" -> "| Equipment | ... |")
  cleaned = cleaned.replace(/(?:^|\n)\s*[-*+]\s+(\|.+?)(?=\r?\n|$)/g, "\n$1");

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

    // 4. Markdown Tables
    const isTableSepLine = (l: string) => {
      const clean = l.trim().replace(/^[-*+]\s+/, "");
      return /^\s*\|?\s*[-:]+[-| :]*\|?\s*$/.test(clean) && /[-:]{2,}/.test(clean);
    };
    const isTableRow = (l: string) => {
      const clean = l.trim().replace(/^[-*+]\s+/, "");
      return clean.includes("|") && !/^(?:#{1,6}\s|>|```|---|\*\*\*)/.test(clean);
    };

    const cleanRow = trimmed.replace(/^[-*+]\s+/, "");
    if (isTableRow(cleanRow) && (cleanRow.startsWith("|") || (i + 1 < lines.length && isTableSepLine(lines[i + 1])))) {
      const tableLines: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
        i++;
      }

      const parsedTable = parseMarkdownTable(tableLines);
      if (parsedTable) {
        elements.push(parsedTable);
        elements.push(new Paragraph({ spacing: { after: 160 } }));
        continue;
      } else {
        for (const line of tableLines) {
          elements.push(
            new Paragraph({
              spacing: { after: 60 },
              children: parseInlineFormatting(line, 20),
            }),
          );
        }
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
  const currentDate = new Date().toISOString().split("T")[0];

  // Header / Enterprise Letterhead (only render if explicitly provided)
  const orgName = data.metadata?.["Organization Name"] || data.metadata?.["Organization"];
  const deptName = data.metadata?.["Department"] || data.metadata?.["Division"];

  if (orgName) {
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
  }

  if (deptName) {
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
  }

  // Document Title
  const docTitle =
    data.title && data.title !== "[DOCUMENT TITLE]"
      ? data.title
      : data.body?.match(/^#+\s+([^\n]+)/m)?.[1]?.trim() || "Technical Deliverable Report";
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
  // Render ONLY if metadata has explicit entries
  if (data.metadata && Object.keys(data.metadata).length > 0) {
    const metaRows: TableRow[] = [];
    const currentDate = new Date().toISOString().split("T")[0];
    const metadataMap: Record<string, string> = { ...data.metadata };
    if (!metadataMap["Date"]) {
      metadataMap["Date"] = currentDate;
    }
    const filteredEntries = Object.entries(metadataMap).filter(
      ([k]) =>
        ![
          "Organization Name",
          "Organization",
          "Department",
          "Division",
          "Prepared By Title",
          "Approved By Title",
        ].includes(k),
    );

    if (filteredEntries.length > 0) {
      const metaColWidths = [2000, 2680, 2000, 2680]; // Sum = 9360 dxa
      for (let i = 0; i < filteredEntries.length; i += 2) {
        const [k1, v1] = filteredEntries[i];
        const pair2 = filteredEntries[i + 1];

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
    }
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

  // Findings table with a generic, traceable inspection structure.
  if (data.findings && data.findings.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text: "Findings", bold: true, size: 20 })],
      }),
    );

    const findingColWidths = [1560, 1560, 1560, 1560, 1560, 1560];
    const headers = ["Identifier", "Observation", "Requirement", "Assessment", "Action", "Evidence"];
    const makeCell = (text: string, width: number, header = false) => new TableCell({
      width: { size: width, type: WidthType.DXA },
      ...(header ? { shading: { fill: "F1F5F9" } } : {}),
      margins: { top: header ? 120 : 100, bottom: header ? 120 : 100, left: 100, right: 100 },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: header ? "CBD5E1" : "E2E8F0" },
        bottom: { style: BorderStyle.SINGLE, size: header ? 6 : 4, color: header ? "94A3B8" : "E2E8F0" },
        left: { style: BorderStyle.SINGLE, size: 4, color: header ? "CBD5E1" : "E2E8F0" },
        right: { style: BorderStyle.SINGLE, size: 4, color: header ? "CBD5E1" : "E2E8F0" },
      },
      children: [new Paragraph({ children: parseInlineFormatting(text || "-", 18, header) })],
    });
    const tableHeader = new TableRow({
      tableHeader: true,
      children: headers.map((header, index) => makeCell(header, findingColWidths[index], true)),
    });
    const findingRows = data.findings.map((finding) => {
      const values = [
        finding.identifier ?? finding.item,
        finding.observation ?? finding.condition ?? finding.measurement,
        finding.requirement,
        finding.assessment ?? finding.status,
        finding.action,
        finding.evidence,
      ];
      return new TableRow({
        children: values.map((value, index) => makeCell(value || "-", findingColWidths[index])),
      });
    });

    children.push(new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: findingColWidths,
      rows: [tableHeader, ...findingRows],
    }));
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
  const isApprovalDoc = Boolean(data.metadata?.["Prepared By Title"] || data.metadata?.["Approved By Title"]);
  const bodyAlreadyHasSignoff =
    Boolean(data.body && /\b(?:sign-?off|prepared by|approved by)\b/i.test(data.body));

  if (isApprovalDoc && !bodyAlreadyHasSignoff) {
    const preparedByTitle = data.metadata?.["Prepared By Title"];
    const approvedByTitle = data.metadata?.["Approved By Title"];

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
                  ...(preparedByTitle ? [
                    new Paragraph({ children: [new TextRun({ text: "Prepared By:", bold: true, size: 18 })] }),
                    new Paragraph({ children: [new TextRun({ text: "___________________________", size: 18 })] }),
                    new Paragraph({ children: [new TextRun({ text: preparedByTitle, size: 18 })] }),
                    new Paragraph({ children: [new TextRun({ text: `Date: ${currentDate}`, size: 18 })] }),
                  ] : []),
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
                  ...(approvedByTitle ? [
                    new Paragraph({ children: [new TextRun({ text: "Approved By:", bold: true, size: 18 })] }),
                    new Paragraph({ children: [new TextRun({ text: "___________________________", size: 18 })] }),
                    new Paragraph({ children: [new TextRun({ text: approvedByTitle, size: 18 })] }),
                    new Paragraph({ children: [new TextRun({ text: `Date: ${currentDate}`, size: 18 })] }),
                  ] : []),
                ],
              }),
            ],
          }),
        ],
      }),
    );
  }

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

  // Staging -> Verification -> Promotion lifecycle
  const tempName = `staging-${randomUUID()}-${name}`;
  writeRunFile(runId, "intermediate", tempName, buffer, true);
  const tempPath = resolveRunPath(runId, `intermediate/${tempName}`, "intermediate");

  const verification = await verifyArtifactFile(tempPath, {
    runId,
    expectedKind: "docx",
  });

  if (!verification.valid) {
    try { rmSync(tempPath, { force: true }); } catch {}
    throw new Error(`Artifact verification failed for DOCX "${name}": ${verification.details.error}`);
  }

  const rel = writeRunFile(runId, "output", name, buffer, true);
  try { rmSync(tempPath, { force: true }); } catch {}

  const art = artifactRef(runId, "docx", name, rel);
  art.verified = true;
  art.verificationDetails = verification.details;
  return art;
}
