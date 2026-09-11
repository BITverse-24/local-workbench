interface EmbeddingRequest {
  model: string;
  input: string | string[];
}

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class EmbeddingService {
  constructor(private modelConfig: any) {}

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const apiKey = process.env[this.modelConfig.apiKeyEnv || ""] || "";
    if (!apiKey) {
      throw new Error(`Missing API key for ${this.modelConfig.id}`);
    }

    const payload: EmbeddingRequest = {
      model: this.modelConfig.model,
      input: texts
    };

    const url = `${this.modelConfig.baseUrl}/embeddings`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
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
