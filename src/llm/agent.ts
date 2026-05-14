import type { ChatMessage } from "./prompt";
import type { DeepSeekClient, ChatOptions } from "./deepseek";
import { TOOL_DEFINITIONS, executeTool } from "./tools";
import type { ToolContext } from "./tools";
import type { RetrievedChunk } from "../rag/retriever";

export interface AgentCallbacks {
  onToken: (token: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>, step: number) => void;
  onToolResult: (
    name: string,
    result: unknown,
    chunks: RetrievedChunk[],
    step: number
  ) => void;
  confirmTool?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
}

export interface AgentResult {
  allChunks: RetrievedChunk[];
  reasoningContent: string;
}

const WRITE_TOOLS = new Set(["write_note", "append_to_note", "move_note"]);

function compressToolResult(name: string, result: unknown): string {
  if (name === "search_notes") {
    const r = result as { results?: { filePath: string; headingPath?: string; text: string }[] };
    const trimmed = (r.results ?? []).map((c) => ({
      filePath: c.filePath,
      headingPath: c.headingPath,
      text: c.text.slice(0, 300),
    }));
    return JSON.stringify({ results: trimmed });
  }
  if (name === "read_note") {
    const r = result as { path?: string; content?: string; error?: string };
    if (r.error) return JSON.stringify(r);
    return JSON.stringify({ path: r.path, content: r.content?.slice(0, 6000) ?? "" });
  }
  return JSON.stringify(result);
}

export async function runAgent(
  messages: ChatMessage[],
  client: DeepSeekClient,
  ctx: ToolContext,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
  maxSteps: number,
  options?: ChatOptions
): Promise<AgentResult> {
  const allChunks: RetrievedChunk[] = [];
  let step = 0;
  let lastReasoningContent = "";

  while (true) {
    const { toolCalls, finishReason, reasoningContent } = await client.chatWithTools(
      messages,
      TOOL_DEFINITIONS,
      callbacks.onToken,
      signal,
      options
    );

    lastReasoningContent = reasoningContent;

    if (finishReason !== "tool_calls" || toolCalls.length === 0) {
      break;
    }

    // Push assistant message with tool_calls into the running context
    // reasoning_content must be echoed back for deepseek-v4-pro multi-turn
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    });

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // malformed args — pass empty object, tool handles gracefully
      }

      callbacks.onToolCall(tc.function.name, args, step);

      if (WRITE_TOOLS.has(tc.function.name) && callbacks.confirmTool) {
        const allowed = await callbacks.confirmTool(tc.function.name, args);
        if (!allowed) {
          callbacks.onToolResult(tc.function.name, { error: "Action denied by user." }, [], step);
          messages.push({
            role: "tool",
            content: JSON.stringify({ error: "Action denied by user." }),
            tool_call_id: tc.id,
          });
          continue;
        }
      }

      const { result, searchChunks = [] } = await executeTool(tc.function.name, args, ctx);
      allChunks.push(...searchChunks);

      callbacks.onToolResult(tc.function.name, result, searchChunks, step);

      messages.push({
        role: "tool",
        content: compressToolResult(tc.function.name, result),
        tool_call_id: tc.id,
      });
    }

    step++;

    if (step >= maxSteps) {
      messages.push({
        role: "user",
        content:
          "No more tool calls are allowed. Please provide your final answer now based on the information gathered.",
      });
      // Final call without tools so the model must answer
      await client.chatWithTools(messages, [], callbacks.onToken, signal, options);
      break;
    }
  }

  return { allChunks, reasoningContent: lastReasoningContent };
}
