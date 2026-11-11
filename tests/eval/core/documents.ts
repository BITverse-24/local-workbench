import JSZip from "jszip";
import ExcelJS from "exceljs";

export interface ParsedDoc {
  text: string;
  rows?: Array<Record<string, string>>;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function tableRows(matrix: string[][]): Array<Record<string, string>> {
  if (matrix.length < 2) return [];
  const header = matrix[0].map((h) => h.trim());
  return matrix.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

function decode(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function paragraphText(xml: string): string {
  return decode(xml.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<[^>]*>/g, ""));
}

function docxTables(xml: string): string[][][] {
  const tables: string[][][] = [];
  for (const tbl of xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
    const rows = (tbl.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []).map((tr) =>
      (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((tc) => paragraphText(tc).replace(/\s+/g, " ").trim()),
    );
    tables.push(rows);
  }
  return tables;
}

export async function parseDeliverable(filename: string, bytes: Uint8Array): Promise<ParsedDoc> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docx")) {
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file("word/document.xml");
    if (!entry) throw new Error("docx has no word/document.xml");
    const xml = await entry.async("string");
    const text = paragraphText(xml);
    const tables = docxTables(xml);
    // Expose every table's rows (keyed by its first row) so facts can target them.
    const rows = tables.flatMap((table) => tableRows(table));
    return { text, rows: rows.length ? rows : undefined };
  }
  if (lower.endsWith(".xlsx")) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("xlsx has no worksheet");
    const matrix: string[][] = [];
    sheet.eachRow((row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      matrix.push(values.map((v) => (v == null ? "" : typeof v === "object" && "result" in (v as object) ? String((v as { result: unknown }).result) : String(v))));
    });
    return { text: matrix.map((r) => r.join("\t")).join("\n"), rows: tableRows(matrix) };
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (lower.endsWith(".csv")) return { text, rows: tableRows(parseCsv(text)) };
  if (lower.endsWith(".json")) {
    JSON.parse(text);
    return { text };
  }
  return { text };
}

export function parseNumber(value: string): number {
  return Number(value.replace(/[$,%\s]/g, "").replace(/,/g, ""));
}
