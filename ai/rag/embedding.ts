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

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: Array<number[] | null> = new Array(texts.length).fill(null);
    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    // 1. Check cache for each text
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
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
      "Content-Type": "application/json"
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
        input: chunk
      };

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Embedding request failed: ${res.status} ${err}`);
      }

      const data = (await res.json()) as EmbeddingResponse;
      const chunkEmbeddings = data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
      fetchedEmbeddings.push(...chunkEmbeddings);
    }

    // 2. Populate missing results and update cache
    for (let j = 0; j < missingIndices.length; j++) {
      const idx = missingIndices[j];
      const text = missingTexts[j];
      const emb = fetchedEmbeddings[j];
      results[idx] = emb;

      const cacheKey = `${this.modelConfig.model ?? "default"}::${text}`;
      if (this.cache.size >= EmbeddingService.CACHE_MAX_SIZE) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
      this.cache.set(cacheKey, emb);
    }

    return results as number[][];
  }
}
