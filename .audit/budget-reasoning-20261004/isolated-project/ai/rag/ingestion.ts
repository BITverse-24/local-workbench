// Polyfill Promise.try for Node.js < 22 environments (Electron 30 is Node 20.16)
if (typeof (Promise as any).try !== "function") {
  (Promise as any).try = function <T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T> {
    return new Promise((resolve) => resolve(fn(...args)));
  };
}

import { DocumentRecord, ChunkRecord } from "./types.js";
import { chunkDocument } from "./chunker.js";
import { RAGDatabase } from "./db.js";
import { EmbeddingService } from "./embedding.js";
import fs from "node:fs/promises";
import path from "node:path";

async function loadPdfJs(): Promise<any> {
  try {
    const legacy: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (legacy && (typeof legacy.getDocument === "function" || typeof legacy.default?.getDocument === "function")) {
      return typeof legacy.default?.getDocument === "function" ? legacy.default : legacy;
    }
  } catch {}

  try {
    const standard: any = await import("pdfjs-dist");
    return typeof standard.default?.getDocument === "function" ? standard.default : standard;
  } catch {}

  return null;
}

export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
}

export interface PdfExtractionResult {
  numPages: number;
  pages: ExtractedPdfPage[];
}

// Helper function to extract page-by-page text from a local PDF file
async function extractPagesFromPDF(filePath: string): Promise<PdfExtractionResult> {
  const data = await fs.readFile(filePath);
  const pdfjs = await loadPdfJs();
  if (!pdfjs) {
    throw new Error(`PDF processing engine (pdfjs-dist) could not be loaded for "${path.basename(filePath)}"`);
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
  });

  try {
    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    const pages: ExtractedPdfPage[] = [];

    for (let i = 1; i <= numPages; i++) {
      try {
        const page = await pdf.getPage(i);
        try {
          const content = await page.getTextContent();
          const textPieces: string[] = [];
          for (const item of (content.items || []) as any[]) {
            if (typeof item?.str === "string") {
              textPieces.push(item.str);
              if (item.hasEOL) {
                textPieces.push("\n");
              }
            }
          }
          const pageText = textPieces
            .join(" ")
            .replace(/ \n /g, "\n")
            .replace(/ \n/g, "\n")
            .replace(/\n /g, "\n")
            .trim();

          if (pageText.length > 0) {
            pages.push({ pageNumber: i, text: pageText });
          }
        } finally {
          page.cleanup?.();
        }
      } catch (pageErr) {
        console.warn(`[rag:ingestion] Warning: skipping unreadable page ${i} in "${path.basename(filePath)}":`, pageErr);
      }
    }
    pdf.cleanup?.();
    return { numPages, pages };
  } finally {
    await loadingTask.destroy?.();
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function extractDocxText(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  const JSZipMod = await import("jszip");
  const JSZip = (JSZipMod as any).default || JSZipMod;
  const zip = await JSZip.loadAsync(data);
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    throw new Error(`Invalid DOCX format in "${path.basename(filePath)}": word/document.xml not found`);
  }
  const xml = await docFile.async("text");
  const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
  const extracted: string[] = [];
  for (const p of paragraphs) {
    const textRuns = p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
    const pText = decodeXmlEntities(
      textRuns
        .map((t: string) => t.replace(/<[^>]+>/g, ""))
        .join("")
        .trim(),
    );
    if (pText) extracted.push(pText);
  }
  return extracted.join("\n\n");
}


export class IngestionPipeline {
  constructor(private embeddingService: EmbeddingService) {}

  async ingestDocument(doc: DocumentRecord, filePath: string): Promise<number> {
    const rawChunks: Omit<ChunkRecord, "embedding">[] = [];
    const lower = filePath.toLowerCase();

    if (lower.endsWith(".pdf")) {
      const { numPages, pages } = await extractPagesFromPDF(filePath);
      doc.page_count = numPages;
      let chunkSeq = 1;
      for (const page of pages) {
        const pageChunks = chunkDocument(doc, page.text, page.pageNumber);
        for (const c of pageChunks) {
          c.chunk_id = `${doc.doc_id}-p${page.pageNumber}-${chunkSeq++}`;
          rawChunks.push(c);
        }
      }
    } else if (lower.endsWith(".docx") || lower.endsWith(".doc")) {
      const text = await extractDocxText(filePath);
      doc.page_count = doc.page_count || 1;
      const chunks = chunkDocument(doc, text, 1);
      let chunkSeq = 1;
      for (const c of chunks) {
        c.chunk_id = `${doc.doc_id}-p1-${chunkSeq++}`;
        rawChunks.push(c);
      }
    } else {
      const buf = await fs.readFile(filePath);
      let text = "";

      // Check for BOMs (UTF-16 LE / UTF-8)
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        text = buf.subarray(2).toString("utf16le");
      } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        text = buf.subarray(3).toString("utf-8");
      } else {
        // Guard against arbitrary binary files (check first 1024 bytes for null character)
        const sample = buf.subarray(0, Math.min(buf.length, 1024));
        if (sample.includes(0)) {
          throw new Error(`Cannot ingest binary file "${path.basename(filePath)}". Supported formats: PDF, DOCX, Markdown, Text, CSV, JSON.`);
        }
        text = buf.toString("utf-8");
      }

