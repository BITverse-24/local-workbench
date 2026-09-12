import { DocumentRecord } from "./types.js";
import { chunkDocument } from "./chunker.js";
import { RAGDatabase } from "./db.js";
import { EmbeddingService } from "./embedding.js";
import fs from "node:fs/promises";
// Helper function to extract text from a local PDF file
async function extractTextFromPDF(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  try {
    const pdfjs: any = await import("pdfjs-dist");
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;

    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => item.str).join(" ");
      fullText += text + "\n\n";
    }
    return fullText;
  } catch {
    return data.toString("utf8");
  }
}


export class IngestionPipeline {
  constructor(private embeddingService: EmbeddingService) {}

  async ingestDocument(doc: DocumentRecord, filePath: string): Promise<number> {
    // Basic text extraction based on file extension
    let text = "";
    if (filePath.endsWith(".pdf")) {
      text = await extractTextFromPDF(filePath);
    } else {
      text = await fs.readFile(filePath, "utf-8");
    }

    // Since chunkDocument takes text and pageNumber for basic chunks,
    // we use a single string here to chunk by structure.
    // In a real PDF, we'd map text back to pages, but for MVP we approximate
    // or just pass 1 for text files.
    const rawChunks = chunkDocument(doc, text, 1);

    if (rawChunks.length === 0) {
      return 0;
    }

    // Embed chunks in batches to not overload the API
    try {
      const batchSize = 10;
      for (let i = 0; i < rawChunks.length; i += batchSize) {
        const batch = rawChunks.slice(i, i + batchSize);
        const texts = batch.map(c => c.text);
        const embeddings = await this.embeddingService.embedBatch(texts);

        batch.forEach((c, idx) => {
          (c as any).embedding = embeddings[idx];
        });
      }
    } catch (err) {
      // Offline / air-gapped fallback: continue with SQLite FTS indexing
    }

    const sqlite = RAGDatabase.getSqlite();
    const vectra = RAGDatabase.getVectra();

    // Delete existing document chunks if this is a re-index
    sqlite.prepare("DELETE FROM chunks_fts WHERE doc_id = ?").run(doc.doc_id);
    const existing = await vectra.listItemsByMetadata({ doc_id: { $eq: doc.doc_id } });
    if (existing.length > 0) {
      await vectra.deleteItems(existing.map(i => i.id));
    }

    // Write to SQLite FTS
    const insertStmt = sqlite.prepare(`
      INSERT INTO chunks_fts (chunk_id, text, doc_id, section_label, page)
      VALUES (?, ?, ?, ?, ?)
    `);

    sqlite.transaction(() => {
      for (const c of rawChunks) {
        insertStmt.run(c.chunk_id, c.text, c.doc_id, c.section_label, c.page);
      }
    })();

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
    const hasEmbeddings = rawChunks.some(c => (c as any).embedding);
    if (hasEmbeddings) {
      await vectra.beginUpdate();
      for (const c of rawChunks) {
        if ((c as any).embedding) {
          await vectra.insertItem({
            id: c.chunk_id,
            vector: (c as any).embedding,
            metadata: {
              doc_id: c.doc_id,
              section_label: c.section_label,
              section_title: c.section_title || "",
              page: c.page,
              text: c.text
            }
          });
        }
      }
      await vectra.endUpdate();
    }

    return rawChunks.length;
  }

  async deleteDocument(docId: string): Promise<void> {
    const sqlite = RAGDatabase.getSqlite();
    const vectra = RAGDatabase.getVectra();

    sqlite.prepare("DELETE FROM documents WHERE doc_id = ?").run(docId);
    sqlite.prepare("DELETE FROM chunks_fts WHERE doc_id = ?").run(docId);

    const existing = await vectra.listItemsByMetadata({ doc_id: { $eq: docId } });
    if (existing.length > 0) {
      await vectra.deleteItems(existing.map(i => i.id));
    }
  }
}

