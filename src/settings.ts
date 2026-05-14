import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type AskMyNotesPlugin from "./main";
import { OllamaEmbeddingProvider } from "./embeddings/ollama";
import { encryptSecret, decryptSecret, isKeychainAvailable } from "./keychain";

export type DeepSeekModel = "deepseek-v4-pro" | "deepseek-v4-flash";
export type EmbeddingProviderType = "ollama" | "openai" | "jina" | "none";

export interface AskMyNotesSettings {
  deepseekApiKey: string;
  deepseekModel: DeepSeekModel;
  embeddingProvider: EmbeddingProviderType;
  // Ollama
  ollamaBaseUrl: string;
  ollamaModel: string;
  // Cloud providers
  openaiApiKey: string;
  jinaApiKey: string;
  // RAG
  topK: number;
  chunkSize: number;
  excludedFolders: string;
  // Agent
  agentMode: boolean;
  agentMaxSteps: number;
  agentWriteConfirm: boolean;
}

export const DEFAULT_SETTINGS: AskMyNotesSettings = {
  deepseekApiKey: "",
  deepseekModel: "deepseek-v4-flash",
  embeddingProvider: "none",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "jina/jina-embeddings-v2-base-de",
  openaiApiKey: "",
  jinaApiKey: "",
  topK: 6,
  chunkSize: 500,
  excludedFolders: ".trash\ntemplates\nTemplates",
  agentMode: false,
  agentMaxSteps: 6,
  agentWriteConfirm: true,
};

export class AskMyNotesSettingTab extends PluginSettingTab {
  plugin: AskMyNotesPlugin;

  constructor(app: App, plugin: AskMyNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Ask My Notes" });

    if (isKeychainAvailable()) {
      containerEl.createEl("p", {
        text: "🔒 API keys are encrypted using your system keychain.",
        cls: "setting-item-description",
      });
    }

    // ── DeepSeek ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "LLM — DeepSeek" });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your DeepSeek API key (deepseek.com)")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(decryptSecret(this.plugin.settings.deepseekApiKey))
          .then((t) => (t.inputEl.type = "password"))
          .onChange(async (value) => {
            this.plugin.settings.deepseekApiKey = encryptSecret(value.trim());
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("deepseek-chat is fast; deepseek-reasoner thinks longer (slower, better for complex questions)")
      .addDropdown((dd) =>
        dd
          .addOption("deepseek-v4-flash", "deepseek-v4-flash (fast)")
          .addOption("deepseek-v4-pro", "deepseek-v4-pro (powerful)")
          .setValue(this.plugin.settings.deepseekModel)
          .onChange(async (value) => {
            this.plugin.settings.deepseekModel = value as DeepSeekModel;
            await this.plugin.saveSettings();
          })
      );

    // ── Embeddings ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Embeddings" });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc(
        "Ollama runs locally — no API key needed. Jina API has a generous free tier. OpenAI is paid but very fast."
      )
      .addDropdown((dd) =>
        dd
          .addOption("none", "— select a provider —")
          .addOption("ollama", "Ollama (local, recommended)")
          .addOption("jina", "Jina AI API (free tier)")
          .addOption("openai", "OpenAI (paid)")
          .setValue(this.plugin.settings.embeddingProvider)
          .onChange(async (value) => {
            this.plugin.settings.embeddingProvider = value as EmbeddingProviderType;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.embeddingProvider === "ollama") {
      containerEl.createEl("p", {
        text: "Ollama must be running (ollama serve) and the model must be pulled.",
        cls: "setting-item-description",
      });

      new Setting(containerEl)
        .setName("Ollama base URL")
        .setDesc("Default: http://localhost:11434")
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:11434")
            .setValue(this.plugin.settings.ollamaBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.ollamaBaseUrl = value.trim() || "http://localhost:11434";
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Model name")
        .setDesc(
          "Recommended for German: jina/jina-embeddings-v2-base-de  |  Strong multilingual: bge-m3  |  Fast general: nomic-embed-text"
        )
        .addText((text) =>
          text
            .setPlaceholder("jina/jina-embeddings-v2-base-de")
            .setValue(this.plugin.settings.ollamaModel)
            .onChange(async (value) => {
              this.plugin.settings.ollamaModel = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Test connection")
        .setDesc("Checks that Ollama is running and the model is available.")
        .addButton((btn) =>
          btn
            .setButtonText("Test")
            .onClick(async () => {
              btn.setDisabled(true);
              btn.setButtonText("Testing…");
              try {
                const provider = new OllamaEmbeddingProvider(
                  this.plugin.settings.ollamaBaseUrl,
                  this.plugin.settings.ollamaModel
                );
                await provider.testConnection();
                new Notice(`✓ Ollama connected — model "${this.plugin.settings.ollamaModel}" is ready.`, 4000);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                new Notice(`✗ ${msg}`, 6000);
              } finally {
                btn.setDisabled(false);
                btn.setButtonText("Test");
              }
            })
        );
    }

    if (this.plugin.settings.embeddingProvider === "jina") {
      new Setting(containerEl)
        .setName("Jina API Key")
        .setDesc("Free key at jina.ai — includes 1M tokens/month. Model used: jina-embeddings-v3.")
        .addText((text) =>
          text
            .setPlaceholder("jina_...")
            .setValue(decryptSecret(this.plugin.settings.jinaApiKey))
            .then((t) => (t.inputEl.type = "password"))
            .onChange(async (value) => {
              this.plugin.settings.jinaApiKey = encryptSecret(value.trim());
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.embeddingProvider === "openai") {
      new Setting(containerEl)
        .setName("OpenAI API Key")
        .setDesc("Used only for embeddings (text-embedding-3-large). ~$0.13/1M tokens.")
        .addText((text) =>
          text
            .setPlaceholder("sk-...")
            .setValue(decryptSecret(this.plugin.settings.openaiApiKey))
            .then((t) => (t.inputEl.type = "password"))
            .onChange(async (value) => {
              this.plugin.settings.openaiApiKey = encryptSecret(value.trim());
              await this.plugin.saveSettings();
            })
        );
    }

    // ── RAG ───────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Retrieval" });

    new Setting(containerEl)
      .setName("Top-K chunks")
      .setDesc("Number of note chunks passed to the LLM per query (default 6)")
      .addSlider((sl) =>
        sl
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.topK)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.topK = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Chunk size (approx. tokens)")
      .setDesc("Maximum size of each note chunk (default 500)")
      .addText((text) =>
        text
          .setPlaceholder("500")
          .setValue(String(this.plugin.settings.chunkSize))
          .onChange(async (value) => {
            const n = parseInt(value);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.chunkSize = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("One folder path per line. Notes inside won't be indexed.")
      .addTextArea((ta) =>
        ta
          .setPlaceholder(".trash\ntemplates")
          .setValue(this.plugin.settings.excludedFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Index ─────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Index" });

    new Setting(containerEl)
      .setName("Reindex vault")
      .setDesc("Scans all notes, creates embeddings and rebuilds the search index.")
      .addButton((btn) =>
        btn
          .setButtonText("Reindex now")
          .setCta()
          .onClick(async () => {
            if (this.plugin.settings.embeddingProvider === "none") {
              new Notice("Please configure an embedding provider first.", 4000);
              return;
            }
            await this.plugin.reindexVault();
          })
      );
  }
}
