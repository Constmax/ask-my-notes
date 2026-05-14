import type { Chunk } from "./chunker";

export interface StoredChunk extends Chunk {
  embedding: number[];
}

export interface PersistedIndex {
  version: number;
  providerId: string;
  chunks: StoredChunk[];
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(v: number[]): number {
  return Math.sqrt(dotProduct(v, v));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const mag = magnitude(a) * magnitude(b);
  if (mag === 0) return 0;
  return dotProduct(a, b) / mag;
}

export class VectorStore {
  private chunks: StoredChunk[] = [];
  private providerId = "";

  load(index: PersistedIndex): void {
    this.chunks = index.chunks;
    this.providerId = index.providerId;
  }

  build(chunks: StoredChunk[], providerId: string): void {
    this.chunks = chunks;
    this.providerId = providerId;
  }

  search(queryEmbedding: number[], topK: number): StoredChunk[] {
    if (this.chunks.length === 0) return [];

    const scored = this.chunks.map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.chunk);
  }

  serialize(providerId: string): PersistedIndex {
    return {
      version: 1,
      providerId,
      chunks: this.chunks,
    };
  }

  size(): number {
    return this.chunks.length;
  }

  getProviderId(): string {
    return this.providerId;
  }

  clear(): void {
    this.chunks = [];
    this.providerId = "";
  }
}
