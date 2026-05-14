import { App, TFile } from "obsidian";
import type { VectorStore } from "../rag/store";
import type { EmbeddingProvider } from "../embeddings/provider";
import { toRetrievedChunks } from "../rag/retriever";
import type { RetrievedChunk } from "../rag/retriever";

export interface ToolContext {
  app: App;
  vectorStore: VectorStore;
  embeddingProvider: EmbeddingProvider | null;
  topK: number;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface ToolResult {
  result: unknown;
  searchChunks?: RetrievedChunk[];
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_notes",
      description:
        "Semantic search over the user's vault. Returns relevant note chunks with file path and content. Use this to find information on a topic.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          k: { type: "number", description: "Max results (default 5, max 20)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read the full content of a specific note by its vault-relative path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path to the note (e.g. 'folder/note.md')",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "List markdown note paths in the vault. Optionally filter by folder prefix.",
      parameters: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description: "Optional folder prefix to filter by (e.g. 'law/')",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_note",
      description: "Get the path and content of the note currently open in the editor.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_note",
      description:
        "Create a new note or overwrite an existing note with the given content. Creates parent folders automatically.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path ending in .md (e.g. 'folder/note.md')",
          },
          content: {
            type: "string",
            description: "Full markdown content to write",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_to_note",
      description: "Append text to the end of an existing note.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Vault-relative path to the note (e.g. 'folder/note.md')",
          },
          content: {
            type: "string",
            description: "Text to append (will be added on a new line)",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_note",
      description: "Move or rename a note to a new vault-relative path. Creates parent folders automatically.",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Current vault-relative path of the note",
          },
          to: {
            type: "string",
            description: "New vault-relative path (including filename)",
          },
        },
        required: ["from", "to"],
      },
    },
  },
];

const MAX_K = 20;
const MAX_READ_CHARS = 50_000;
const MAX_LIST_ENTRIES = 200;
const MAX_WRITE_CHARS = 200_000;

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (name) {
    case "search_notes":
      return searchNotes(args, ctx);
    case "read_note":
      return readNote(args, ctx);
    case "list_notes":
      return listNotes(args, ctx);
    case "get_active_note":
      return getActiveNote(ctx);
    case "write_note":
      return writeNote(args, ctx);
    case "append_to_note":
      return appendToNote(args, ctx);
    case "move_note":
      return moveNote(args, ctx);
    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}

async function searchNotes(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = String(args.query ?? "");
  const k = Math.min(Math.max(1, Number(args.k ?? ctx.topK)), MAX_K);

  if (!ctx.embeddingProvider) {
    return { result: { error: "No embedding provider configured." } };
  }
  if (ctx.vectorStore.size() === 0) {
    return { result: { error: "Index is empty. Run 'Reindex vault' first." } };
  }

  const [queryEmbedding] = await ctx.embeddingProvider.embed([query]);
  const stored = ctx.vectorStore.search(queryEmbedding, k);
  const chunks = toRetrievedChunks(stored);

  return {
    result: {
      results: chunks.map((c) => ({
        filePath: c.filePath,
        headingPath: c.headingPath,
        text: c.text,
      })),
    },
    searchChunks: chunks,
  };
}

async function readNote(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const path = String(args.path ?? "");
  const file = ctx.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return { result: { error: `Note not found: ${path}` } };
  }
  const content = await ctx.app.vault.read(file);
  return {
    result: {
      path,
      content:
        content.length > MAX_READ_CHARS
          ? content.slice(0, MAX_READ_CHARS) + "\n\n[Content truncated]"
          : content,
    },
  };
}

function listNotes(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const folder = args.folder ? String(args.folder) : null;
  let files = ctx.app.vault.getMarkdownFiles();
  if (folder) {
    files = files.filter((f) => f.path.startsWith(folder));
  }
  const paths = files.slice(0, MAX_LIST_ENTRIES).map((f) => f.path);
  return { result: { paths, total: files.length } };
}

async function getActiveNote(ctx: ToolContext): Promise<ToolResult> {
  const file = ctx.app.workspace.getActiveFile();
  if (!file) {
    return { result: { error: "No note is currently open." } };
  }
  const content = await ctx.app.vault.read(file);
  return {
    result: {
      path: file.path,
      content:
        content.length > MAX_READ_CHARS
          ? content.slice(0, MAX_READ_CHARS) + "\n\n[Content truncated]"
          : content,
    },
  };
}

async function writeNote(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args.path ?? "");
  const content = String(args.content ?? "");

  if (!path.endsWith(".md")) {
    return { result: { error: "Path must end with .md" } };
  }
  if (content.length > MAX_WRITE_CHARS) {
    return { result: { error: `Content too large (max ${MAX_WRITE_CHARS} chars)` } };
  }

  const existing = ctx.app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await ctx.app.vault.modify(existing, content);
    return { result: { path, created: false, bytes: content.length } };
  }

  const folderPath = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : null;
  if (folderPath && !(await ctx.app.vault.adapter.exists(folderPath))) {
    await ctx.app.vault.createFolder(folderPath);
  }
  await ctx.app.vault.create(path, content);
  return { result: { path, created: true, bytes: content.length } };
}

async function appendToNote(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args.path ?? "");
  const content = String(args.content ?? "");

  const file = ctx.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return { result: { error: `Note not found: ${path}` } };
  }

  const existing = await ctx.app.vault.read(file);
  await ctx.app.vault.modify(file, existing + "\n" + content);
  return { result: { path, appended: content.length } };
}

async function moveNote(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const from = String(args.from ?? "");
  const to = String(args.to ?? "");

  const file = ctx.app.vault.getAbstractFileByPath(from);
  if (!(file instanceof TFile)) {
    return { result: { error: `Note not found: ${from}` } };
  }

  const folderPath = to.includes("/") ? to.substring(0, to.lastIndexOf("/")) : null;
  if (folderPath && !(await ctx.app.vault.adapter.exists(folderPath))) {
    await ctx.app.vault.createFolder(folderPath);
  }

  await ctx.app.vault.rename(file, to);
  return { result: { from, to } };
}
