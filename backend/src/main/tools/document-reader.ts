import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface PdfPageText {
  pageNumber: number;
  text: string;
}

export interface PdfTextResult {
  text: string;
  pages: PdfPageText[];
  numPages: number;
  hasText: boolean;
  totalChars: number;
}

export interface DocxTextResult {
  text: string;
  hasText: boolean;
  totalChars: number;
}

export interface DocumentContentResult {
  text: string;
  format: "pdf" | "docx" | "unknown";
  hasText: boolean;
  pageCount?: number;
  summary: string;
}

async function loadPdfJs(): Promise<any> {
  try {
    const legacy: any = await import(/* @vite-ignore */ "pdfjs-dist/legacy/build/pdf.mjs");
    if (legacy && (typeof legacy.getDocument === "function" || typeof legacy.default?.getDocument === "function")) {
      return typeof legacy.default?.getDocument === "function" ? legacy.default : legacy;
    }
  } catch {}

  try {
    const standard: any = await import(/* @vite-ignore */ "pdfjs-dist");
    return typeof standard.default?.getDocument === "function" ? standard.default : standard;
  } catch {}

  return null;
}

async function loadJSZip(): Promise<any> {
  const mod = await import("jszip");
  return mod.default || mod;
}

export function isPdfFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".pdf";
}

export function isDocxFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".docx" || ext === ".doc";
}

export function isTextExtractableDocument(filePath: string): boolean {
  return isPdfFile(filePath) || isDocxFile(filePath);
}

function unescapeXml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Parse OpenXML document.xml into clean, structured Markdown text.
 */
export function parseDocxXml(rawXml: string): string {
  if (!rawXml || typeof rawXml !== "string") return "";

  // Match top-level paragraphs and tables in order of appearance
  const blockRegex = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  const blocks = rawXml.match(blockRegex) || [];
  const outputBlocks: string[] = [];

  for (const block of blocks) {
    if (block.startsWith("<w:tbl")) {
      const rows = block.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
      if (rows.length === 0) continue;

      const rowStrings: string[] = [];
      let headerColumnCount = 0;

      rows.forEach((trXml, rowIdx) => {
        const cells = trXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [];
        const cellTexts = cells.map((tcXml) => {
          const textRuns = tcXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
          const cellStr = textRuns
            .map((t) => unescapeXml(t.replace(/<[^>]+>/g, "")))
            .join("")
            .replace(/\s+/g, " ")
            .trim();
          return cellStr || " ";
        });

        if (rowIdx === 0) {
          headerColumnCount = cellTexts.length;
          rowStrings.push(`| ${cellTexts.join(" | ")} |`);
          rowStrings.push(`| ${cellTexts.map(() => "---").join(" | ")} |`);
        } else {
          while (cellTexts.length < headerColumnCount) {
            cellTexts.push(" ");
          }
          rowStrings.push(`| ${cellTexts.join(" | ")} |`);
        }
      });

      if (rowStrings.length > 0) {
        outputBlocks.push(rowStrings.join("\n"));
      }
    } else {
      let clean = block.replace(/<w:br[^>]*\/>/g, "\n");
      clean = clean.replace(/<w:tab[^>]*\/>/g, "\t");
      const textRuns = clean.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
      const pText = textRuns
        .map((t) => unescapeXml(t.replace(/<[^>]+>/g, "")))
        .join("")
        .trim();

      if (pText.length > 0) {
        outputBlocks.push(pText);
      }
    }
  }

  return outputBlocks.join("\n\n").trim();
}

/**
 * Extract clean text and markdown tables from a DOCX file buffer or path.
 */
export async function extractDocxText(filePathOrBuffer: string | Buffer): Promise<DocxTextResult> {
  let buffer: Buffer;
  if (typeof filePathOrBuffer === "string") {
    if (!existsSync(filePathOrBuffer)) {
      throw new Error(`DOCX file not found: ${filePathOrBuffer}`);
    }
    buffer = readFileSync(filePathOrBuffer);
  } else {
    buffer = filePathOrBuffer;
  }

  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buffer);

  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    throw new Error("Invalid DOCX format: word/document.xml not found");
  }

  const xml = await docFile.async("text");
  const extractedText = parseDocxXml(xml);

  const totalChars = extractedText.length;
  const hasText = totalChars >= 10;

  return {
    text: extractedText,
    hasText,
    totalChars,
  };
}

