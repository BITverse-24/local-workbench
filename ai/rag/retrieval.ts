import { RAGDatabase } from "./db.js";
import { EmbeddingService } from "./embedding.js";
import { RetrievalResult } from "./types.js";

interface ScoredItem {
  id: string;
  score: number; // For internal ranking
  data: any;
}

export class RetrievalPipeline {
  constructor(private embeddingService: EmbeddingService) {}

  async query(text: string, topK: number = 5): Promise<RetrievalResult[]> {
    const sqlite = RAGDatabase.getSqlite();
    const chroma = RAGDatabase.getChroma();

    // 1. Keyword search (SQLite FTS5)
    // We fetch top 10 results from SQLite
    const keywordStmt = sqlite.prepare(`
      SELECT chunk_id, text, doc_id, section_label, page, rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT 10
    `);

    // Basic query transformation: convert to FTS syntax (e.g. enclose in quotes if needed or just replace spaces)
    // For MVP, just replacing spaces with OR to get some matches, or doing a simple phrase match
    const ftsQuery = `"${text.replace(/"/g, "")}"`;

    let keywordResults: any[] = [];
    try {
      keywordResults = keywordStmt.all(ftsQuery);
    } catch (e) {
      // Fallback to OR search if phrase match fails syntax
      try {
        const fallbackQuery = text.split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, "")).filter(w => w).join(" OR ");
        if (fallbackQuery) {
          keywordResults = keywordStmt.all(fallbackQuery);
        }
      } catch (e2) {
        console.warn("FTS query failed:", e2);
      }
    }

    const keywordScored: ScoredItem[] = keywordResults.map((r, i) => ({
      id: r.chunk_id,
      score: 1 / (60 + i + 1), // RRF score
      data: {
        chunk_id: r.chunk_id,
        text: r.text,
        doc_id: r.doc_id,
        section_label: r.section_label,
        page: r.page
      }
    }));

    // 2. Vector search (Chroma)
    const queryEmbedding = await this.embeddingService.embed(text);

    let vectorScored: ScoredItem[] = [];
    try {
      const chromaResults = await chroma.query({
        queryEmbeddings: [queryEmbedding],
        nResults: 10
      });

      if (chromaResults.ids[0]) {
        vectorScored = chromaResults.ids[0].map((id, i) => {
          const meta = chromaResults.metadatas[0][i] as any;
          return {
            id,
            score: 1 / (60 + i + 1), // RRF score
            data: {
              chunk_id: id,
              text: chromaResults.documents[0][i] as string,
              doc_id: meta.doc_id,
              section_label: meta.section_label,
              page: meta.page
            }
          };
        });
      }
    } catch (e) {
      console.warn("Chroma query failed:", e);
    }

    // 3. Reciprocal Rank Fusion (RRF)
    const fusedScores = new Map<string, ScoredItem>();

    for (const item of [...keywordScored, ...vectorScored]) {
      if (fusedScores.has(item.id)) {
        const existing = fusedScores.get(item.id)!;
        existing.score += item.score;
      } else {
        fusedScores.set(item.id, { ...item }); // Clone
      }
    }

    // 4. Sort by fused score and return topK
    const finalResults = Array.from(fusedScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(item => ({
        ...item.data,
        score: item.score
      } as RetrievalResult));

    return finalResults;
  }
}
