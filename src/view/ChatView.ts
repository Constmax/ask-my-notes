import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, TFile, setIcon } from "obsidian";
import type AskMyNotesPlugin from "../main";
import type { ChatMessage } from "../llm/prompt";
import type { RetrievedChunk } from "../rag/retriever";
import { toRetrievedChunks } from "../rag/retriever";
import { buildMessages, buildAgentMessages } from "../llm/prompt";
import { DeepSeekClient, DeepSeekError } from "../llm/deepseek";
import { decryptSecret } from "../keychain";
import type { DeepSeekModel } from "../settings";
import { runAgent } from "../llm/agent";
import type { ToolContext } from "../llm/tools";
import { loadWorkflows, applyWorkflow, workflowDescription } from "../llm/workflows";
import type { Workflow } from "../llm/workflows";

export const VIEW_TYPE = "ask-my-notes-chat";

const TOOL_LABELS: Record<string, string> = {
  search_notes: "Suche Notizen",
  read_note: "Lese Notiz",
  list_notes: "Alle Notizen auflisten",
  get_active_note: "Aktive Notiz lesen",
  write_note: "Schreibe Notiz",
  append_to_note: "Ergänze Notiz",
  move_note: "Verschiebe Notiz",
};

const EFFORT_LEVELS: { label: string; budget: number }[] = [
  { label: "Fast", budget: 1024 },
  { label: "Normal", budget: 4096 },
  { label: "Deep", budget: 16384 },
];

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  sources?: RetrievedChunk[];
}

export class ChatView extends ItemView {
  plugin: AskMyNotesPlugin;
  private history: ChatMessage[] = [];
  private displayMessages: DisplayMessage[] = [];

  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private effortRow!: HTMLElement;

  private activeModel!: DeepSeekModel;
  private thinkingBudget = 4096;
  private agentMode = false;
  private writeConfirm = true;
  private modelBtns = new Map<DeepSeekModel, HTMLButtonElement>();
  private effortBtns = new Map<number, HTMLButtonElement>();
  private chatModeBtn!: HTMLButtonElement;
  private agentModeBtn!: HTMLButtonElement;
  private writeConfirmGroup!: HTMLElement;
  private writeAutoBtn!: HTMLButtonElement;
  private writeConfirmBtn!: HTMLButtonElement;

  private abortController: AbortController | null = null;

  private workflows: Workflow[] = [];
  private activeWorkflow: Workflow | null = null;
  private slashMenuEl!: HTMLElement;
  private slashMenuIndex = 0;
  private workflowBadgeEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: AskMyNotesPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Ask My Notes";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    this.activeModel = this.plugin.settings.deepseekModel;
    this.agentMode = this.plugin.settings.agentMode;
    this.writeConfirm = this.plugin.settings.agentWriteConfirm;
    this.workflows = await loadWorkflows(this.app);

    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("ask-my-notes-view");

    this.messagesEl = root.createDiv("ask-my-notes-messages");
    this.renderEmpty();

