# Ask My Notes

An Obsidian plugin that lets you chat with your vault using DeepSeek AI. It finds relevant notes via semantic search and uses them as context for the LLM — or lets the LLM search autonomously in Agent mode.

---

## Features

- **Chat mode** — Classic RAG: embeds your query, finds the top-K most relevant note chunks, and sends them to DeepSeek as context.
- **Agent mode** — The LLM uses read-only tools to search, read, and navigate your vault autonomously over multiple reasoning steps.
- **Streaming responses** — Tokens appear in real time; Markdown is rendered after completion.
- **Source links** — Every answer shows which notes it drew from (deduplicated, clickable).
- **Multi-model support** — Switch between `deepseek-v4-flash` (fast) and `deepseek-v4-pro` (powerful) per conversation.
- **Thinking effort** — When using Pro, choose Fast / Normal / Deep to control the reasoning budget.
- **Encrypted API keys** — Keys are stored via macOS Keychain / Windows DPAPI, never in plain text.

---

## Setup

### 1. Install the plugin

Copy (or symlink) this folder to `.obsidian/plugins/ask-my-notes/` in your vault, then enable it under **Settings → Community plugins**.

### 2. Configure DeepSeek

Open **Settings → Ask My Notes**:

- Enter your **DeepSeek API key** (get one at [deepseek.com](https://platform.deepseek.com)).
- Choose a **model**: Flash is faster and cheaper; Pro reasons more carefully for complex questions.

### 3. Configure an embedding provider

Embeddings convert your notes and queries into vectors so the plugin can find relevant content. Pick one:

| Provider | Cost | Recommended for |
|---|---|---|
| **Ollama** (local) | Free | Privacy-first, offline use |
| **Jina AI** | Free tier (1M tokens/month) | Easy cloud setup |
| **OpenAI** | Paid (~$0.13/1M tokens) | Highest quality |

**Ollama setup** (recommended):
1. Install [Ollama](https://ollama.com) and run `ollama serve`.
2. Pull a model: `ollama pull jina/jina-embeddings-v2-base-de` (good for German) or `ollama pull nomic-embed-text`.
3. In settings, set the base URL (`http://localhost:11434`) and model name, then click **Test**.

### 4. Index your vault

Click **Reindex now** in settings (or run the command **Ask My Notes: Reindex vault**). A progress notice shows indexing status. The index is saved as `ask-my-notes-index.json` in the plugin folder.

> Re-index after adding or significantly changing notes. Switching embedding providers triggers an automatic full rebuild.

---

## Usage

Open the chat panel via the ribbon icon (💬) or the command **Ask My Notes: Open chat**.

### Chat mode (default)

Type a question and press **Enter** (or click **Send**). The plugin:
1. Embeds your query.
2. Retrieves the top-K most similar note chunks from the index.
3. Sends them to DeepSeek along with your question.
4. Streams the response token by token.
5. Shows a collapsible **sources** list below the answer.

Use **Shift+Enter** for a newline within the input box.

### Agent mode

Click the **Agent** button in the toolbar to switch modes. In Agent mode:

1. The LLM receives no pre-fetched context. Instead it decides which tools to call.
2. Each tool call is shown as a collapsible **step bubble** with a pulsing indicator while running (✓ when done).
3. Click any step bubble to expand the raw tool result.
4. After all steps, the LLM streams its final answer.
5. Sources from all `search_notes` calls are aggregated and deduplicated at the bottom.

The mode preference is saved automatically between sessions.

**Available tools (read-only):**

| Tool | Description |
|---|---|
| `search_notes` | Semantic search — finds the most relevant note chunks for a query |
| `read_note` | Reads the full content of a note by its vault path |
| `list_notes` | Lists all Markdown note paths, optionally filtered by folder |
| `get_active_note` | Returns the path and content of the note currently open in the editor |

### Stopping a response

While a response is streaming, the **Send** button changes to **Stop**. Click it to abort — partial text is preserved and rendered.

### Model and effort controls

| Control | Options |
|---|---|
| **Model** | Flash (fast, cheap) · Pro (powerful) |
| **Effort** (Pro only) | Fast (1024 tokens) · Normal (4096) · Deep (16384) |

---

## Settings Reference

| Setting | Default | Description |
|---|---|---|
| DeepSeek API Key | — | Required for all queries |
| Model | Flash | Flash or Pro |
| Embedding Provider | none | Ollama / Jina / OpenAI |
| Top-K chunks | 6 | How many note chunks are retrieved per query (Chat mode) |
| Chunk size | 500 | Approximate token size per chunk when indexing |
| Excluded folders | `.trash`, `templates` | One folder path per line — notes inside are not indexed |
| Agent max steps | 6 | Maximum tool-calling rounds before the LLM is forced to give a final answer |

---

## Commands

| Command | Description |
|---|---|
| **Ask My Notes: Open chat** | Opens the chat panel in the right sidebar |
| **Ask My Notes: Reindex vault** | Scans all notes, creates embeddings, and saves the index |

---

## Architecture Overview

```
Vault .md files
    → chunker.ts        split by Markdown headers + paragraph fallback
    → EmbeddingProvider  Ollama / Jina / OpenAI
    → VectorStore        in-memory cosine similarity, persisted as JSON

User query (Chat mode)
    → EmbeddingProvider  embed query
    → VectorStore.search()  top-K chunks
    → prompt.ts          system prompt + context block + chat history
    → DeepSeekClient     streaming fetch
    → ChatView           token stream → Markdown render

User query (Agent mode)
    → buildAgentMessages()  system prompt + history (no pre-fetched context)
    → runAgent()         loop: chatWithTools → execute tools → append results
    → DeepSeekClient     streaming + tool_calls accumulation
    → ChatView           step bubbles + final Markdown render
```

**Key files:**

| Path | Responsibility |
|---|---|
| `src/main.ts` | Plugin lifecycle, index load/save, provider wiring |
| `src/settings.ts` | Settings interface, defaults, settings tab UI |
| `src/keychain.ts` | API key encryption via Electron `safeStorage` |
| `src/view/ChatView.ts` | Chat UI, streaming, source rendering, agent steps |
| `src/llm/deepseek.ts` | Streaming fetch to DeepSeek API |
| `src/llm/prompt.ts` | System prompts, message history types |
| `src/llm/tools.ts` | Tool definitions, dispatcher, safety caps |
| `src/llm/agent.ts` | Agent loop orchestration |
| `src/rag/chunker.ts` | Markdown → chunks |
| `src/rag/store.ts` | VectorStore — cosine similarity, serialize/deserialize |
| `src/rag/indexer.ts` | Vault scan → chunk → embed → store |
| `src/embeddings/` | Provider interface + Ollama, Jina, OpenAI implementations |

---

## Development

```bash
npm install
npm run dev     # watch mode — rebuilds main.js on every .ts change
npm run build   # production build (minified, no sourcemap)
```

The plugin folder is symlinked into the PLW vault for live development. With [Hot Reload](https://github.com/pjeby/hot-reload) installed, changes in `npm run dev` appear immediately in Obsidian.

---

## Security

- API keys are encrypted using Electron's `safeStorage` (macOS Keychain on Mac, DPAPI on Windows) before being written to `data.json`. They are decrypted in memory only when making API calls.
- Agent tools are **read-only** — the LLM can search and read notes but cannot create, edit, or delete anything in your vault.
- Safety limits: `search_notes` caps results at 20, `read_note` truncates at 50 KB, `list_notes` returns at most 200 paths. These prevent runaway token usage.
