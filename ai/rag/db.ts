import { ChromaClient, Collection } from "chromadb";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export class RAGDatabase {
  private static chroma: ChromaClient;
  private static sqlite: Database.Database;
  private static chromaCollection: Collection;

  static async init(dataDir: string = "./data/rag"): Promise<void> {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initialize SQLite for Keyword (FTS5) Search
    const sqlitePath = path.join(dataDir, "keyword.db");
    this.sqlite = new Database(sqlitePath);

    // Create FTS5 virtual table if it doesn't exist
    this.sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id,
        text,
        doc_id UNINDEXED,
        section_label UNINDEXED,
        page UNINDEXED
      );
    `);

    // Initialize Chroma for Vector Search
    const dummyEmbeddingFunction = {
      generate: async (texts: string[]) => {
        return texts.map(() => []);
      }
    };

    this.chroma = new ChromaClient({ path: "http://localhost:8000" });

    try {
      this.chromaCollection = await this.chroma.getOrCreateCollection({
        name: "sop_chunks",
        metadata: { "hnsw:space": "cosine" },
        embeddingFunction: dummyEmbeddingFunction
      });
    } catch (e) {
      console.warn("Failed to connect to ChromaDB, is it running?", e);
    }
  }

  static getSqlite(): Database.Database {
    return this.sqlite;
  }

  static getChroma(): Collection {
    return this.chromaCollection;
  }
}
