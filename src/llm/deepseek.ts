import type { ChatMessage, ToolCall } from "./prompt";
import type { DeepSeekModel } from "../settings";
import type { ToolDefinition } from "./tools";

const BASE_URL = "https://api.deepseek.com/v1";

export interface ChatOptions {
  thinkingBudget?: number;
}

export interface ChatWithToolsResult {
  toolCalls: ToolCall[];
  finishReason: string;
  reasoningContent: string;
}

export class DeepSeekClient {
  private apiKey: string;
  private model: DeepSeekModel;

  constructor(apiKey: string, model: DeepSeekModel) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(
    messages: ChatMessage[],
    onToken: (token: string) => void,
    signal?: AbortSignal,
    options?: ChatOptions
  ): Promise<void> {
    await this.chatWithTools(messages, [], onToken, signal, options);
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onToken: (token: string) => void,
    signal?: AbortSignal,
    options?: ChatOptions
  ): Promise<ChatWithToolsResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      max_tokens: tools.length > 0 ? 1024 : 8192,
    };

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    if (this.model === "deepseek-v4-pro" && options?.thinkingBudget != null) {
      body.thinking = { type: "enabled", budget_tokens: options.thinkingBudget };
    }

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new DeepSeekError(response.status, error);
    }

    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason = "stop";
    let reasoningContent = "";

    interface AccumToolCall {
      id: string;
      name: string;
      arguments: string;
    }
    const accumToolCalls = new Map<number, AccumToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") break;
        try {
          const json = JSON.parse(data);
          const choice = json?.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (!delta) continue;

          if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
          if (delta.content) onToken(delta.content);

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              if (!accumToolCalls.has(idx)) {
                accumToolCalls.set(idx, { id: "", name: "", arguments: "" });
              }
              const acc = accumToolCalls.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }
        } catch {
          // incomplete JSON fragment — ignore
        }
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const [, acc] of accumToolCalls) {
      toolCalls.push({
        id: acc.id,
        type: "function",
        function: { name: acc.name, arguments: acc.arguments },
      });
    }

    return { toolCalls, finishReason, reasoningContent };
  }

  async testConnection(): Promise<void> {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new DeepSeekError(response.status, error);
    }
  }
}

export class DeepSeekError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`DeepSeek API error ${status}: ${body}`);
    this.status = status;
    this.name = "DeepSeekError";
  }
}
