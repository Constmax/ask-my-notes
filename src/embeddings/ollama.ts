import type { EmbeddingProvider } from "./provider";

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  dimensions: number;
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.id = `ollama/${model}`;
    // Dimensions are unknown until the first embed call; we detect them then.
    this.dimensions = 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const embedding = await this.embedOne(text);
      if (this.dimensions === 0) this.dimensions = embedding.length;
      results.push(embedding);
    }
    return results;
  }

  private async embedOne(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      const err = await response.text();
      if (response.status === 404) {
        throw new Error(
          `Ollama model "${this.model}" not found. Run: ollama pull ${this.model}`
        );
      }
      throw new Error(`Ollama API error ${response.status}: ${err}`);
    }

    const json = await response.json();
    // Ollama /api/embed returns { embeddings: number[][] }
    const embeddings: number[][] = json.embeddings;
    if (!embeddings || embeddings.length === 0) {
      throw new Error("Ollama returned no embeddings");
    }
    return embeddings[0];
  }

  async testConnection(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(
        `Cannot reach Ollama at ${this.baseUrl}. Is "ollama serve" running?`
      );
    }
    const json = await response.json();
    const models: { name: string }[] = json.models ?? [];
    const available = models.some(
      (m) => m.name === this.model || m.name.startsWith(this.model + ":")
    );
    if (!available) {
      throw new Error(
        `Model "${this.model}" is not pulled yet. Run: ollama pull ${this.model}`
      );
    }
  }
}
