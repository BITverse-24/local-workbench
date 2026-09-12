import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
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

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseFormattedRuns(text: string): string {
  const tokens: Array<{ text: string; bold?: boolean; code?: boolean; italic?: boolean }> = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, match.index) });
    }
    const chunk = match[0];
    if (chunk.startsWith("**") && chunk.endsWith("**")) {
      tokens.push({ text: chunk.slice(2, -2), bold: true });
    } else if (chunk.startsWith("`") && chunk.endsWith("`")) {
      tokens.push({ text: chunk.slice(1, -1), code: true });
    } else if (chunk.startsWith("*") && chunk.endsWith("*")) {
      tokens.push({ text: chunk.slice(1, -1), italic: true });
    } else {
      tokens.push({ text: chunk });
    }
    lastIndex = match.index + chunk.length;
  }
  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex) });
  }

  return tokens
    .map((t) => {
      const rPr = [
        t.bold ? "<w:b/><w:bCs/>" : "",
        t.italic ? "<w:i/><w:iCs/>" : "",
        t.code
          ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/><w:color w:val="0F172A"/>'
          : "",
      ].filter(Boolean).join("");

      return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(t.text)}</w:t></w:r>`;
    })
    .join("");
}

function parseMarkdownTable(rows: string[]): string {
  const parsedRows = rows
    .map((r) =>
      r
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
    )
    .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c)));

  if (parsedRows.length === 0) return "";

  const colCount = Math.max(...parsedRows.map((r) => r.length));
  const colWidth = Math.floor(9000 / colCount);

  const trXml = parsedRows
    .map((row, rowIdx) => {
      const isHeader = rowIdx === 0;
      const tcXml = row
        .map((cell) => {
          const shd = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="1E293B"/>' : '<w:shd w:val="clear" w:color="auto" w:fill="FFFFFF"/>';
          return `
            <w:tc>
              <w:tcPr>
                <w:tcW w:w="${colWidth}" w:type="dxa"/>
                ${shd}
                <w:tcMar>
                  <w:top w:w="120" w:type="dxa"/>
                  <w:left w:w="160" w:type="dxa"/>
                  <w:bottom w:w="120" w:type="dxa"/>
                  <w:right w:w="160" w:type="dxa"/>
                </w:tcMar>
              </w:tcPr>
              <w:p>
                ${isHeader
                  ? `<w:r><w:rPr><w:color w:val="FFFFFF"/><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r>`
                  : parseFormattedRuns(cell)}
              </w:p>
            </w:tc>
          `;
        })
        .join("");

      return `
        <w:tr>
          <w:trPr>
            ${isHeader ? "<w:tblHeader/>" : ""}
          </w:trPr>
          ${tcXml}
        </w:tr>
      `;
    })
    .join("");

  return `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="9000" w:type="dxa"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="6" w:space="0" w:color="94A3B8"/>
          <w:left w:val="none"/>
          <w:bottom w:val="single" w:sz="6" w:space="0" w:color="94A3B8"/>
          <w:right w:val="none"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E2E8F0"/>
          <w:insideV w:val="none"/>
        </w:tblBorders>
      </w:tblPr>
      ${trXml}
    </w:tbl>
  `;
}

/**
 * Generates an authoritative, publication-grade binary Office Open XML (.docx) Word document.
 */
export async function generateDocx(
  runId: string,
  content: string,
  requestedFilename?: string,
): Promise<ArtifactRef> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );

  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:color w:val="1E293B"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="160" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr>
      <w:spacing w:before="360" w:after="140"/>
    </w:pPr>
    <w:rPr>
      <w:b/><w:bCs/>
      <w:color w:val="0F172A"/>
      <w:sz w:val="32"/>
      <w:szCs w:val="32"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr>
      <w:spacing w:before="260" w:after="100"/>
    </w:pPr>
    <w:rPr>
      <w:b/><w:bCs/>
      <w:color w:val="1E293B"/>
      <w:sz w:val="26"/>
      <w:szCs w:val="26"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:pPr>
      <w:spacing w:before="200" w:after="80"/>
    </w:pPr>
    <w:rPr>
      <w:b/><w:bCs/>
      <w:color w:val="334155"/>
      <w:sz w:val="24"/>
      <w:szCs w:val="24"/>
    </w:rPr>
  </w:style>
</w:styles>`,
  );

  // Parse lines into Word XML elements
  const lines = content.split(/\r?\n/);
  const bodyXml: string[] = [];

  // Top Formal Engineering Letterhead
  bodyXml.push(`
    <w:p>
      <w:pPr>
        <w:pBdr>
          <w:bottom w:val="single" w:sz="16" w:space="8" w:color="0284C7"/>
        </w:pBdr>
        <w:spacing w:after="240"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>
          <w:b/><w:bCs/>
          <w:sz w:val="28"/><w:szCs w:val="28"/>
          <w:color w:val="0369A1"/>
        </w:rPr>
        <w:t>SOVEREIGN WORKBENCH</w:t>
      </w:r>
      <w:r>
        <w:rPr>
          <w:sz w:val="18"/><w:szCs w:val="18"/>
          <w:color w:val="64748B"/>
        </w:rPr>
        <w:t xml:space="preserve">   |   AIR-GAPPED COMPLIANCE DELIVERABLE   |   ZERO NETWORK EGRESS</w:t>
      </w:r>
    </w:p>
  `);

  let inTable = false;
  let tableBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Check table rows
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      inTable = true;
      tableBuffer.push(trimmed);
      continue;
    } else if (inTable) {
      bodyXml.push(parseMarkdownTable(tableBuffer));
      tableBuffer = [];
      inTable = false;
    }

    if (!trimmed) {
      bodyXml.push('<w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>');
      continue;
    }

    // Heading 1 (# ...)
    if (trimmed.startsWith("# ")) {
      const text = trimmed.slice(2);
      bodyXml.push(`
        <w:p>
          <w:pPr>
            <w:pStyle w:val="Heading1"/>
          </w:pPr>
          ${parseFormattedRuns(text)}
        </w:p>
      `);
      continue;
    }

    // Heading 2 (## ...)
    if (trimmed.startsWith("## ")) {
      const text = trimmed.slice(3);
      bodyXml.push(`
        <w:p>
          <w:pPr>
            <w:pStyle w:val="Heading2"/>
          </w:pPr>
          ${parseFormattedRuns(text)}
        </w:p>
      `);
      continue;
    }

    // Heading 3 (### ...)
    if (trimmed.startsWith("### ")) {
      const text = trimmed.slice(4);
      bodyXml.push(`
        <w:p>
          <w:pPr>
            <w:pStyle w:val="Heading3"/>
          </w:pPr>
          ${parseFormattedRuns(text)}
        </w:p>
      `);
      continue;
    }

    // Bullet points (- ... or * ...)
    if (/^[-*]\s+/.test(trimmed)) {
      const text = trimmed.replace(/^[-*]\s+/, "");
      bodyXml.push(`
        <w:p>
          <w:pPr>
            <w:ind w:left="400"/>
            <w:spacing w:after="100"/>
          </w:pPr>
          <w:r>
            <w:rPr>
              <w:color w:val="0284C7"/>
              <w:b/>
            </w:rPr>
            <w:t xml:space="preserve">•  </w:t>
          </w:r>
          ${parseFormattedRuns(text)}
        </w:p>
      `);
      continue;
    }

    // Callout box / Warnings (lines with ⚠️, WARNING, Missing Information)
    if (trimmed.includes("⚠️") || /\b(warning|missing information|alert)\b/i.test(trimmed)) {
      bodyXml.push(`
        <w:p>
          <w:pPr>
            <w:pBdr>
              <w:left w:val="single" w:sz="24" w:space="12" w:color="F59E0B"/>
            </w:pBdr>
            <w:shd w:val="clear" w:color="auto" w:fill="FFFBEB"/>
            <w:spacing w:before="120" w:after="120"/>
            <w:ind w:left="200" w:right="200"/>
          </w:pPr>
          ${parseFormattedRuns(trimmed)}
        </w:p>
      `);
      continue;
    }

    // Standard paragraph
    bodyXml.push(`
      <w:p>
        <w:pPr>
          <w:spacing w:after="160" w:line="276" w:lineRule="auto"/>
        </w:pPr>
        ${parseFormattedRuns(trimmed)}
      </w:p>
    `);
  }

  if (inTable && tableBuffer.length > 0) {
    bodyXml.push(parseMarkdownTable(tableBuffer));
  }

  // Footer / Attestation Block
  bodyXml.push(`
    <w:p>
      <w:pPr>
        <w:pBdr>
          <w:top w:val="single" w:sz="6" w:space="8" w:color="CBD5E1"/>
        </w:pBdr>
        <w:spacing w:before="360" w:after="120"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:sz w:val="18"/><w:szCs w:val="18"/>
          <w:color w:val="94A3B8"/>
        </w:rPr>
        <w:t xml:space="preserve">Deliverable generated under air-gapped governance. Verified by Sovereign Workbench.</w:t>
      </w:r>
    </w:p>
  `);

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml.join("\n")}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  zip.file("word/document.xml", docXml);

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  let candidate = requestedFilename?.trim() || "approval-note.docx";
  if (!/\.docx$/i.test(candidate)) {
    candidate = candidate.replace(/\.[^.]+$/, "") + ".docx";
  }
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*\.docx$/i.test(candidate) ? candidate : "approval-note.docx";

  const rel = writeRunFile(runId, "output", name, buffer, true);
  return artifactRef(runId, "docx", name, rel);
}

