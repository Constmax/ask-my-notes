import { Plugin, Notice, WorkspaceLeaf } from "obsidian";
import {
  AskMyNotesSettings,
  AskMyNotesSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";
import { ChatView, VIEW_TYPE } from "./view/ChatView";
import { VectorStore, PersistedIndex } from "./rag/store";
import { buildIndex } from "./rag/indexer";
import type { EmbeddingProvider } from "./embeddings/provider";
import { OllamaEmbeddingProvider } from "./embeddings/ollama";
import { OpenAIEmbeddingProvider } from "./embeddings/openai";
import { JinaEmbeddingProvider } from "./embeddings/jina";
import { decryptSecret } from "./keychain";

const INDEX_FILE = "ask-my-notes-index.json";

export default class AskMyNotesPlugin extends Plugin {
  settings!: AskMyNotesSettings;
  vectorStore!: VectorStore;
  embeddingProvider: EmbeddingProvider | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.vectorStore = new VectorStore();
    await this.loadIndex();

    this.refreshEmbeddingProvider();

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "reindex-vault",
      name: "Reindex vault",
      callback: () => this.reindexVault(),
    });

    this.addRibbonIcon("message-circle", "Ask My Notes", () =>
      this.activateChatView()
    );

    this.addSettingTab(new AskMyNotesSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshEmbeddingProvider();
  }

  refreshEmbeddingProvider(): void {
    const s = this.settings;
    switch (s.embeddingProvider) {
      case "ollama":
        this.embeddingProvider = new OllamaEmbeddingProvider(
          s.ollamaBaseUrl || "http://localhost:11434",
          s.ollamaModel || "jina/jina-embeddings-v2-base-de"
        );
        break;
      case "openai": {
        const key = decryptSecret(s.openaiApiKey);
        this.embeddingProvider = key ? new OpenAIEmbeddingProvider(key) : null;
        break;
      }
      case "jina": {
        const key = decryptSecret(s.jinaApiKey);
        this.embeddingProvider = key ? new JinaEmbeddingProvider(key) : null;
        break;
      }
      default:
        this.embeddingProvider = null;
    }
  }

  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async reindexVault(): Promise<void> {
    if (!this.embeddingProvider) {
      new Notice(
        "No embedding provider configured. Open Settings → Ask My Notes.",
        5000
      );
      return;
    }

    // Warn on provider mismatch so user knows a full reindex is happening
    const storedId = this.vectorStore.getProviderId();
    if (storedId && storedId !== this.embeddingProvider.id) {
      new Notice(
        `Embedding model changed (${storedId} → ${this.embeddingProvider.id}). Rebuilding full index…`,
        4000
      );
      this.vectorStore.clear();
    }

    const excludedFolders = this.settings.excludedFolders
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    let progressNotice: Notice | null = null;

    try {
      progressNotice = new Notice("Indexing vault… 0%", 0);

      await buildIndex(
        this.app,
        this.vectorStore,
        this.embeddingProvider,
        excludedFolders,
        this.settings.chunkSize,
        (done, total) => {
          const pct = Math.round((done / total) * 100);
          progressNotice?.setMessage(`Indexing vault… ${pct}%`);
        }
      );

      progressNotice.hide();
      new Notice(`Index built: ${this.vectorStore.size()} chunks indexed.`, 4000);

      await this.saveIndex();
      this.notifyChatViews();
    } catch (err) {
      progressNotice?.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Indexing failed: ${msg}`, 7000);
      console.error("[Ask My Notes] Indexing error:", err);
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.embeddingProvider) return;
    const data = this.vectorStore.serialize(this.embeddingProvider.id);
    const adapter = this.app.vault.adapter;
    const path = `${this.app.vault.configDir}/plugins/ask-my-notes/${INDEX_FILE}`;
    await adapter.write(path, JSON.stringify(data));
  }

  private async loadIndex(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const path = `${this.app.vault.configDir}/plugins/ask-my-notes/${INDEX_FILE}`;
      if (!(await adapter.exists(path))) return;
      const raw = await adapter.read(path);
      const data: PersistedIndex = JSON.parse(raw);
      if (data.version === 1 && Array.isArray(data.chunks)) {
        this.vectorStore.load(data);
        console.log(
          `[Ask My Notes] Loaded index: ${data.chunks.length} chunks (provider: ${data.providerId})`
        );
      }
    } catch (err) {
      console.warn("[Ask My Notes] Could not load index:", err);
    }
  }

  private notifyChatViews(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof ChatView) view.refreshStatus();
    });
  }
}
