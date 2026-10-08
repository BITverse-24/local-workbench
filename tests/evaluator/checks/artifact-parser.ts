import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { inflateRawSync } from "node:zlib";
import { containedFile } from "../../helpers/files.js";

function decodeXML(text: string): string { return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
function documentText(xml: string): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset < xml.length) {
    const tag = xml.indexOf("<", offset);
    if (tag < 0) { parts.push(xml.slice(offset)); break; }
    parts.push(xml.slice(offset, tag));
    const end = xml.indexOf(">", tag + 1);
    if (end < 0 || xml.indexOf("<", tag + 1) >= 0 && xml.indexOf("<", tag + 1) < end) throw new Error("Malformed DOCX XML");
    const name = xml.slice(tag + 1, end);
    if (name === "/w:p") parts.push("\n"); else if (name === "/w:tc") parts.push("\t");
    offset = end + 1;
  }
  return decodeXML(parts.join("")).trim();
}
// Validate and bounded-inflate every member before handing adversarial ZIP bytes
// to document libraries. A compressed-size check alone does not prevent ZIP bombs.
function validateArchive(bytes: Buffer): void {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("Invalid document archive");
  const count = bytes.readUInt16LE(end + 10);
  if (count > 4096 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error("Unsupported or oversized document archive");
  let offset = bytes.readUInt32LE(end + 16), total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid archive directory");
    const method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24), local = bytes.readUInt32LE(offset + 42);
    total += expanded;
    if (expanded > 8 * 1024 ** 2 || total > 32 * 1024 ** 2 || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("Expanded artifact exceeds parser limit");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > offset || ![0, 8].includes(method)) throw new Error("Unsupported archive member");
    const raw = bytes.subarray(start, start + compressed);
    const data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: 8 * 1024 ** 2 });
    if (data.length !== expanded) throw new Error("Archive member size mismatch");
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name.startsWith("xl/") && name.endsWith(".xml") && (data.toString("utf8").match(/<c\b|<si\b/g)?.length ?? 0) > 100000) throw new Error("Spreadsheet cell limit exceeded");
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
}
export async function parseArtifact(root: string, relative: string): Promise<string> {
  const file = containedFile(root, relative);
  const bytes = readFileSync(file);
  if (!bytes.length) throw new Error("Empty artifact");
  if (bytes.length > 32 * 1024 ** 2) throw new Error("Artifact size exceeds parser limit");
  const extension = path.extname(file).toLowerCase();
  if ([".docx", ".xlsx"].includes(extension)) validateArchive(bytes);
  if (extension === ".docx") {
    const zip = await JSZip.loadAsync(bytes);
    const document = zip.file("word/document.xml");
    if (!document) throw new Error("DOCX missing document.xml");
    const xml = await document.async("string");
    if (xml.length > 32 * 1024 ** 2) throw new Error("Expanded artifact exceeds parser limit");
    const text = documentText(xml);
    if (!text) throw new Error("Empty DOCX deliverable");
    return text;
  }
  if (extension === ".xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as never);
    if (!workbook.worksheets.some((sheet) => sheet.actualRowCount > 0)) throw new Error("Empty XLSX deliverable");
    return workbook.worksheets.map((sheet) => {
      const rows: unknown[] = [];
      sheet.eachRow((row) => rows.push(row.values));
      return JSON.stringify({ sheet: sheet.name, rows });
    }).join("\n");
  }
  if ([".md", ".txt", ".csv", ".json", ".py"].includes(extension)) return bytes.toString("utf8");
  throw new Error(`Unsupported artifact parser: ${extension}`);
}