    this.messagesEl.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement).closest("a.internal-link") as HTMLAnchorElement | null;
      if (!link) return;
      e.preventDefault();
      const href = link.dataset.href ?? link.getAttribute("href");
      if (!href) return;
      const file = this.app.metadataCache.getFirstLinkpathDest(href, "");
      if (file instanceof TFile) {
        this.app.workspace.getLeaf(false).openFile(file);
      }
    });

    const inputArea = root.createDiv("ask-my-notes-input-area");

    // ── Toolbar ─────────────────────────────────────────────────────────────
    const toolbar = inputArea.createDiv("ask-my-notes-toolbar");

    // Model buttons
    const modelGroup = toolbar.createDiv("ask-my-notes-btn-group");
    for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"] as DeepSeekModel[]) {
      const label = model === "deepseek-v4-flash" ? "Flash" : "Pro";
      const btn = modelGroup.createEl("button", { cls: "ask-my-notes-toggle-btn", text: label });
      this.modelBtns.set(model, btn);
      btn.addEventListener("click", () => this.setModel(model));
    }

    // Effort buttons (Pro only)
    this.effortRow = toolbar.createDiv("ask-my-notes-btn-group ask-my-notes-effort-group");
    for (const { label, budget } of EFFORT_LEVELS) {
      const btn = this.effortRow.createEl("button", { cls: "ask-my-notes-toggle-btn", text: label });
      this.effortBtns.set(budget, btn);
      btn.addEventListener("click", () => this.setEffort(budget));
    }

    // Mode buttons (Chat / Agent)
    const modeGroup = toolbar.createDiv("ask-my-notes-btn-group");
    this.chatModeBtn = modeGroup.createEl("button", {
      cls: "ask-my-notes-toggle-btn",
      text: "Chat",
    });
    this.agentModeBtn = modeGroup.createEl("button", {
      cls: "ask-my-notes-toggle-btn",
      text: "Agent",
    });
    this.chatModeBtn.addEventListener("click", () => this.setAgentMode(false));
    this.agentModeBtn.addEventListener("click", () => this.setAgentMode(true));

    // Write-confirm toggle (only visible in agent mode)
    this.writeConfirmGroup = toolbar.createDiv("ask-my-notes-btn-group");
    this.writeAutoBtn = this.writeConfirmGroup.createEl("button", {
      cls: "ask-my-notes-toggle-btn",
      text: "Auto",
    });
    this.writeConfirmBtn = this.writeConfirmGroup.createEl("button", {
      cls: "ask-my-notes-toggle-btn",
      text: "Bestätigen",
    });
    this.writeAutoBtn.addEventListener("click", () => this.setWriteConfirm(false));
    this.writeConfirmBtn.addEventListener("click", () => this.setWriteConfirm(true));

    // New chat button
    const newChatBtn = toolbar.createEl("button", {
      cls: "ask-my-notes-new-chat-btn",
      attr: { "aria-label": "Neuen Chat starten" },
    });
    setIcon(newChatBtn, "rotate-ccw");
    newChatBtn.addEventListener("click", () => this.clearChat());

    this.syncToolbar();

    // ── Slash menu (positioned above textarea via CSS) ──────────────────────
    this.slashMenuEl = inputArea.createDiv("ask-my-notes-slash-menu");
    this.slashMenuEl.style.display = "none";

    // ── Text input ───────────────────────────────────────────────────────────
    this.inputEl = inputArea.createEl("textarea", {
      cls: "ask-my-notes-input",
      attr: { placeholder: "Ask a question… or type / for workflows" },
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (this.slashMenuEl.style.display !== "none") {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.moveSlashMenu(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.moveSlashMenu(-1);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this.selectSlashMenuItem();
          return;
        }
        if (e.key === "Escape") {
          this.hideSlashMenu();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });

    this.inputEl.addEventListener("input", () => {
      const val = this.inputEl.value;
      if (val.startsWith("/")) {
        const term = val.slice(1).toLowerCase();
        const matches = this.workflows.filter((w) =>
          w.name.toLowerCase().startsWith(term)
        );
        this.showSlashMenu(matches);
      } else {
        this.hideSlashMenu();
      }
    });

    const row = inputArea.createDiv("ask-my-notes-input-row");
    this.statusEl = row.createDiv("ask-my-notes-hint");

    this.workflowBadgeEl = row.createDiv("ask-my-notes-workflow-badge");
    this.workflowBadgeEl.style.display = "none";

    this.sendBtn = row.createEl("button", {
      cls: "ask-my-notes-send-btn",
      text: "Send",
    });
    this.sendBtn.addEventListener("click", () => this.submit());

    this.updateStatus();
  }

  // ── Slash menu ─────────────────────────────────────────────────────────────

  private showSlashMenu(workflows: Workflow[]): void {
    this.slashMenuEl.empty();
    if (workflows.length === 0) {
      this.hideSlashMenu();
      return;
    }
    this.slashMenuIndex = 0;
    workflows.forEach((w, i) => {
      const item = this.slashMenuEl.createDiv(
        "ask-my-notes-slash-item" + (i === 0 ? " is-selected" : "")
      );
      item.createDiv({ cls: "ask-my-notes-slash-item-name", text: `/${w.name}` });
      const desc = workflowDescription(w.content);
      if (desc) item.createDiv({ cls: "ask-my-notes-slash-item-desc", text: desc });
      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep textarea focused
        this.selectWorkflow(w);
      });
    });
    this.slashMenuEl.style.display = "block";
  }

  private hideSlashMenu(): void {
    this.slashMenuEl.style.display = "none";
  }

  private moveSlashMenu(dir: 1 | -1): void {
    const items = Array.from(
      this.slashMenuEl.querySelectorAll<HTMLElement>(".ask-my-notes-slash-item")
    );
    items[this.slashMenuIndex]?.classList.remove("is-selected");
    this.slashMenuIndex = Math.max(0, Math.min(items.length - 1, this.slashMenuIndex + dir));
    items[this.slashMenuIndex]?.classList.add("is-selected");
  }

  private selectSlashMenuItem(): void {
    const val = this.inputEl.value;
    const term = val.slice(1).toLowerCase();
    const matches = this.workflows.filter((w) => w.name.toLowerCase().startsWith(term));
    const selected = matches[this.slashMenuIndex];
    if (selected) this.selectWorkflow(selected);
  }

  private selectWorkflow(workflow: Workflow): void {
    this.activeWorkflow = workflow;
    this.inputEl.value = "";
    this.hideSlashMenu();

    this.workflowBadgeEl.empty();
    this.workflowBadgeEl.style.display = "flex";
    this.workflowBadgeEl.createSpan({ text: `/${workflow.name}` });
    const clearBtn = this.workflowBadgeEl.createSpan({
      cls: "ask-my-notes-workflow-badge-clear",
      text: "×",
    });
    clearBtn.addEventListener("click", () => this.clearWorkflow());

    this.inputEl.focus();
  }

  private clearWorkflow(): void {
    this.activeWorkflow = null;
    this.workflowBadgeEl.style.display = "none";
    this.workflowBadgeEl.empty();
  }

  // ── Toolbar ────────────────────────────────────────────────────────────────

  private setModel(model: DeepSeekModel): void {
    this.activeModel = model;
    this.syncToolbar();
  }

  private setEffort(budget: number): void {
    this.thinkingBudget = budget;
    this.syncToolbar();
  }

  private async setAgentMode(enabled: boolean): Promise<void> {
    this.agentMode = enabled;
    this.plugin.settings.agentMode = enabled;
    await this.plugin.saveSettings();
    this.syncToolbar();
  }

  private async setWriteConfirm(enabled: boolean): Promise<void> {
    this.writeConfirm = enabled;
    this.plugin.settings.agentWriteConfirm = enabled;
    await this.plugin.saveSettings();
    this.syncToolbar();
  }

  private syncToolbar(): void {
    for (const [model, btn] of this.modelBtns) {
      btn.toggleClass("is-active", model === this.activeModel);
    }
    const isReasoner = this.activeModel === "deepseek-v4-pro";
    this.effortRow.style.display = isReasoner ? "" : "none";
    for (const [budget, btn] of this.effortBtns) {
      btn.toggleClass("is-active", budget === this.thinkingBudget);
    }
    this.chatModeBtn?.toggleClass("is-active", !this.agentMode);
    this.agentModeBtn?.toggleClass("is-active", this.agentMode);
    this.writeConfirmGroup.style.display = this.agentMode ? "" : "none";
    this.writeAutoBtn?.toggleClass("is-active", !this.writeConfirm);
    this.writeConfirmBtn?.toggleClass("is-active", this.writeConfirm);
  }

  async onClose(): Promise<void> {
    this.abortController?.abort();
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  private clearChat(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.history = [];
    this.displayMessages = [];
    this.renderEmpty();
  }

  private renderEmpty(): void {
    this.messagesEl.empty();
    this.messagesEl.createDiv({
      cls: "ask-my-notes-empty",
      text: "Ask anything about your notes.\nType / to run a workflow.",
    });
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  private async submit(): Promise<void> {
    const rawQuery = this.inputEl.value.trim();
    if (!rawQuery || this.abortController) return;

    const deepseekKey = decryptSecret(this.plugin.settings.deepseekApiKey);
    if (!deepseekKey) {
      new Notice("Please enter your DeepSeek API key in settings.", 4000);
      return;
    }

    const workflow = this.activeWorkflow;
    const query = workflow ? applyWorkflow(workflow, rawQuery) : rawQuery;
    const useAgent = this.agentMode || workflow !== null;

    const indexSize = this.plugin.vectorStore?.size() ?? 0;
    if (indexSize === 0 && this.plugin.settings.embeddingProvider !== "none" && !useAgent) {
      new Notice("Index is empty. Run 'Ask My Notes: Reindex vault' first.", 4000);
    }

    this.inputEl.value = "";
    this.clearWorkflow();
    this.addUserMessage(rawQuery);

    const assistantMsg = this.addAssistantMessage("", []);
    const bubbleEl = assistantMsg.querySelector(".ask-my-notes-bubble") as HTMLElement;

    this.abortController = new AbortController();
    this.sendBtn.disabled = true;
    this.sendBtn.textContent = "Stop";
    this.sendBtn.onclick = () => this.abortController?.abort();

    try {
      if (useAgent) {
        await this.submitAgent(query, assistantMsg, bubbleEl, deepseekKey);
      } else {
        await this.submitChat(query, assistantMsg, bubbleEl, deepseekKey);
      }
    } finally {
      this.abortController = null;
      this.sendBtn.disabled = false;
      this.sendBtn.textContent = "Send";
      this.sendBtn.onclick = () => this.submit();
    }
  }

  private async submitChat(
    query: string,
    assistantMsg: HTMLElement,
    bubbleEl: HTMLElement,
    deepseekKey: string
  ): Promise<void> {
    let fullText = "";
    let chunks: RetrievedChunk[] = [];

    try {
      if (this.plugin.vectorStore && this.plugin.vectorStore.size() > 0) {
        const ep = this.plugin.embeddingProvider;
        if (ep) {
          const [queryEmbedding] = await ep.embed([query]);
          chunks = toRetrievedChunks(
            this.plugin.vectorStore.search(queryEmbedding, this.plugin.settings.topK)
          );
        }
      }

      const messages = buildMessages(this.history, query, chunks);
      const client = new DeepSeekClient(deepseekKey, this.activeModel);

      await client.chat(
        messages,
        (token) => {
          fullText += token;
          bubbleEl.textContent = fullText;
          this.scrollToBottom();
        },
        this.abortController!.signal,
        this.activeModel === "deepseek-v4-pro" ? { thinkingBudget: this.thinkingBudget } : undefined
      );

      await this.renderMarkdown(fullText, bubbleEl);
      this.scrollToBottom();

      this.history.push({ role: "user", content: query });
      this.history.push({ role: "assistant", content: fullText });

      if (chunks.length > 0) {
        this.renderSources(assistantMsg, chunks);
      }
    } catch (err) {
      this.handleError(err, fullText, bubbleEl);
    }
  }

  private async submitAgent(
    query: string,
    assistantMsg: HTMLElement,
    bubbleEl: HTMLElement,
    deepseekKey: string
  ): Promise<void> {
    const stepsEl = assistantMsg.createDiv("ask-my-notes-steps");
    assistantMsg.insertBefore(stepsEl, bubbleEl);

    let fullText = "";
    const stepEls = new Map<number, { markDone: (result: unknown) => void }>();

    try {
      const messages = buildAgentMessages(this.history, query);
      const client = new DeepSeekClient(deepseekKey, this.activeModel);
      const ctx: ToolContext = {
        app: this.app,
        vectorStore: this.plugin.vectorStore,
        embeddingProvider: this.plugin.embeddingProvider,
        topK: this.plugin.settings.topK,
      };

      const { allChunks, reasoningContent } = await runAgent(
        messages,
        client,
        ctx,
        {
          onToken: (token) => {
            fullText += token;
            bubbleEl.textContent = fullText;
            this.scrollToBottom();
          },
          onThinking: (content, _step) => {
            this.renderThinkingStep(stepsEl, content);
            this.scrollToBottom();
          },
          onToolCall: (name, args, step) => {
            const controls = this.renderToolStep(stepsEl, name, args);
            stepEls.set(step, controls);
            this.scrollToBottom();
          },
          onToolResult: (_name, result, _chunks, step) => {
            stepEls.get(step)?.markDone(result);
            this.scrollToBottom();
          },
          confirmTool: this.writeConfirm
            ? (name, args) => this.promptConfirm(stepsEl, name, args)
            : undefined,
        },
        this.abortController!.signal,
        this.plugin.settings.agentMaxSteps,
        this.activeModel === "deepseek-v4-pro" ? { thinkingBudget: this.thinkingBudget } : undefined
      );

      if (fullText) {
        await this.renderMarkdown(fullText, bubbleEl);
      } else {
        bubbleEl.textContent = "(no response)";
      }
      this.scrollToBottom();

      this.history.push({ role: "user", content: query });
      this.history.push({
        role: "assistant",
        content: fullText,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      });

      if (allChunks.length > 0) {
        this.renderSources(assistantMsg, allChunks);
      }
    } catch (err) {
      this.handleError(err, fullText, bubbleEl);
    }
  }

  // ── Write confirmation ─────────────────────────────────────────────────────

  private promptConfirm(
    container: HTMLElement,
    name: string,
    args: Record<string, unknown>
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const el = container.createDiv("ask-my-notes-confirm");
      el.createSpan({
        cls: "ask-my-notes-confirm-label",
        text: `⚠ ${name}(${this.formatArgsPreview(args)}) — Erlauben?`,
      });
      const jaBtn = el.createEl("button", { cls: "ask-my-notes-confirm-btn is-allow", text: "Ja" });
      const neinBtn = el.createEl("button", { cls: "ask-my-notes-confirm-btn is-deny", text: "Nein" });
      this.scrollToBottom();

      const done = (allowed: boolean): void => {
        el.empty();
        el.createSpan({
          cls: `ask-my-notes-confirm-result ${allowed ? "is-allowed" : "is-denied"}`,
          text: allowed ? `✓ ${name} erlaubt` : `✗ ${name} abgelehnt`,
        });
        resolve(allowed);
      };

      jaBtn.addEventListener("click", () => done(true));
      neinBtn.addEventListener("click", () => done(false));
    });
  }

  // ── Tool step rendering ────────────────────────────────────────────────────

  private renderThinkingStep(container: HTMLElement, content: string): void {
    const stepEl = container.createDiv("ask-my-notes-step is-thinking");

    const headerEl = stepEl.createDiv({
      cls: "ask-my-notes-step-header is-thinking",
      text: "💭 Denken…",
    });

    const bodyEl = stepEl.createDiv("ask-my-notes-step-body");
    bodyEl.createDiv({ cls: "ask-my-notes-step-thinking-content", text: content });

    headerEl.addEventListener("click", () => {
      const collapsed = bodyEl.style.display === "none";
      bodyEl.style.display = collapsed ? "block" : "none";
    });
  }

  private getToolKeyArg(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case "search_notes": return String(args.query ?? "");
      case "read_note": return String(args.path ?? "");
      case "write_note": return String(args.path ?? "");
      case "append_to_note": return String(args.path ?? "");
      case "move_note": return `${args.from} → ${args.to}`;
      default: return "";
    }
  }

  private formatToolResultText(name: string, result: unknown): string {
    const r = result as Record<string, unknown>;
    if (r.error) return `Fehler: ${r.error as string}`;

    switch (name) {
      case "search_notes": {
        const results = (r.results as { filePath: string; headingPath?: string }[]) ?? [];
        if (results.length === 0) return "Keine Treffer gefunden.";
        return results
          .map((c) => (c.headingPath ? `${c.filePath} › ${c.headingPath}` : c.filePath))
          .join("\n");
      }
      case "read_note": {
        const content = (r.content as string) ?? "";
        return content.slice(0, 500) + (content.length > 500 ? "\n…" : "");
      }
      case "list_notes": {
        const paths = (r.paths as string[]) ?? [];
        const total = (r.total as number) ?? paths.length;
        const list = paths.join("\n");
        return total > paths.length ? `${list}\n… (${total} gesamt)` : list;
      }
      case "get_active_note": {
        const content = (r.content as string) ?? "";
        return `${r.path}\n\n${content.slice(0, 300)}${content.length > 300 ? "\n…" : ""}`;
      }
      case "write_note": {
        const verb = r.created ? "Erstellt" : "Aktualisiert";
        return `${verb}: ${r.path} (${r.bytes} Zeichen)`;
      }
      case "append_to_note":
        return `Ergänzt: ${r.path} (+${r.appended} Zeichen)`;
      case "move_note":
        return `Verschoben: ${r.from} → ${r.to}`;
      default:
        return JSON.stringify(result, null, 2);
    }
  }

  private renderToolStep(
    container: HTMLElement,
    name: string,
    args: Record<string, unknown>
  ): { markDone: (result: unknown) => void } {
    const stepEl = container.createDiv("ask-my-notes-step");

    const label = TOOL_LABELS[name] ?? name;
    const keyArg = this.getToolKeyArg(name, args);
    const headerText = keyArg ? `${label} — "${keyArg}"` : label;

    const headerEl = stepEl.createDiv({
      cls: "ask-my-notes-step-header is-running",
      text: `⚙ ${headerText}`,
    });

    const bodyEl = stepEl.createDiv("ask-my-notes-step-body");
    bodyEl.style.display = "none";

    headerEl.addEventListener("click", () => {
      const collapsed = bodyEl.style.display === "none";
      bodyEl.style.display = collapsed ? "block" : "none";
    });

    const markDone = (result: unknown): void => {
      headerEl.removeClass("is-running");
      headerEl.addClass("is-done");
      headerEl.textContent = `✓ ${headerText}`;
      bodyEl.createDiv({
        cls: "ask-my-notes-step-result-text",
        text: this.formatToolResultText(name, result),
      });
    };

    return { markDone };
  }

  private formatArgsPreview(args: Record<string, unknown>): string {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";
    const [key, val] = entries[0];
    const valStr = typeof val === "string" ? `"${val.slice(0, 40)}"` : String(val);
    return entries.length > 1 ? `${key}: ${valStr}, …` : `${key}: ${valStr}`;
  }

  // ── Error handling ─────────────────────────────────────────────────────────

  private handleError(err: unknown, fullText: string, bubbleEl: HTMLElement): void {
    if (err instanceof Error && err.name === "AbortError") {
      if (fullText) {
        void this.renderMarkdown(fullText, bubbleEl);
      } else {
        bubbleEl.textContent = "(stopped)";
      }
    } else if (err instanceof DeepSeekError) {
      const msg =
        err.status === 401
          ? "Invalid DeepSeek API key. Check your settings."
          : err.status === 429
          ? "Rate limit reached. Try again in a moment."
          : `DeepSeek error: ${err.message}`;
      bubbleEl.textContent = msg;
      new Notice(msg, 5000);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      bubbleEl.textContent = `Error: ${msg}`;
      new Notice(`Error: ${msg}`, 5000);
    }
  }

  // ── Rendering helpers ──────────────────────────────────────────────────────

  private async renderMarkdown(markdown: string, el: HTMLElement): Promise<void> {
    el.empty();
    await MarkdownRenderer.render(this.app, markdown, el, "", this);
  }

  private addUserMessage(text: string): HTMLElement {
    if (this.displayMessages.length === 0) this.messagesEl.empty();
    this.displayMessages.push({ role: "user", content: text });

    const msgEl = this.messagesEl.createDiv("ask-my-notes-message user");
    msgEl.createDiv({ cls: "ask-my-notes-bubble", text });
    this.scrollToBottom();
    return msgEl;
  }

  private addAssistantMessage(text: string, sources: RetrievedChunk[]): HTMLElement {
    this.displayMessages.push({ role: "assistant", content: text, sources });

    const msgEl = this.messagesEl.createDiv("ask-my-notes-message assistant");
    msgEl.createDiv({ cls: "ask-my-notes-bubble", text: text || "…" });
    this.scrollToBottom();
    return msgEl;
  }

  private renderSources(msgEl: HTMLElement, chunks: RetrievedChunk[]): void {
    const seen = new Set<string>();
    const unique = chunks.filter((c) => {
      if (seen.has(c.filePath)) return false;
      seen.add(c.filePath);
      return true;
    });

    const sourcesEl = msgEl.createDiv("ask-my-notes-sources");
    const toggle = sourcesEl.createDiv({
      cls: "ask-my-notes-sources-toggle",
      text: `▶ ${unique.length} source${unique.length !== 1 ? "s" : ""}`,
    });

    const list = sourcesEl.createDiv("ask-my-notes-sources-list");
    list.style.display = "none";

    toggle.addEventListener("click", () => {
      const collapsed = list.style.display === "none";
      list.style.display = collapsed ? "flex" : "none";
      toggle.textContent = `${collapsed ? "▼" : "▶"} ${unique.length} source${
        unique.length !== 1 ? "s" : ""
      }`;
    });

    for (const chunk of unique) {
      const label = chunk.headingPath
        ? `${chunk.filePath} › ${chunk.headingPath}`
        : chunk.filePath;
      const linkEl = list.createDiv({ cls: "ask-my-notes-source-link", text: label });
      linkEl.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(chunk.filePath);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      });
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private updateStatus(): void {
    const size = this.plugin.vectorStore?.size() ?? 0;
    this.statusEl.textContent =
      size > 0 ? `${size} chunks indexed` : "Not indexed — use 'Reindex vault'";
  }

  refreshStatus(): void {
    this.updateStatus();
  }
}
