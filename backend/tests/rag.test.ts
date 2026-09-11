import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RAGDatabase } from "../../ai/rag/db.js";
import { RAGService } from "../src/main/rag/rag-service.js";
import { RAGGroundingProvider } from "../src/main/grounding/rag-grounding-provider.js";
import { registerKnowledgeBaseHandlers } from "../src/main/ipc/kb-handlers.js";
import { IPC_KB } from "../src/main/ipc/channels.js";
import type { MinimalIpcMain } from "../src/main/ipc/handlers.js";

/** Deterministic pseudo-embedding for testing (384 dimensions) */
function createFakeEmbedding(text: string, dims = 384): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < dims; i++) {
    vec[i] = Math.sin(hash + i);
  }
  // Normalize vector
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

class FakeIpcMain implements MinimalIpcMain {
  handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, input: unknown): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn({}, input);
  }
}

describe("RAG & Grounding Subsystem", () => {
  let tempDir: string;
  let fetchSpy: any;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "workbench-rag-test-"));

    // Mock fetch for Ollama embedding calls
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes("/embeddings")) {
        const body = JSON.parse(String(init?.body || "{}"));
        const texts = Array.isArray(body.input) ? body.input : [body.input];
        const data = texts.map((t: string, idx: number) => ({
          index: idx,
          embedding: createFakeEmbedding(String(t)),
        }));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data,
            usage: { prompt_tokens: 10, total_tokens: 10 },
          }),
        } as Response;
      }
      return { ok: false, status: 404, text: async () => "Not Found" } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    RAGDatabase.close();
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe("RAGDatabase low-level operations", () => {
    it("initializes SQLite FTS5 table and Vectra index in specified directory", async () => {
      const ragDir = path.join(tempDir, "rag");
      await RAGDatabase.init(ragDir);

      const sqlite = RAGDatabase.getSqlite();
      const vectra = RAGDatabase.getVectra();

      expect(sqlite).toBeDefined();
      expect(vectra).toBeDefined();

      // Check SQLite tables
      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);

      expect(names).toContain("documents");
      expect(names).toContain("chunks_fts");

      // Check Vectra index created
      expect(await vectra.isIndexCreated()).toBe(true);
    });

    it("inserts chunks into SQLite FTS5 and performs keyword search", async () => {
      const ragDir = path.join(tempDir, "rag");
      await RAGDatabase.init(ragDir);

      const sqlite = RAGDatabase.getSqlite();
      sqlite
        .prepare(
          "INSERT INTO chunks_fts (chunk_id, text, doc_id, section_label, page) VALUES (?, ?, ?, ?, ?)",
        )
        .run("sop114_c1", "Ultrasonic crack inspection protocol for titanium alloy pipes", "sop-114", "4.2", 3);

      const results = sqlite
        .prepare("SELECT chunk_id, text, doc_id FROM chunks_fts WHERE chunks_fts MATCH ?")
        .all("ultrasonic crack") as { chunk_id: string; text: string; doc_id: string }[];

      expect(results.length).toBe(1);
      expect(results[0].chunk_id).toBe("sop114_c1");
      expect(results[0].doc_id).toBe("sop-114");
    });
  });

  describe("RAGService lifecycle and operations", () => {
    it("ingests document, queries with hybrid search, and reports stats", async () => {
      const ragService = new RAGService(tempDir, {
        baseUrl: "http://localhost:1234/v1",
        model: "nomic-embed-text:v1.5",
      });

      await ragService.init();
      expect(ragService.isInitialized()).toBe(true);

      // Initial stats
      const initialStats = ragService.getStats();
      expect(initialStats.docCount).toBe(0);
      expect(initialStats.chunkCount).toBe(0);

      // Create a test SOP document file
      const sopFile = path.join(tempDir, "sop-114.md");
      const sopContent = `
# SOP-114: Surface Crack Testing and Inspection Standard
## Section 1: Scope
This standard applies to non-destructive testing of critical pressure vessels and piping joints.

## Section 2: Ultrasonic Examination
All surface cracks exceeding 0.5mm depth must undergo ultrasonic phase array inspection.
Calibration of transducer frequencies must occur before each operational shift.

## Section 3: Acceptance Criteria
Discontinuities larger than 1.2mm in any direction represent an automatic inspection failure.
A formal rejection notice and quarantine tag must be issued within 2 hours.
`;
      writeFileSync(sopFile, sopContent, "utf8");

      // Ingest document
      const chunkCount = await ragService.ingestDocument(
        {
          doc_id: "sop-114",
          title: "SOP-114 Surface Crack Testing",
          source_path: sopFile,
          doc_type: "sop",
          department: "Quality Assurance",
          effective_date: "2024-01-01",
          indexed_at: new Date().toISOString(),
          page_count: 1,
          ocr_used: false,
        },
        sopFile,
      );

      expect(chunkCount).toBeGreaterThan(0);

      // Verify stats
      const stats = ragService.getStats();
      expect(stats.docCount).toBe(1);
      expect(stats.chunkCount).toBe(chunkCount);

      // Verify list documents
      const docs = ragService.listDocuments();
      expect(docs.length).toBe(1);
      expect(docs[0].doc_id).toBe("sop-114");
      expect(docs[0].title).toBe("SOP-114 Surface Crack Testing");

      // Query with hybrid search
      const queryResults = await ragService.query("ultrasonic crack inspection", 3);
      expect(queryResults.length).toBeGreaterThan(0);
      expect(queryResults[0].doc_id).toBe("sop-114");
      expect(queryResults[0].text.toLowerCase()).toContain("ultrasonic");

      // Delete document
      await ragService.deleteDocument("sop-114");

      const afterDeleteStats = ragService.getStats();
      expect(afterDeleteStats.docCount).toBe(0);
      expect(afterDeleteStats.chunkCount).toBe(0);
      expect(ragService.listDocuments().length).toBe(0);
    });
  });

  describe("RAGGroundingProvider", () => {
    it("returns empty notes when knowledge base has no documents", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      const provider = new RAGGroundingProvider(ragService);
      const res = await provider.prepare({
        runId: "test-run-1",
        text: "Inspect the pump skid for weld defects",
      });

      expect(res.notes).toEqual([]);
      expect(res.chunks).toEqual([]);
    });

    it("formats grounding notes with citations when relevant context is found", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      const sopFile = path.join(tempDir, "sop-220.txt");
      writeFileSync(
        sopFile,
        "# Section 4: Pump Skid Grounding Criteria\nAll baseplate anchor bolts must be torqued to 85 Nm.\nVerify vibration dampener pad alignment before startup.",
        "utf8",
      );

      await ragService.ingestDocument(
        {
          doc_id: "sop-220",
          title: "SOP-220 Pump Skid Grounding",
          source_path: sopFile,
          doc_type: "sop",
          department: "Mechanical",
          effective_date: "2024-01-01",
          indexed_at: new Date().toISOString(),
          page_count: 1,
          ocr_used: false,
        },
        sopFile,
      );

      const provider = new RAGGroundingProvider(ragService);
      const res = await provider.prepare({
        runId: "test-run-2",
        text: "What is the anchor bolt torque requirement for pump skid baseplate?",
      });

      expect(res.notes.length).toBe(1);
      expect(res.notes[0]).toContain("MANDATORY GROUNDING CONTEXT");
      expect(res.notes[0]).toContain("SOP-220");
      expect(res.notes[0]).toContain("85 Nm");
      expect(res.chunks?.length).toBeGreaterThan(0);
      expect(res.chunks![0].docId).toBe("sop-220");
    });
  });

  describe("IPC Knowledge Base Handlers", () => {
    it("wires and executes kb:listDocs, kb:ingestDoc, kb:query, kb:stats, kb:deleteDoc", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      const fakeIpc = new FakeIpcMain();
      registerKnowledgeBaseHandlers(fakeIpc, ragService);

      // Verify stats initially
      const statsRes = (await fakeIpc.invoke(IPC_KB.STATS, {})) as any;
      expect(statsRes.docCount).toBe(0);

      // Create test document
      const docFile = path.join(tempDir, "sop-test.md");
      writeFileSync(
        docFile,
        "# Section 1: SOP-TEST\nAll piping welds require radiography inspection under ISO 5817 Level B.",
        "utf8",
      );

      // Test kb:ingestDoc
      const ingestRes = (await fakeIpc.invoke(IPC_KB.INGEST_DOC, {
        doc_id: "sop-test",
        title: "Test SOP Welding",
        source_path: docFile,
        doc_type: "sop",
      })) as any;

      expect(ingestRes.ok).toBe(true);
      expect(ingestRes.chunkCount).toBeGreaterThan(0);

      // Test kb:listDocs
      const listRes = (await fakeIpc.invoke(IPC_KB.LIST_DOCS, {})) as any[];
      expect(Array.isArray(listRes)).toBe(true);
      expect(listRes.length).toBe(1);
      expect(listRes[0].doc_id).toBe("sop-test");

      // Test kb:query
      const queryRes = (await fakeIpc.invoke(IPC_KB.QUERY, {
        text: "radiography ISO 5817",
        topK: 2,
      })) as any;

      expect(queryRes.ok).toBe(true);
      expect(queryRes.results.length).toBeGreaterThan(0);
      expect(queryRes.results[0].doc_id).toBe("sop-test");

      // Test kb:deleteDoc
      const delRes = (await fakeIpc.invoke(IPC_KB.DELETE_DOC, { docId: "sop-test" })) as any;
      expect(delRes.ok).toBe(true);

      // Verify empty after delete
      const listAfter = (await fakeIpc.invoke(IPC_KB.LIST_DOCS, {})) as any[];
      expect(listAfter.length).toBe(0);
    });
  });
});
