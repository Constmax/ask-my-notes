import type { EmbeddingProvider } from "./provider";

const BATCH_SIZE = 64;

export class JinaEmbeddingProvider implements EmbeddingProvider {
  readonly id = "jina/jina-embeddings-v3";
  readonly dimensions = 1024;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const embeddings = await this.embedBatch(batch);
      results.push(...embeddings);
    }
    return results;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch("https://api.jina.ai/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "jina-embeddings-v3",
        input: texts,
        task: "retrieval.passage",
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Jina Embeddings API error ${response.status}: ${err}`);
    }

    const json = await response.json();
    return (json.data as { index: number; embedding: number[] }[])
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
