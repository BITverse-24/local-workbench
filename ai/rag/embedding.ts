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
  constructor(private modelConfig: EmbeddingConfig | any) {}

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const apiKey = this.modelConfig.apiKey || process.env[this.modelConfig.apiKeyEnv || ""] || "";

    const payload: EmbeddingRequest = {
      model: this.modelConfig.model,
      input: texts
    };

    const baseUrl = (this.modelConfig.baseUrl || "http://localhost:1234/v1").replace(/\/+$/, "");
    const url = `${baseUrl}/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

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
    const embeddings = data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    return embeddings;
  }
}
