# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build   # production build → main.js (minified, no sourcemap)
npm run dev     # watch mode → rebuilds main.js on every .ts change (sourcemap inline)
```

No test runner is configured. Manual testing is done inside Obsidian (see below).

## Installing / testing in Obsidian

The plugin folder is symlinked into the PLW vault:
```
~/.../PLW/.obsidian/plugins/ask-my-notes → this directory
```

Hot Reload (pjeby) is installed in that vault and watches for `main.js` changes (`.hotreload` marker file is present). To get automatic reloads while developing:
1. Run `npm run dev` in this directory
2. Open Obsidian with the PLW vault — plugin reloads automatically on each build

Manual reload without hot-reload: Settings → Community Plugins → toggle Ask My Notes off/on.

## Architecture

The plugin implements a **RAG (Retrieval-Augmented Generation) chat** over an Obsidian vault, with an optional **Agent mode** where the LLM autonomously calls tools to read and write the vault.

### Data flow

**Chat mode (default)**
```
Vault .md files
    → chunker.ts        (split by Markdown headers + paragraph fallback)
    → EmbeddingProvider (Ollama / Jina / OpenAI)
    → VectorStore       (in-memory cosine similarity, persisted as ask-my-notes-index.json)

User query
    → EmbeddingProvider.embed()
    → VectorStore.search()     top-K chunks
    → prompt.ts buildMessages() (system prompt + context block + chat history)
    → DeepSeekClient.chat()    (streaming fetch to api.deepseek.com)
    → ChatView                 (token-by-token textContent, then MarkdownRenderer.render())
```

**Agent mode**
```
User query
    → prompt.ts buildAgentMessages()  (system prompt + history, no pre-fetched context)
    → runAgent()                      loop:
          DeepSeekClient.chatWithTools()  → finish_reason === "tool_calls"?
          [confirmTool() if write op + confirm mode is on]
          executeTool()                   → read tools: search_notes / read_note / list_notes / get_active_note
                                          → write tools: write_note / append_to_note / move_note
          append tool result to messages
          repeat until "stop" or maxSteps reached
    → ChatView                        step bubbles (running → done) + final Markdown render
