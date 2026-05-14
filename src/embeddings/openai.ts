import type { EmbeddingProvider } from "./provider";

const BATCH_SIZE = 64;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai/text-embedding-3-large";
  readonly dimensions = 3072;
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
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-large",
        input: texts,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI Embeddings API error ${response.status}: ${err}`);
    }

    const json = await response.json();
    // Sort by index to preserve order
    return (json.data as { index: number; embedding: number[] }[])
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