      doc.page_count = doc.page_count || 1;
      const chunks = chunkDocument(doc, text, 1);
      let chunkSeq = 1;
      for (const c of chunks) {
        c.chunk_id = `${doc.doc_id}-p1-${chunkSeq++}`;
        rawChunks.push(c);
      }
    }

    if (rawChunks.length === 0) {
      // Still record the document record so it appears in listDocuments
      const sqlite = RAGDatabase.getSqlite();
      const upsertDocStmt = sqlite.prepare(`
        INSERT OR REPLACE INTO documents (
          doc_id, title, source_path, doc_type, department, effective_date, indexed_at, page_count, ocr_used, chunk_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      upsertDocStmt.run(
        doc.doc_id,
        doc.title,
        doc.source_path,
        doc.doc_type,
        doc.department,
        doc.effective_date,
        doc.indexed_at || new Date().toISOString(),
        doc.page_count,
        doc.ocr_used ? 1 : 0,
        0
      );
      return 0;
    }

    // Embed chunks in batches to not overload the API
    try {
      const batchSize = 10;
      for (let i = 0; i < rawChunks.length; i += batchSize) {
        const batch = rawChunks.slice(i, i + batchSize);
        const texts = batch.map((c) => c.text);
        const embeddings = await this.embeddingService.embedBatch(texts);

        batch.forEach((c, idx) => {
          (c as any).embedding = embeddings[idx];
        });
      }
    } catch (err) {
      // Offline / air-gapped fallback: continue with SQLite FTS indexing
      console.warn(`[rag:ingestion] Embedding generation skipped/failed (offline fallback to FTS5):`, err);
    }

    const sqlite = RAGDatabase.getSqlite();
    const vectra = RAGDatabase.getVectra();

    // Delete existing document chunks if this is a re-index
    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM chunks_fts WHERE doc_id = ?").run(doc.doc_id);
      const insertStmt = sqlite.prepare(`
        INSERT INTO chunks_fts (chunk_id, text, doc_id, section_label, page)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const c of rawChunks) {
        insertStmt.run(c.chunk_id, c.text, c.doc_id, c.section_label, c.page);
      }
    })();

    try {
      const existing = await vectra.listItemsByMetadata({ doc_id: { $eq: doc.doc_id } });
      if (existing.length > 0) {
        await vectra.deleteItems(existing.map((i) => i.id));
      }
    } catch {}

    // Upsert document record in SQLite
    const upsertDocStmt = sqlite.prepare(`
      INSERT OR REPLACE INTO documents (
        doc_id, title, source_path, doc_type, department, effective_date, indexed_at, page_count, ocr_used, chunk_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    upsertDocStmt.run(
      doc.doc_id,
      doc.title,
      doc.source_path,
      doc.doc_type,
      doc.department,
      doc.effective_date,
      doc.indexed_at || new Date().toISOString(),
      doc.page_count,
      doc.ocr_used ? 1 : 0,
      rawChunks.length
    );

    // Write to Vectra if embeddings are present
    const hasEmbeddings = rawChunks.some((c) => (c as any).embedding && (c as any).embedding.length > 0);
    if (hasEmbeddings) {
      await vectra.beginUpdate();
      try {
        for (const c of rawChunks) {
          if ((c as any).embedding && (c as any).embedding.length > 0) {
            await vectra.insertItem({
              id: c.chunk_id,
              vector: (c as any).embedding,
              metadata: {
                doc_id: c.doc_id,
                section_label: c.section_label,
                section_title: c.section_title || "",
                page: c.page,
                text: c.text,
              },
            });
          }
        }
        await vectra.endUpdate();
      } catch (vectraErr) {
        console.warn("[rag:ingestion] Vectra index update error:", vectraErr);
        try {
          await vectra.endUpdate();
        } catch {}
      }
    }

    return rawChunks.length;
  }

  async deleteDocument(docId: string): Promise<void> {
    const sqlite = RAGDatabase.getSqlite();
    const vectra = RAGDatabase.getVectra();

    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM documents WHERE doc_id = ?").run(docId);
      sqlite.prepare("DELETE FROM chunks_fts WHERE doc_id = ?").run(docId);
    })();

    try {
      const existing = await vectra.listItemsByMetadata({ doc_id: { $eq: docId } });
      if (existing.length > 0) {
        await vectra.deleteItems(existing.map((i) => i.id));
      }
    } catch (vectraErr) {
      console.warn(`[rag:ingestion] Vectra items deletion warning for doc ${docId}:`, vectraErr);
    }
  }
}

