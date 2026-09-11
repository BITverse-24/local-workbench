import { LocalIndex } from "vectra";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export class RAGDatabase {
  private static vectraIndex: LocalIndex;
  private static sqlite: Database.Database;

  static async init(dataDir: string = "./data/rag"): Promise<void> {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initialize SQLite for Keyword (FTS5) Search and document tracking
    const sqlitePath = path.join(dataDir, "keyword.db");
    this.sqlite = new Database(sqlitePath);

    // Create documents tracking table
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        doc_id TEXT PRIMARY KEY,
        title TEXT,
        source_path TEXT,
        doc_type TEXT,
        department TEXT,
        effective_date TEXT,
        indexed_at TEXT,
        page_count INTEGER,
        ocr_used INTEGER,
        chunk_count INTEGER
      );
    `);

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

    // Initialize Vectra LocalIndex for vector embeddings
    const vectraDir = path.join(dataDir, "vectra-index");
    this.vectraIndex = new LocalIndex(vectraDir);

    if (!(await this.vectraIndex.isIndexCreated())) {
      await this.vectraIndex.createIndex();
    }
  }

  static getSqlite(): Database.Database {
    return this.sqlite;
  }

  static getVectra(): LocalIndex {
    return this.vectraIndex;
  }

  static close(): void {
    if (this.sqlite) {
      try {
        this.sqlite.close();
      } catch {}
    }
  }
}

