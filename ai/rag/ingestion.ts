import { DocumentRecord } from "./types.js";
import { chunkDocument } from "./chunker.js";
import { RAGDatabase } from "./db.js";
import { EmbeddingService } from "./embedding.js";
import fs from "fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.js";

// Helper function to extract text from a local PDF file
async function extractTextFromPDF(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;

  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item: any) => item.str).join(" ");
    fullText += text + "\n\n";
  }
  return fullText;
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
    const batchSize = 10;
    for (let i = 0; i < rawChunks.length; i += batchSize) {
      const batch = rawChunks.slice(i, i + batchSize);
      const texts = batch.map(c => c.text);
      const embeddings = await this.embeddingService.embedBatch(texts);

      batch.forEach((c, idx) => {
        (c as any).embedding = embeddings[idx];
      });
    }

    const sqlite = RAGDatabase.getSqlite();
    const chroma = RAGDatabase.getChroma();

    // Delete existing document chunks if this is a re-index
    sqlite.prepare("DELETE FROM chunks_fts WHERE doc_id = ?").run(doc.doc_id);
    await chroma.delete({ where: { doc_id: doc.doc_id } });

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

    // Write to Chroma
    const ids = rawChunks.map(c => c.chunk_id);
    const embeddings = rawChunks.map(c => (c as any).embedding);
    const metadatas = rawChunks.map(c => ({
      doc_id: c.doc_id,
      section_label: c.section_label,
      page: c.page
    }));
    const documents = rawChunks.map(c => c.text);

    await chroma.add({
      ids,
      embeddings,
      metadatas,
      documents
    });

    return rawChunks.length;
  }
}
