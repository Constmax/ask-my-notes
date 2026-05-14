import type { RetrievedChunk } from "../rag/retriever";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export function buildSystemPrompt(): string {
  return `You are a helpful assistant that answers questions based exclusively on the user's notes.
When answering:
- Use only information that is explicitly present in the provided notes.
- If the notes don't contain enough information to answer, say so clearly instead of guessing.
- Keep answers concise and precise.
- Respond in the same language the user asked in.
- Do not invent facts or references not present in the notes.`;
}

export function buildAgentSystemPrompt(): string {
  return `You are a research and writing assistant with full access to the user's note vault via tools.

Read tools:
- search_notes — semantic search over vault notes
- read_note — read full content of a specific note
- list_notes — list note paths, optionally by folder
- get_active_note — get the currently open note

Write tools:
- write_note — create or overwrite a note (creates parent folders automatically)
- append_to_note — append text to an existing note
- move_note — move or rename a note

When answering:
- Use search_notes first to find relevant information before writing or answering.
- Use write_note / append_to_note only when the user explicitly asks to create or modify notes.
- Use move_note only when the user explicitly asks to move or rename a note.
- Only use information found in the vault. Do not invent facts.
- Respond in the same language the user asked in.
- After gathering enough information, provide a concise, well-structured answer.`;
}

export function buildContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const blocks = chunks.map((c, i) => {
    const header = c.headingPath ? ` > ${c.headingPath}` : "";
    return `[${i + 1}] **${c.filePath}${header}**\n${c.text}`;
  });
  return `## Notes\n\n${blocks.join("\n\n---\n\n")}`;
}

export function buildMessages(
  history: ChatMessage[],
  query: string,
  chunks: RetrievedChunk[]
): ChatMessage[] {
  const contextBlock = buildContextBlock(chunks);
  const userContent = contextBlock
    ? `${contextBlock}\n\n## Question\n\n${query}`
    : query;

  return [
    { role: "system", content: buildSystemPrompt() },
    ...history,
    { role: "user", content: userContent },
  ];
}

export function buildAgentMessages(
  history: ChatMessage[],
  query: string
): ChatMessage[] {
  return [
    { role: "system", content: buildAgentSystemPrompt() },
    ...history,
    { role: "user", content: query },
  ];
}
