import { localInferenceScheduler } from "../../backend/src/main/gateway/inference-scheduler.js";
import { currentRuntimeScope, assertRuntimeActive } from "../../backend/src/main/run/runtime-scope.js";
import { EmbeddingConfig } from "./types.js";

interface EmbeddingRequest {
  model: string;
  input: string | string[];
}

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class EmbeddingService {
  // PERF OPTIMIZATION: Bounded in-memory cache for string embeddings.
  // Prevents duplicate REST API network calls and vector calculations for previously embedded texts,
  // substantially accelerating grounding checks and repeated RAG queries.
  private static readonly CACHE_MAX_SIZE = 1000;
  private static readonly BATCH_CHUNK_SIZE = 32;
  private cache = new Map<string, number[]>();

  constructor(private modelConfig: EmbeddingConfig | any) {}

  clearCache(): void {
    this.cache.clear();
  }

  async embed(text: string): Promise<number[]> {
    const cleanText = (text || "").replace(/\0/g, "").trim();
    if (!cleanText) {
      return [];
    }
    const results = await this.embedBatch([cleanText]);
    return results[0] || [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    const sanitizedTexts = texts.map((t) => (t || "").replace(/\0/g, "").trim());
    const results: Array<number[] | null> = new Array(sanitizedTexts.length).fill(null);
    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    // 1. Check cache for each text
    for (let i = 0; i < sanitizedTexts.length; i++) {
      const text = sanitizedTexts[i];
      if (!text) {
        results[i] = [];
        continue;
      }
      const cacheKey = `${this.modelConfig.model ?? "default"}::${text}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        results[i] = cached;
      } else {
        missingIndices.push(i);
        missingTexts.push(text);
      }
    }

    // Return early if all embeddings were cached
    if (missingTexts.length === 0) {
      return results as number[][];
    }

    const apiKey = this.modelConfig.apiKey || process.env[this.modelConfig.apiKeyEnv || ""] || "";
    const baseUrl = (this.modelConfig.baseUrl || "http://localhost:1234/v1").replace(/\/+$/, "");
    const url = `${baseUrl}/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    console.log(`[rag:embedding] Dispatching embedBatch (${missingTexts.length} texts) to ${url} (model: ${this.modelConfig.model})`);

    const fetchedEmbeddings: number[][] = [];
    for (let i = 0; i < missingTexts.length; i += EmbeddingService.BATCH_CHUNK_SIZE) {
      const chunk = missingTexts.slice(i, i + EmbeddingService.BATCH_CHUNK_SIZE);
      const payload: EmbeddingRequest = {
        model: this.modelConfig.model,
        input: chunk,
      };

      const controller = new AbortController();

      const scope = currentRuntimeScope();
      assertRuntimeActive();
      const queuedAt = Date.now();
      scope?.observe?.({ queued: true });
      const release = await localInferenceScheduler.acquire(scope?.mode ?? "maintenance", scope?.signal);
      scope?.observe?.({ queued: false, queueWaitMs: Date.now() - queuedAt, embeddingCallCount: 1 });
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      try {
        assertRuntimeActive();
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: scope?.signal ? AbortSignal.any([controller.signal, scope.signal]) : controller.signal,
        });

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Embedding request failed: ${res.status} ${err}`);
        }

        const data = (await res.json()) as EmbeddingResponse;
        if (!data || !Array.isArray(data.data)) {
          throw new Error(`Invalid embedding response: missing "data" array in ${JSON.stringify(data).slice(0, 200)}`);
        }

        const ordered: number[][] = new Array(chunk.length).fill(null);
        let hasValidIndices = true;
        for (const item of data.data) {
          if (typeof item?.index === "number" && item.index >= 0 && item.index < chunk.length && Array.isArray(item.embedding)) {
            ordered[item.index] = item.embedding;
          } else {
            hasValidIndices = false;
            break;
          }
        }

        if (hasValidIndices && !ordered.some((x) => x === null)) {
          fetchedEmbeddings.push(...ordered);
        } else {
          const sorted = data.data
            .slice()
            .sort((a, b) => (typeof a.index === "number" && typeof b.index === "number" ? a.index - b.index : 0))
            .map((d) => d.embedding || []);
          fetchedEmbeddings.push(...sorted);
        }
      } finally {
        clearTimeout(timeoutId);
        release();
      }
    }

    // 2. Populate missing results and update cache
    for (let j = 0; j < missingIndices.length; j++) {
      const idx = missingIndices[j];
      const text = missingTexts[j];
      const emb = fetchedEmbeddings[j] || [];
      results[idx] = emb;

      if (emb.length > 0) {
        const cacheKey = `${this.modelConfig.model ?? "default"}::${text}`;
        if (this.cache.size >= EmbeddingService.CACHE_MAX_SIZE) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        this.cache.set(cacheKey, emb);
      }
    }

    return results as number[][];
  }
}
