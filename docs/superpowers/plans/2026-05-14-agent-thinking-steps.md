# Agent Thinking Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the model's reasoning (`reasoning_content`) as a collapsible "Denken…" block before each tool-call round in agent mode, and display readable German labels instead of raw function names.

**Architecture:** Add an `onThinking(content, step)` callback to `AgentCallbacks` in `agent.ts` that fires after each `chatWithTools` round when reasoning content is present. In `ChatView.ts`, wire the callback to a new `renderThinkingStep` method that inserts a collapsible element before the tool-call elements. A `TOOL_LABELS` map translates raw tool names to German.

**Tech Stack:** TypeScript, Obsidian Plugin API, esbuild (build via `npm run build` / `npm run dev`)

---

### Task 1: Add `onThinking` callback to `AgentCallbacks` and fire it in `runAgent`

**Files:**
- Modify: `src/llm/agent.ts`

- [ ] **Step 1: Add `onThinking` to the `AgentCallbacks` interface**

In `src/llm/agent.ts`, extend the interface (lines 7–17):

```typescript
export interface AgentCallbacks {
  onToken: (token: string) => void;
  onThinking: (content: string, step: number) => void;
  onToolCall: (name: string, args: Record<string, unknown>, step: number) => void;
  onToolResult: (
    name: string,
    result: unknown,
    chunks: RetrievedChunk[],
    step: number
  ) => void;
  confirmTool?: (name: string, args: Record<string, unknown>) => Promise<boolean>;
}
```

- [ ] **Step 2: Fire `onThinking` after each `chatWithTools` round when reasoning is present**

In `runAgent`, after `lastReasoningContent = reasoningContent;` (currently line 66), add:

```typescript
if (reasoningContent) {
  callbacks.onThinking(reasoningContent, step);
}
```

The full relevant block in the while-loop becomes:

```typescript
const { toolCalls, finishReason, reasoningContent } = await client.chatWithTools(
  messages,
  TOOL_DEFINITIONS,
  callbacks.onToken,
  signal,
  options
);

lastReasoningContent = reasoningContent;

if (reasoningContent) {
  callbacks.onThinking(reasoningContent, step);
}

if (finishReason !== "tool_calls" || toolCalls.length === 0) {
  break;
}
```

- [ ] **Step 3: Build and verify no TypeScript errors**

```bash
cd "/Users/constantinjanz/Documents/Spaßprojekte/Obsidian Plugin" && npm run build 2>&1
```

Expected: build succeeds. Any TS error here means a call site in `ChatView.ts` doesn't satisfy the new interface yet — that's expected; continue to Task 2.

---

### Task 2: Add `TOOL_LABELS` map and `renderThinkingStep` in `ChatView.ts`, wire `onThinking`

**Files:**
- Modify: `src/view/ChatView.ts`

- [ ] **Step 1: Add `TOOL_LABELS` constant near the top of the file (after imports)**

Find the line with `const MAX_SOURCES = 5;` or similar top-level constants and add:

```typescript
const TOOL_LABELS: Record<string, string> = {
  search_notes: "Suche Notizen",
  read_note: "Lese Notiz",
  list_notes: "Alle Notizen auflisten",
  get_active_note: "Aktive Notiz lesen",
  write_note: "Schreibe Notiz",
  append_to_note: "Ergänze Notiz",
  move_note: "Verschiebe Notiz",
};
```

- [ ] **Step 2: Update `renderToolStep` to use readable labels**

Current header text in `renderToolStep` (around line 558):
```typescript
text: `⚙ ${name}(${argsPreview})`,
```
and in `markDone` (around line 572):
```typescript
headerEl.textContent = `✓ ${name}(${argsPreview})`;
```

Replace both occurrences to use `TOOL_LABELS`:

```typescript
// in the initial createDiv call:
const label = TOOL_LABELS[name] ?? name;
const argsPreview = this.formatArgsPreview(args);

const headerEl = stepEl.createDiv({
  cls: "ask-my-notes-step-header is-running",
  text: `⚙ ${label}${argsPreview ? ` — ${argsPreview}` : ""}`,
});
```

```typescript
// inside markDone:
headerEl.textContent = `✓ ${label}${argsPreview ? ` — ${argsPreview}` : ""}`;
```

Note: `label` and `argsPreview` are both defined before `markDone` so the closure captures them correctly.

- [ ] **Step 3: Add `renderThinkingStep` private method**

Add after the `renderToolStep` method (before `formatArgsPreview`):

```typescript
private renderThinkingStep(container: HTMLElement, content: string): void {
  const stepEl = container.createDiv("ask-my-notes-step is-thinking");

  const headerEl = stepEl.createDiv({
    cls: "ask-my-notes-step-header is-thinking",
    text: "💭 Denken…",
  });

  const bodyEl = stepEl.createDiv("ask-my-notes-step-body");
  bodyEl.style.display = "none";
  bodyEl.createEl("pre", {
    cls: "ask-my-notes-step-thinking-content",
    text: content,
  });

  headerEl.addEventListener("click", () => {
    const collapsed = bodyEl.style.display === "none";
    bodyEl.style.display = collapsed ? "block" : "none";
  });
}
```

- [ ] **Step 4: Wire `onThinking` in `submitAgent`**

In the `runAgent` callbacks object inside `submitAgent` (currently around lines 469–487), add the `onThinking` entry:

```typescript
onThinking: (content, _step) => {
  this.renderThinkingStep(stepsEl, content);
  this.scrollToBottom();
},
```

Full callbacks object after the change:

```typescript
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
}
```

- [ ] **Step 5: Build and verify no TypeScript errors**

```bash
cd "/Users/constantinjanz/Documents/Spaßprojekte/Obsidian Plugin" && npm run build 2>&1
```

Expected: `main.js` emitted, zero errors.

---

### Task 3: Manual testing in Obsidian

No automated test runner is available. Test manually:

- [ ] **Step 1: Start watch build**

```bash
cd "/Users/constantinjanz/Documents/Spaßprojekte/Obsidian Plugin" && npm run dev
```

- [ ] **Step 2: Open Obsidian with PLW vault**

Plugin reloads automatically via Hot Reload on each `main.js` change.

- [ ] **Step 3: Switch to agent mode, send a query that requires tool use**

Example: "Was steht in meinen Notizen zu Angebot und Annahme?"

Verify:
- A "💭 Denken…" block appears before the first tool call
- Clicking it expands/collapses the reasoning text
- Tool steps show "Suche Notizen — query: …" instead of `search_notes(query: …)`
- After tool completes: "✓ Suche Notizen — query: …"

- [ ] **Step 4: Test with a write operation**

Send a query that triggers a write tool to verify:
- "✓ Schreibe Notiz — path: …" label is correct
- Confirmation dialog still shows translated label (it uses `formatArgsPreview` separately — check `promptConfirm`)

- [ ] **Step 5: Test with `deepseek-v4-flash` (no thinking budget)**

Flash model doesn't return `reasoning_content`. Verify no "Denken…" block appears — the `if (reasoningContent)` guard in `runAgent` covers this.
