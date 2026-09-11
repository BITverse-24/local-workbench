import type { GroundingProvider, GroundingRequest, GroundingResult } from "./provider.js";
import type { RAGService } from "../rag/rag-service.js";
import type { GroundingChunk } from "../../shared/contracts.js";

export class RAGGroundingProvider implements GroundingProvider {
  constructor(private ragService: RAGService) {}

  async prepare(input: GroundingRequest): Promise<GroundingResult> {
    const stats = this.ragService.getStats();
    if (!stats.docCount || stats.chunkCount === 0) {
      return { runId: input.runId, notes: [], chunks: [] };
    }

    try {
      const results = await this.ragService.query(input.text, 5);
      if (results.length === 0) {
        return { runId: input.runId, notes: [], chunks: [] };
      }

      const chunks: GroundingChunk[] = results.map((r) => ({
        chunkId: r.chunk_id,
        docId: r.doc_id,
        sectionLabel: r.section_label,
        text: r.text,
        page: r.page,
        score: r.score,
      }));

      const contextBlock = chunks
        .map(
          (c, i) =>
            `[EXCERPT ${i + 1} | CITATION: ${c.chunkId}] (Document: ${c.docId}, Clause/Section: §${c.sectionLabel}, Page: ${c.page}):\n${c.text}`,
        )
        .join("\n\n---\n\n");

      const docLabel = (chunks[0].docId || "SOP").toUpperCase();
      const secLabel = chunks[0].sectionLabel ? `§${chunks[0].sectionLabel}` : "";
      const note =
        `MANDATORY GROUNDING CONTEXT — The following verified standard operating procedures / technical criteria apply to this task.\n` +
        `You MUST ground all technical assessments and findings in this evidence.\n` +
        `Cite each standard inline using its exact citation identifier like [${chunks[0].chunkId}] or [${docLabel}${secLabel ? ` ${secLabel}` : ""}]\n` +
        `If the provided SOP criteria do not cover an observed item, explicitly flag it as unverified.\n\n` +
        contextBlock;

      return {
        runId: input.runId,
        notes: [note],
        chunks,
      };
    } catch (err) {
      console.warn(`[grounding] Failed to retrieve grounding context for run ${input.runId}:`, err);
      return { runId: input.runId, notes: [], chunks: [] };
    }
  }
}
