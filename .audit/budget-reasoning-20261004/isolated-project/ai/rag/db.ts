import { LocalIndex } from "vectra";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export class RAGDatabase {
  private static vectraIndex: LocalIndex | null = null;
  private static sqlite: Database.Database | null = null;

  static async init(dataDir: string = "./data/rag"): Promise<void> {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initialize SQLite for Keyword (FTS5) Search and document tracking
    const sqlitePath = path.join(dataDir, "keyword.db");
    this.sqlite = new Database(sqlitePath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.sqlite.pragma("synchronous = NORMAL");

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

    // Create or migrate FTS5 virtual table with Porter stemmer
    const ftsRow = this.sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'"
    ).get() as { sql?: string } | undefined;

    if (ftsRow && ftsRow.sql && !ftsRow.sql.includes("porter")) {
      try {
        this.sqlite.exec(`
          CREATE VIRTUAL TABLE chunks_fts_new USING fts5(
            chunk_id,
            text,
            doc_id UNINDEXED,
            section_label UNINDEXED,
            page UNINDEXED,
            tokenize = 'porter unicode61'
          );
          INSERT INTO chunks_fts_new SELECT chunk_id, text, doc_id, section_label, page FROM chunks_fts;
          DROP TABLE chunks_fts;
          ALTER TABLE chunks_fts_new RENAME TO chunks_fts;
        `);
      } catch {
        this.sqlite.exec("DROP TABLE IF EXISTS chunks_fts");
        this.sqlite.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            chunk_id,
            text,
            doc_id UNINDEXED,
            section_label UNINDEXED,
            page UNINDEXED,
            tokenize = 'porter unicode61'
          );
        `);
      }
    } else {
      this.sqlite.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          chunk_id,
          text,
          doc_id UNINDEXED,
          section_label UNINDEXED,
          page UNINDEXED,
          tokenize = 'porter unicode61'
        );
      `);
    }

    // Initialize Vectra LocalIndex for vector embeddings
    const vectraDir = path.join(dataDir, "vectra-index");
    this.vectraIndex = new LocalIndex(vectraDir);

    if (!(await this.vectraIndex.isIndexCreated())) {
      await this.vectraIndex.createIndex();
    }
  }

  static isInitialized(): boolean {
    return Boolean(this.sqlite && this.vectraIndex);
  }

  static getSqlite(): Database.Database {
    if (!this.sqlite) {
      throw new Error("RAGDatabase SQLite is not initialized. Call RAGDatabase.init() first.");
    }
    return this.sqlite;
  }

  static getVectra(): LocalIndex {
    if (!this.vectraIndex) {
      throw new Error("RAGDatabase Vectra is not initialized. Call RAGDatabase.init() first.");
    }
    return this.vectraIndex;
  }

  static close(): void {
    if (this.sqlite) {
      try {
        this.sqlite.close();
      } catch {}
      this.sqlite = null;
    }
    this.vectraIndex = null;
  }
}

