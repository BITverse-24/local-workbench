import path from "node:path";
import {
  RAGDatabase,
  EmbeddingService,
  IngestionPipeline,
  RetrievalPipeline,
  type DocumentRecord,
  type RetrievalResult,
  type EmbeddingConfig,
} from "../../../../ai/rag/index.js";
import { getSetting } from "../persistence/settings-store.js";
import type { ModelConfigRow } from "../../shared/contracts.js";
import type Database from "better-sqlite3";

export interface RAGStats {
  docCount: number;
  chunkCount: number;
  initialized: boolean;
}

export function loadSavedEmbeddingConfig(fallback?: EmbeddingConfig): EmbeddingConfig {
  const def = fallback ?? {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "nomic-embed-text:v1.5",
  };
  try {
    const saved = getSetting<EmbeddingConfig>("embedding_config");
    if (saved?.baseUrl && saved?.model) return saved;
    const models = getSetting<ModelConfigRow[]>("configured_models");
    const embeddingRow = models?.find((m) => m.role === "embedding");
    if (embeddingRow) {
      const host = (embeddingRow.host || "127.0.0.1").replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      const port = embeddingRow.port || 11434;
      return {
        baseUrl: `http://${host}:${port}/v1`,
        model: embeddingRow.modelName,
      };
    }
  } catch {
    // In standalone tests where DB is not open
  }
  return def;
}

export class RAGService {
  private retrieval!: RetrievalPipeline;
  private ingestion!: IngestionPipeline;
  private embeddingService!: EmbeddingService;
  private initialized = false;

  // PERF OPTIMIZATION: Cache prepared SQLite statements to eliminate SQL string parsing
  // and compilation overhead on repeated Knowledge Base telemetry polls and document listings.
  private listDocsStmt: Database.Statement | null = null;
  private countDocsStmt: Database.Statement | null = null;
  private countChunksStmt: Database.Statement | null = null;

  constructor(
    private dataDir: string,
    private embeddingConfig: EmbeddingConfig = loadSavedEmbeddingConfig(),
  ) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    const ragDataDir = path.join(this.dataDir, "rag");
    await RAGDatabase.init(ragDataDir);

    this.embeddingService = new EmbeddingService(this.embeddingConfig);
    this.retrieval = new RetrievalPipeline(this.embeddingService);
    this.ingestion = new IngestionPipeline(this.embeddingService);
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getEmbeddingConfig(): EmbeddingConfig {
    return this.embeddingConfig;
  }

  updateEmbeddingConfig(config: EmbeddingConfig): void {
    this.embeddingConfig = config;
    this.embeddingService = new EmbeddingService(this.embeddingConfig);
    this.retrieval = new RetrievalPipeline(this.embeddingService);
    this.ingestion = new IngestionPipeline(this.embeddingService);
  }

  async query(text: string, topK: number = 5): Promise<RetrievalResult[]> {
    if (!this.initialized) await this.init();
    return this.retrieval.query(text, topK);
  }

  async ingestDocument(doc: DocumentRecord, filePath: string): Promise<number> {
    if (!this.initialized) await this.init();
    return this.ingestion.ingestDocument(doc, filePath);
  }

  async deleteDocument(docId: string): Promise<void> {
    if (!this.initialized) await this.init();
    return this.ingestion.deleteDocument(docId);
  }

  listDocuments(): DocumentRecord[] {
    if (!this.initialized) return [];
    const sqlite = RAGDatabase.getSqlite();
    try {
      if (!this.listDocsStmt) {
        this.listDocsStmt = sqlite.prepare("SELECT * FROM documents ORDER BY indexed_at DESC");
      }
      const rows = this.listDocsStmt.all() as any[];
      return rows.map((r) => ({
        doc_id: r.doc_id,
        title: r.title,
        source_path: r.source_path,
        doc_type: r.doc_type,
        department: r.department,
        effective_date: r.effective_date,
        indexed_at: r.indexed_at,
        page_count: r.page_count,
        ocr_used: Boolean(r.ocr_used),
        chunk_count: r.chunk_count ?? 0,
      }));
    } catch {
      return [];
    }
  }

  getStats(): RAGStats {
    if (!this.initialized) {
      return { docCount: 0, chunkCount: 0, initialized: false };
    }
    const sqlite = RAGDatabase.getSqlite();
    try {
      if (!this.countDocsStmt) {
        this.countDocsStmt = sqlite.prepare("SELECT COUNT(*) as count FROM documents");
      }
      if (!this.countChunksStmt) {
        this.countChunksStmt = sqlite.prepare("SELECT COUNT(*) as count FROM chunks_fts");
      }
      const docRow = this.countDocsStmt.get() as { count: number };
      const chunkRow = this.countChunksStmt.get() as { count: number };
      return {
        docCount: docRow?.count ?? 0,
        chunkCount: chunkRow?.count ?? 0,
        initialized: true,
      };
    } catch {
      return { docCount: 0, chunkCount: 0, initialized: true };
    }
  }

  async reindex(docId?: string): Promise<{ chunksIndexed: number }> {
    if (!this.initialized) await this.init();
    const docs = this.listDocuments();
    const targetDocs = docId ? docs.filter((d) => d.doc_id === docId) : docs;

    let totalChunks = 0;
    for (const d of targetDocs) {
      const count = await this.ingestDocument(d, d.source_path);
      totalChunks += count;
    }
    return { chunksIndexed: totalChunks };
  }
}
