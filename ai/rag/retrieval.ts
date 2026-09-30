import type Database from "better-sqlite3";
import { RAGDatabase } from "./db.js";
import { EmbeddingService } from "./embedding.js";
import { RetrievalResult } from "./types.js";

interface ScoredItem {
  id: string;
  score: number;
  data: {
    chunk_id: string;
    text: string;
    doc_id: string;
    section_label: string;
    page: number;
  };
}

const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "could", "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from",
  "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him",
  "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "me", "more",
  "most", "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other",
  "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "she", "should", "so",
  "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then",
  "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "with", "would", "you", "your", "yours", "yourself", "yourselves"
]);

export function sanitizeFtsQuery(query: string): {
  tokens: string[];
  meaningfulTokens: string[];
  phraseQuery: string;
  andQuery: string;
  orQuery: string;
} {
  const tokens = query
    .replace(/[^\w\s.-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim().replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length > 0);

  if (tokens.length === 0) {
    return { tokens: [], meaningfulTokens: [], phraseQuery: "", andQuery: "", orQuery: "" };
  }

  // Filter stopwords for high-precision query; fallback to all tokens if all were stopwords
  const meaningfulTokens = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  const activeTokens = meaningfulTokens.length > 0 ? meaningfulTokens : tokens;

  const phraseQuery = tokens.length > 1 ? `"${tokens.join(" ").replace(/"/g, "")}"` : "";
  const andQuery = activeTokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND ");
  const orQuery = activeTokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");

  return { tokens, meaningfulTokens: activeTokens, phraseQuery, andQuery, orQuery };
}

export class RetrievalPipeline {
  // PERF OPTIMIZATION: Cache prepared SQLite Statement objects for FTS queries to avoid repeated SQL string parsing
  // and compilation overhead on high-frequency document searches and RAG queries.
  private ftsStmtCache = new WeakMap<Database.Database, Database.Statement>();

  constructor(private embeddingService: EmbeddingService) {}

  private getFtsStatement(sqlite: Database.Database): Database.Statement {
    let stmt = this.ftsStmtCache.get(sqlite);
    if (!stmt) {
      stmt = sqlite.prepare(`
        SELECT chunk_id, text, doc_id, section_label, page, rank
        FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      this.ftsStmtCache.set(sqlite, stmt);
    }
    return stmt;
  }

  async query(text: string, topK: number = 5): Promise<RetrievalResult[]> {
    const cleanQuery = (text || "").replace(/\0/g, "").trim();
    if (!cleanQuery) {
      return [];
    }

    const limit = Math.max(1, Math.min(topK || 5, 50));
    const candidateLimit = Math.max(limit * 3, 20);

    const sqlite = RAGDatabase.getSqlite();
    const vectra = RAGDatabase.getVectra();

    // 1. Keyword search (SQLite FTS5) with precision tiers
    const { phraseQuery, andQuery, orQuery } = sanitizeFtsQuery(cleanQuery);
    const keywordMatches = new Map<string, { rank: number; row: any; isExactPhrase?: boolean; isAndMatch?: boolean }>();

    // 1a. Tier 1: Exact verbatim phrase match (highest precision)
    if (phraseQuery) {
      try {
        const ftsStmt = this.getFtsStatement(sqlite);
        const rows = ftsStmt.all(phraseQuery, candidateLimit) as any[];
        for (let i = 0; i < rows.length; i++) {
          keywordMatches.set(rows[i].chunk_id, { rank: i, row: rows[i], isExactPhrase: true });
        }
      } catch {
        // Fall through to AND search
      }
    }

    // 1b. Tier 2: All meaningful keywords present (AND search)
    if (andQuery && keywordMatches.size < candidateLimit) {
      try {
        const ftsStmt = this.getFtsStatement(sqlite);
        const rows = ftsStmt.all(andQuery, candidateLimit) as any[];
        for (let i = 0; i < rows.length; i++) {
          if (!keywordMatches.has(rows[i].chunk_id)) {
            keywordMatches.set(rows[i].chunk_id, {
              rank: keywordMatches.size,
              row: rows[i],
              isAndMatch: true,
            });
          }
        }
      } catch (err) {
        console.warn("[rag:retrieval] FTS AND query failed:", err);
      }
    }

    // 1c. Tier 3: Partial keywords present (OR search fallback)
    // ONLY executed when Tier 1 and Tier 2 yielded ZERO matches, to prevent spurious OR matches
    // from polluting precision rankings when exact/AND matches exist.
    if (orQuery && keywordMatches.size === 0) {
      try {
        const ftsStmt = this.getFtsStatement(sqlite);
        const rows = ftsStmt.all(orQuery, candidateLimit) as any[];
        for (let i = 0; i < rows.length; i++) {
          if (!keywordMatches.has(rows[i].chunk_id)) {
            keywordMatches.set(rows[i].chunk_id, {
              rank: i,
              row: rows[i],
            });
          }
        }
      } catch (err) {
        console.warn("[rag:retrieval] FTS OR query failed:", err);
      }
    }

    const keywordScored: ScoredItem[] = Array.from(keywordMatches.values()).map(
      ({ rank, row, isExactPhrase, isAndMatch }) => {
        const baseRrf = 1 / (60 + rank + 1);
        let multiplier = 1.0;
        if (isExactPhrase) {
          multiplier = 2.0;
        } else if (isAndMatch) {
          multiplier = 1.3;
        }
        return {
          id: row.chunk_id,
          score: baseRrf * multiplier,
          data: {
            chunk_id: row.chunk_id,
            text: row.text,
            doc_id: row.doc_id,
            section_label: row.section_label || "unknown",
            page: typeof row.page === "number" ? row.page : Number(row.page) || 1,
          },
        };
      },
    );

    // 2. Vector search (Vectra)
    let vectorScored: ScoredItem[] = [];
    try {
      const queryEmbedding = await this.embeddingService.embed(cleanQuery);
      if (Array.isArray(queryEmbedding) && queryEmbedding.length > 0) {
        const vectraResults = await vectra.queryItems(queryEmbedding, cleanQuery, candidateLimit);

        vectorScored = (vectraResults || []).map((r, i) => {
          const meta = (r.item?.metadata as any) || {};
          return {
            id: r.item.id,
            score: 1 / (60 + i + 1), // RRF score
            data: {
              chunk_id: r.item.id,
              text: meta.text || "",
              doc_id: meta.doc_id || "",
              section_label: meta.section_label || "unknown",
              page: typeof meta.page === "number" ? meta.page : Number(meta.page) || 1,
            },
          };
        });
      }
    } catch (e) {
      console.warn("[rag:retrieval] Vectra semantic query failed (is embedding model available?):", e);
    }

    // 3. Reciprocal Rank Fusion (RRF)
    const fusedScores = new Map<string, ScoredItem>();

    for (const item of [...keywordScored, ...vectorScored]) {
      if (fusedScores.has(item.id)) {
        const existing = fusedScores.get(item.id)!;
        existing.score += item.score;
        if (!existing.data.text && item.data.text) {
          existing.data.text = item.data.text;
        }
      } else {
        fusedScores.set(item.id, { ...item, data: { ...item.data } });
      }
    }

    // 4. Sort by fused score and return topK
    const finalResults = Array.from(fusedScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => ({
        ...item.data,
        score: item.score,
      } as RetrievalResult));

    return finalResults;
  }
}