/**
 * Extract page-by-page text from a PDF file buffer or path using pdfjs-dist.
 */
export async function extractPdfText(filePathOrBuffer: string | Buffer): Promise<PdfTextResult> {
  let buffer: Buffer;
  if (typeof filePathOrBuffer === "string") {
    if (!existsSync(filePathOrBuffer)) {
      throw new Error(`PDF file not found: ${filePathOrBuffer}`);
    }
    buffer = readFileSync(filePathOrBuffer);
  } else {
    buffer = filePathOrBuffer;
  }

  const pdfjs = await loadPdfJs();
  if (!pdfjs) {
    throw new Error("PDF processing engine (pdfjs-dist) could not be loaded");
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  const numPages = doc.numPages;
  const pages: PdfPageText[] = [];
  let totalChars = 0;

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items || [];

    // Reconstruct lines by observing text positions or item breaks
    const textPieces: string[] = [];
    for (const item of items) {
      if (typeof item.str === "string") {
        textPieces.push(item.str);
        if (item.hasEOL) {
          textPieces.push("\n");
        }
      }
    }

    const pageRawText = textPieces.join(" ").replace(/ \n /g, "\n").replace(/ \n/g, "\n").replace(/\n /g, "\n");
    // Normalize excess whitespace while preserving paragraph/table linebreaks
    const cleanedPageText = pageRawText
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
      .join("\n")
      .trim();

    totalChars += cleanedPageText.length;
    pages.push({
      pageNumber: i,
      text: cleanedPageText,
    });
  }

  // Format combined text with clear page delineation
  const pageSections = pages
    .filter((p) => p.text.length > 0)
    .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`);

  const combinedText = pageSections.join("\n\n");
  const hasText = totalChars >= 20;

  return {
    text: combinedText,
    pages,
    numPages,
    hasText,
    totalChars,
  };
}

/**
 * Universal document content extractor.
 * Automatically identifies file type and returns clean text representation.
 */
export async function readDocumentContent(filePath: string): Promise<DocumentContentResult> {
  const base = path.basename(filePath);

  if (isPdfFile(filePath)) {
    const pdfRes = await extractPdfText(filePath);
    if (!pdfRes.hasText) {
      return {
        text: `[Document: ${base} (PDF with ${pdfRes.numPages} pages)]\n[Note: This PDF appears to be a scanned document with no digital text layer. To inspect visual findings, diagrams, or handwritten notes, invoke the extract_document tool.]`,
        format: "pdf",
        hasText: false,
        pageCount: pdfRes.numPages,
        summary: `Read "${base}" (PDF, ${pdfRes.numPages} pages, scanned/no text layer)`,
      };
    }
    const formatted = `[Document: ${base} (PDF, ${pdfRes.numPages} pages, ${pdfRes.totalChars} characters)]\n\n${pdfRes.text}`;
    return {
      text: formatted,
      format: "pdf",
      hasText: true,
      pageCount: pdfRes.numPages,
      summary: `Read "${base}" (PDF, ${pdfRes.numPages} pages, ${pdfRes.totalChars} chars)`,
    };
  }

  if (isDocxFile(filePath)) {
    const docxRes = await extractDocxText(filePath);
    if (!docxRes.hasText) {
      return {
        text: `[Document: ${base} (Word document, empty or no text content)]`,
        format: "docx",
        hasText: false,
        summary: `Read "${base}" (Word document, empty)`,
      };
    }
    const formatted = `[Document: ${base} (Word document, ${docxRes.totalChars} characters)]\n\n${docxRes.text}`;
    return {
      text: formatted,
      format: "docx",
      hasText: true,
      summary: `Read "${base}" (Word document, ${docxRes.totalChars} chars)`,
    };
  }

  return {
    text: "",
    format: "unknown",
    hasText: false,
    summary: `Read "${base}" (unsupported document format)`,
  };
}
