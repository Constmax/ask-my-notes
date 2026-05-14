import type { App, TFile } from "obsidian";
import { Notice } from "obsidian";
import type { EmbeddingProvider } from "../embeddings/provider";
import type { VectorStore } from "./store";
import { chunkFile } from "./chunker";

const EMBED_BATCH = 32;

export async function buildIndex(
  app: App,
  store: VectorStore,
  provider: EmbeddingProvider,
  excludedFolders: string[],
  chunkSize: number,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const files = app.vault
    .getMarkdownFiles()
    .filter((f) => !isExcluded(f.path, excludedFolders));

  const allChunks: ReturnType<typeof chunkFile> = [];
  for (const file of files) {
    const content = await app.vault.cachedRead(file);
    const chunks = chunkFile(content, file.path, chunkSize);
    allChunks.push(...chunks);
  }

  const total = allChunks.length;
  if (total === 0) {
    new Notice("No content found to index.", 3000);
    store.clear();
    return;
  }

  const storedChunks: import("./store").StoredChunk[] = [];
  let done = 0;

  for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_BATCH);
    const texts = batch.map((c) => c.text);
    const embeddings = await provider.embed(texts);

    for (let j = 0; j < batch.length; j++) {
      storedChunks.push({ ...batch[j], embedding: embeddings[j] });
    }

    done += batch.length;
    onProgress?.(done, total);
  }

  store.build(storedChunks, provider.id);
}

function isExcluded(path: string, excludedFolders: string[]): boolean {
  for (const folder of excludedFolders) {
    if (!folder) continue;
    if (path.startsWith(folder + "/") || path === folder) return true;
  }
  return false;
}
