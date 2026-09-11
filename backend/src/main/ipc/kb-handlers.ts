import type { IpcRegistrar } from "./handlers.js";
import { IPC_KB } from "./channels.js";
import {
  kbIngestDocSchema,
  kbDeleteDocSchema,
  kbReindexSchema,
  kbQuerySchema,
} from "./validators.js";
import type { RAGService } from "../rag/rag-service.js";

export function registerKnowledgeBaseHandlers(
  ipc: IpcRegistrar,
  ragService: RAGService,
): void {
  ipc.handle(IPC_KB.LIST_DOCS, async () => {
    return ragService.listDocuments();
  });

  ipc.handle(IPC_KB.INGEST_DOC, async (_event, input) => {
    const parsed = kbIngestDocSchema.parse(input);
    const chunkCount = await ragService.ingestDocument(
      {
        doc_id: parsed.doc_id,
        title: parsed.title,
        source_path: parsed.source_path,
        doc_type: parsed.doc_type,
        department: parsed.department,
        effective_date: parsed.effective_date,
        indexed_at: new Date().toISOString(),
        page_count: parsed.page_count,
        ocr_used: parsed.ocr_used,
      },
      parsed.source_path,
    );
    return { ok: true, docId: parsed.doc_id, chunkCount };
  });

  ipc.handle(IPC_KB.DELETE_DOC, async (_event, input) => {
    const parsed = kbDeleteDocSchema.parse(input);
    await ragService.deleteDocument(parsed.docId);
    return { ok: true, docId: parsed.docId };
  });

  ipc.handle(IPC_KB.REINDEX, async (_event, input) => {
    const parsed = kbReindexSchema.parse(input ?? {});
    const result = await ragService.reindex(parsed.docId);
    return { ok: true, ...result };
  });

  ipc.handle(IPC_KB.QUERY, async (_event, input) => {
    const parsed = kbQuerySchema.parse(input);
    const results = await ragService.query(parsed.text, parsed.topK);
    return { ok: true, results };
  });

  ipc.handle(IPC_KB.STATS, async () => {
    return ragService.getStats();
  });
}
