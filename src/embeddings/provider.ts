export interface EmbeddingProvider {
  /** Unique string stored in the index to detect provider mismatches */
  readonly id: string;
  readonly dimensions: number;
  /** Batch-embed texts. Returns one vector per input. */
  embed(texts: string[]): Promise<number[][]>;
}
