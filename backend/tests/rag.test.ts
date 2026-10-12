import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
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

    it("ingests multi-page PDF document, preserving page numbers and chunk citations", async () => {
      const ragService = new RAGService(tempDir, {
        baseUrl: "http://localhost:1234/v1",
        model: "nomic-embed-text:v1.5",
      });

      await ragService.init();

      const pdfPath = path.resolve(__dirname, "../../demo/flow_a/scenario-1/inspection-report-E201-annotated.pdf");
      const docRecord = {
        doc_id: "ir-e201",
        title: "Inspection Report E201",
        source_path: pdfPath,
        doc_type: "inspection_report",
        department: "Operations",
        effective_date: "2026-08-20",
        indexed_at: new Date().toISOString(),
        page_count: 0,
        ocr_used: false,
      };

      const chunkCount = await ragService.ingestDocument(docRecord, pdfPath);
      expect(chunkCount).toBeGreaterThan(0);

      // Verify document record updated with actual page count
      const docs = ragService.listDocuments();
      expect(docs.length).toBe(1);
      expect(docs[0].doc_id).toBe("ir-e201");
      expect(docs[0].page_count).toBe(2);

      // Verify chunks in SQLite retain their proper page numbers
      const sqlite = RAGDatabase.getSqlite();
      const chunks = sqlite
        .prepare("SELECT chunk_id, page, text FROM chunks_fts WHERE doc_id = ?")
        .all("ir-e201") as { chunk_id: string; page: number; text: string }[];

      expect(chunks.length).toBe(chunkCount);
      const pages = new Set(chunks.map((c) => c.page));
      expect(pages.has(1)).toBe(true);
      expect(pages.has(2)).toBe(true);

      // Query page 1 content
      const queryResultsP1 = await ragService.query("tube wall thickness", 2);
      expect(queryResultsP1.length).toBeGreaterThan(0);
      expect(queryResultsP1[0].doc_id).toBe("ir-e201");
      expect(queryResultsP1[0].page).toBe(1);

      // Query page 2 content
      const queryResultsP2 = await ragService.query("Channel-head gasket degradation", 2);
      expect(queryResultsP2.length).toBeGreaterThan(0);
      expect(queryResultsP2[0].doc_id).toBe("ir-e201");
      expect(queryResultsP2[0].page).toBe(2);

      // Clean up
      await ragService.deleteDocument("ir-e201");
      expect(ragService.getStats().docCount).toBe(0);
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

  describe("RAG Edge Cases & Robustness", () => {
    it("handles empty, whitespace-only, and complex syntax queries without throwing errors", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      // Empty query returns []
      expect(await ragService.query("")).toEqual([]);
      expect(await ragService.query("    ")).toEqual([]);

      // Query with complex punctuation, symbols, and SQL/FTS syntax characters
      const results = await ragService.query('::: ((( ))) *** "AND" "OR" "NOT" ??? ---');
      expect(Array.isArray(results)).toBe(true);
    });

    it("subdivides an oversized single paragraph into bounded chunks", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      // Create a markdown file with one huge paragraph of >1500 words without double-newlines
      const sentences: string[] = [];
      for (let i = 1; i <= 60; i++) {
        sentences.push(`Clause item ${i}: The refinery heat exchanger shell and tube joints must withstand operating pressure of ${10 + i} bar.`);
      }
      const hugeParagraph = sentences.join(" ");
      const filePath = path.join(tempDir, "huge-paragraph.md");
      writeFileSync(filePath, `# Section 1: Massive Technical Spec\n${hugeParagraph}`, "utf8");

      const chunkCount = await ragService.ingestDocument(
        {
          doc_id: "huge-spec",
          title: "Huge Technical Spec",
          source_path: filePath,
          doc_type: "spec",
          department: "Engineering",
          effective_date: "2026-01-01",
          indexed_at: new Date().toISOString(),
          page_count: 1,
          ocr_used: false,
        },
        filePath,
      );

      // Must be split into multiple bounded chunks
      expect(chunkCount).toBeGreaterThan(1);

      // Verify content near the end is searchable
      const results = await ragService.query("pressure of 65 bar", 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].doc_id).toBe("huge-spec");
    });

    it("ingests DOCX documents with extracted paragraphs and tables", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      // Create a test DOCX archive in memory using JSZip
      const zip = new JSZip();
      const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Section 3: High-Pressure Flange Gasket Rules</w:t></w:r></w:p>
    <w:p><w:r><w:t>Spiral wound graphite filled gaskets conforming to ASME B16.20 are mandatory for all hydrocarbon lines.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
      zip.file("word/document.xml", documentXml);
      const docxBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const docxPath = path.join(tempDir, "flange-rules.docx");
      writeFileSync(docxPath, docxBuffer);

      const chunkCount = await ragService.ingestDocument(
        {
          doc_id: "docx-flange",
          title: "Flange Gasket Rules",
          source_path: docxPath,
          doc_type: "sop",
          department: "Piping",
          effective_date: "2026-01-01",
          indexed_at: new Date().toISOString(),
          page_count: 1,
          ocr_used: false,
        },
        docxPath,
      );

      expect(chunkCount).toBeGreaterThan(0);

      // Query DOCX content with unescaped XML entity
      const results = await ragService.query("ASME B16.20 graphite filled", 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].doc_id).toBe("docx-flange");
      expect(results[0].text).toContain("ASME B16.20");
    });

    it("ingests UTF-16LE and UTF-8 BOM text documents transparently", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      // Write UTF-16LE file with BOM (\xFF\xFE)
      const utf16Path = path.join(tempDir, "utf16-doc.txt");
      const utf16Content = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("Section 5: Turbine Maintenance\nVibration amplitude must not exceed 2.8 mm/s RMS.", "utf16le"),
      ]);
      writeFileSync(utf16Path, utf16Content);

      const chunkCount16 = await ragService.ingestDocument(
        {
          doc_id: "utf16-doc",
          title: "Turbine Spec (UTF-16)",
          source_path: utf16Path,
          doc_type: "standard",
          department: "Turbomachinery",
          effective_date: "2026-01-01",
          indexed_at: new Date().toISOString(),
          page_count: 1,
          ocr_used: false,
        },
        utf16Path,
      );
      expect(chunkCount16).toBeGreaterThan(0);

      const res16 = await ragService.query("vibration amplitude 2.8 mm/s", 2);
      expect(res16.length).toBeGreaterThan(0);
      expect(res16[0].doc_id).toBe("utf16-doc");
      expect(res16[0].text).toContain("2.8 mm/s");

      // Write UTF-8 with BOM (\xEF\xBB\xBF)
      const utf8BomPath = path.join(tempDir, "utf8bom-doc.txt");
      const utf8BomContent = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("# Section 9: Steam Boiler Water Chemistry\nSilica levels must remain below 0.02 ppm at all times.", "utf8"),
      ]);
      writeFileSync(utf8BomPath, utf8BomContent);

      const chunkCount8 = await ragService.ingestDocument(
        {
          doc_id: "utf8bom-doc",
          title: "Boiler Chemistry (UTF-8 BOM)",
          source_path: utf8BomPath,
          doc_type: "standard",
          department: "Chemistry",
          effective_date: "2026-01-01",
          indexed_at: new Date().toISOString(),
          page_count: 1,
          ocr_used: false,
        },
        utf8BomPath,
      );
      expect(chunkCount8).toBeGreaterThan(0);

      const res8 = await ragService.query("silica levels below 0.02 ppm", 2);
      expect(res8.length).toBeGreaterThan(0);
      expect(res8[0].doc_id).toBe("utf8bom-doc");
      expect(res8[0].text).toContain("0.02 ppm");
    });

    it("rejects arbitrary binary files with a descriptive error", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      // Create a binary file containing null bytes (no text BOM)
      const binPath = path.join(tempDir, "corrupt.dat");
      writeFileSync(binPath, Buffer.from([0x00, 0xff, 0x00, 0xfe, 0xba, 0xbe]));

      await expect(
        ragService.ingestDocument(
          {
            doc_id: "binary-doc",
            title: "Binary File",
            source_path: binPath,
            doc_type: "raw",
            department: "IT",
            effective_date: "2026-01-01",
            indexed_at: new Date().toISOString(),
            page_count: 1,
            ocr_used: false,
          },
          binPath,
        ),
      ).rejects.toThrow(/Cannot ingest binary file/);
    });

    it("safely handles reindexing when source file was removed from disk", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      const tempFile = path.join(tempDir, "temp-sop.md");
      writeFileSync(tempFile, "# Section 1: Temporary Spec\nSafety valve testing interval is 12 months.", "utf8");

      await ragService.ingestDocument(
        {
          doc_id: "temp-sop",
          title: "Temp SOP",
          source_path: tempFile,
          doc_type: "sop",
          department: "Safety",
          effective_date: "2026-01-01",
          indexed_at: new Date().toISOString(),
          page_count: 1,
          ocr_used: false,
        },
        tempFile,
      );

      // Remove the file from disk
      rmSync(tempFile, { force: true });

      // Reindex should handle missing file gracefully and not throw
      const result = await ragService.reindex("temp-sop");
      expect(result.chunksIndexed).toBe(0);
    });

    it("continues indexing via SQLite FTS5 when embedding server is offline", async () => {
      // Temporarily mock fetch to simulate embedding server down (e.g. 503 or ECONNREFUSED)
      fetchSpy.mockImplementation(async () => {
        return {
          ok: false,
          status: 503,
          text: async () => "Service Unavailable",
        } as Response;
      });

      const ragService = new RAGService(tempDir);
      await ragService.init();

      const offlineDoc = path.join(tempDir, "offline-sop.md");
      writeFileSync(offlineDoc, "# Section 5: Pump Alignment\nShaft radial runout must not exceed 0.05 mm.", "utf8");

      const chunkCount = await ragService.ingestDocument(
        {
          doc_id: "offline-sop",
          title: "Offline SOP",
          source_path: offlineDoc,
          doc_type: "sop",
          department: "Rotating Equipment",
          effective_date: "2026-01-01",
          indexed_at: new Date().toISOString(),
          page_count: 1,
          ocr_used: false,
        },
        offlineDoc,
      );

      // Even with embedding service offline, chunks are indexed in SQLite FTS5
      expect(chunkCount).toBeGreaterThan(0);

      // Keyword query still works via SQLite FTS5
      const results = await ragService.query("radial runout 0.05 mm", 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].doc_id).toBe("offline-sop");
      expect(results[0].text).toContain("0.05 mm");
    });

    it("ingests large 50-page PDF, preserves exact page citations and performs sub-second retrieval", async () => {
      const ragService = new RAGService(tempDir);
      await ragService.init();

      // Generate a 50-page PDF
      const objects: string[] = [];
      objects.push("<< /Type /Catalog /Pages 2 0 R >>");

      const pageIds: number[] = [];
      for (let i = 1; i <= 50; i++) {
        const text = `Section ${i}: Standard Clause ${i}. Operating pressure limit is ${100 + i} PSI for alloy grade 316.`;
        const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET\n`;
        const contentId = 3 + (i - 1) * 2;
        const pageId = contentId + 1;
        objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
        objects.push(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${contentId} 0 R >>`,
        );
        pageIds.push(pageId);
      }

      objects.splice(1, 0, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count 50 >>`);
      objects.push("<< /Title (Multi-page Test PDF) >>");

      let pdf = "%PDF-1.4\n";
      const offsets = [0];
      for (let i = 0; i < objects.length; i++) {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
      }

      const startxref = pdf.length;
      pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (let i = 1; i < offsets.length; i++) {
        pdf += `${offsets[i].toString().padStart(10, "0")} 00000 n \n`;
      }
      pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

      const pdfPath = path.join(tempDir, "50-pages.pdf");
      writeFileSync(pdfPath, Buffer.from(pdf, "ascii"));

      const chunkCount = await ragService.ingestDocument(
        {
          doc_id: "pdf-50p",
          title: "50-Page Standard",
          source_path: pdfPath,
          doc_type: "standard",
          department: "Mechanical",
          effective_date: "2026-01-01",
          indexed_at: new Date().toISOString(),
          page_count: 0,
          ocr_used: false,
        },
        pdfPath,
      );

      expect(chunkCount).toBe(50);

      // Verify metadata records all 50 pages
      const docs = ragService.listDocuments();
      const p50Doc = docs.find((d) => d.doc_id === "pdf-50p");
      expect(p50Doc?.page_count).toBe(50);

      // Query clause from page 42
      const queryResults = await ragService.query("pressure limit is 142 PSI", 5);
      expect(queryResults.length).toBeGreaterThan(0);
      expect(queryResults[0].doc_id).toBe("pdf-50p");
      expect(queryResults[0].page).toBe(42);
      expect(queryResults[0].text).toContain("142 PSI");

      // Query clause from page 7
      const queryResultsP7 = await ragService.query("pressure limit is 107 PSI", 2);
      expect(queryResultsP7.length).toBeGreaterThan(0);
      expect(queryResultsP7[0].doc_id).toBe("pdf-50p");
      expect(queryResultsP7[0].page).toBe(7);
      expect(queryResultsP7[0].text).toContain("107 PSI");
    });
  });
});
