import type { StoredChunk } from "./store";

export interface RetrievedChunk {
  filePath: string;
  heading: string;
  headingPath: string;
  text: string;
  score: number;
}

export function toRetrievedChunks(chunks: StoredChunk[]): RetrievedChunk[] {
  return chunks.map((c) => ({
    filePath: c.filePath,
    heading: c.heading,
    headingPath: c.headingPath,
    text: c.text,
    score: 0, // score not needed downstream
  }));
}