```

### Key design decisions

**Embedding adapter pattern** (`src/embeddings/provider.ts`): `EmbeddingProvider` interface with `id`, `dimensions`, `embed()`. The `id` is persisted in the index; a mismatch on reindex triggers a full rebuild. Add new providers by implementing this interface and wiring them in `settings.ts` + `main.ts`. Setting `embeddingProvider` to `"none"` disables RAG entirely — Chat mode sends no context chunks, Agent mode still works via its read tools.

**Index persistence**: `ask-my-notes-index.json` lives in the plugin folder (not `data.json`). Written via `app.vault.adapter.write()`. Loaded into RAM on plugin start. Format: `{ version: 1, providerId: string, chunks: StoredChunk[] }`.

**API key security** (`src/keychain.ts`): Keys are encrypted via Electron's `safeStorage` (macOS Keychain / Windows DPAPI) before being stored in `data.json`. Stored as `"enc:<base64>"`. Always call `decryptSecret()` before passing a key to any client. Legacy plaintext values (no `enc:` prefix) are passed through as-is.

**Streaming**: DeepSeek client uses `fetch()` with `ReadableStream` (not Obsidian's `requestUrl()`, which doesn't support streaming). Tokens are appended to `bubbleEl.textContent` during streaming; after completion `MarkdownRenderer.render()` replaces the plain text with rendered HTML.

**Tool-call streaming** (`src/llm/deepseek.ts`): When the model calls tools, `delta.tool_calls[i]` arrives across multiple SSE chunks. Each chunk carries an `index` field; name and arguments are accumulated per-index in a `Map<number, AccumToolCall>`. `delta.reasoning_content` is also accumulated and returned as `reasoningContent` in `ChatWithToolsResult`. `chat()` is a thin wrapper around `chatWithTools(messages, [], ...)`.

**Agent loop** (`src/llm/agent.ts`): The `messages` array is mutated in-place within a single `runAgent()` call — assistant tool-call messages and `role: "tool"` result messages are appended per round but are never written back to `ChatView.history`. Only the clean user/assistant pair is pushed to history after completion. Tool results are compressed before being appended: `search_notes` chunk text is truncated to 300 chars, `read_note` content to 6 000 chars. `max_tokens` is a flat 8 192 output budget for every round (tool-calling and final); when thinking is enabled (`deepseek-v4-pro`) the thinking budget is added on top, since `reasoning_content` counts against `max_tokens` and a `write_note` call must emit the full file content as JSON arguments. `WRITE_TOOLS` (`write_note`, `append_to_note`, `move_note`) trigger the optional `confirmTool` callback before execution — if it resolves `false`, `{ error: "Action denied by user." }` is returned as the tool result so the LLM can react.

**`reasoning_content` echo** (`src/llm/deepseek.ts`, `src/llm/agent.ts`, `src/llm/prompt.ts`): `deepseek-v4-pro` returns `reasoning_content` in every response chunk. The API requires it to be echoed back in assistant messages on subsequent turns (400 error otherwise). `chatWithTools` accumulates it and returns it; the agent loop includes it in assistant tool-call messages via `{ ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) }`. `ChatView` also stores it in `history` for multi-turn use. `ChatMessage` has an optional `reasoning_content?: string` field.

**Write tools** (`src/llm/tools.ts`): Three write tools — `write_note` (create or overwrite, `MAX_WRITE_CHARS = 200_000`, `.md` extension required), `append_to_note`, `move_note` — all use Obsidian's vault API (`vault.create`, `vault.modify`, `vault.rename`) and create missing parent folders automatically via `vault.createFolder`. Errors are returned as `{ error: string }` rather than thrown.

**Write-confirm toggle**: `agentWriteConfirm: boolean` in settings (default `true`). When enabled, `ChatView` passes a `confirmTool` callback to `runAgent` that renders an inline confirmation bubble (`⚠ write_note(…) — Erlauben? [Ja] [Nein]`) and returns a `Promise<boolean>`. The toolbar shows `[Auto | Bestätigen]` group only while in agent mode.

**Thinking effort levels** (`src/view/ChatView.ts`): Three effort buttons (Fast / Normal / Deep → `thinkingBudget` 1 024 / 4 096 / 16 384) are shown only when `deepseek-v4-pro` is active. The budget is passed as `options.thinkingBudget` to `DeepSeekClient`. Hidden entirely for `deepseek-v4-flash` since flash doesn't support extended thinking.

**Workflow system** (`src/llm/workflows.ts`): `.md` files in the `workflows/` folder (plugin directory, not vault) become slash commands. `loadWorkflows(app)` lists them via `app.vault.adapter.list()` using the hardcoded path `{configDir}/plugins/ask-my-notes/workflows`. `applyWorkflow(workflow, query)` replaces `$ARGUMENTS` in the file content with the user's query; if no placeholder is present, the query is appended. Workflows always run in Agent mode. The chat panel must be re-opened to pick up newly added workflow files.

**ChatMessage type** (`src/llm/prompt.ts`): `content` is `string | null` (null is required when the model returns `tool_calls` with no text). Optional fields: `tool_calls`, `tool_call_id`, `reasoning_content`.

**New chat / clear**: The toolbar `rotate-ccw` icon button calls `clearChat()` which aborts any in-flight request, empties `history` and `displayMessages`, and re-renders the empty state.

**Ollama auto-detection**: `OllamaEmbeddingProvider` discovers embedding dimensions from the first response rather than hardcoding them. Model availability is checked via `GET /api/tags` in `testConnection()`.

### Module map

| Path | Responsibility |
|---|---|
| `src/main.ts` | Plugin lifecycle, command registration, index load/save, provider wiring |
| `src/settings.ts` | `AskMyNotesSettings` interface, `DEFAULT_SETTINGS`, `PluginSettingTab` |
| `src/keychain.ts` | `encryptSecret` / `decryptSecret` via Electron `safeStorage` |
| `src/view/ChatView.ts` | `ItemView` — toolbar (model/effort/mode/write-confirm/new-chat), Chat/Agent branching, streaming, step bubbles, write-confirm UI, sources |
| `src/llm/deepseek.ts` | Streaming fetch to DeepSeek API, tool_calls + reasoning_content accumulation, error types |
| `src/llm/prompt.ts` | `ChatMessage` / `ToolCall` types, system prompts, message assembly |
| `src/llm/tools.ts` | Tool definitions (OpenAI schema), dispatcher, `ToolContext`, safety caps; read tools + write tools |
| `src/llm/agent.ts` | `runAgent()` loop — tool execution, write-confirm gate, reasoning_content echo, message threading, max-steps guard, result compression |
| `src/llm/workflows.ts` | `loadWorkflows()`, `applyWorkflow()` — slash-command workflow system |
| `workflows/*.md` | User-defined workflow templates; `$ARGUMENTS` is replaced with the query at runtime |
| `src/rag/chunker.ts` | Markdown → `Chunk[]` (header breadcrumb + paragraph splitting) |
| `src/rag/store.ts` | `VectorStore` — cosine similarity search, serialize/deserialize |
| `src/rag/indexer.ts` | Orchestrates vault scan → chunk → embed → store |
| `src/rag/retriever.ts` | `RetrievedChunk` type, `toRetrievedChunks()` helper |
| `src/embeddings/` | `provider.ts` interface + `ollama.ts`, `jina.ts`, `openai.ts` |
| `src/embeddings/voyage.ts` | `VoyageEmbeddingProvider` — Voyage AI `voyage-3-large` (1 024 dims, batch 32); not yet wired into settings/main |
