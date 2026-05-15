# Internal Link Click-to-Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `[[wikilinks]]` in the LLM response bubble clickable so clicking them opens the referenced file in the Obsidian vault.

**Architecture:** A single delegated click handler is added to `messagesEl` in `ChatView.onOpen()`. It uses `closest("a.internal-link")` to match links that `MarkdownRenderer` renders from `[[wikilinks]]`, resolves the file via `app.metadataCache.getFirstLinkpathDest`, and opens it with `app.workspace.getLeaf(false).openFile()`.

**Tech Stack:** TypeScript, Obsidian Plugin API (`MarkdownRenderer`, `MetadataCache`, `Workspace`, `TFile`)

---

### Task 1: Add delegated click handler in `ChatView.onOpen()`

**Files:**
- Modify: `src/view/ChatView.ts` — add click listener on `messagesEl` after it is created

> **Note:** No test runner is configured in this project (see CLAUDE.md). Verification is done by running `npm run dev`, reloading the plugin in Obsidian, and manually testing.

- [ ] **Step 1: Locate the insertion point**

Open `src/view/ChatView.ts`. Find line 97 where `messagesEl` is created:

```typescript
this.messagesEl = root.createDiv("ask-my-notes-messages");
this.renderEmpty();
```

The handler goes immediately after this block, before the `inputArea` setup.

- [ ] **Step 2: Add the click handler**

Insert the following block after line 98 (`this.renderEmpty();`):

```typescript
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
```

`TFile` is already imported at line 1 (`import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, TFile, setIcon } from "obsidian";`), so no import changes are needed.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: no TypeScript errors, `main.js` is updated.

- [ ] **Step 4: Test manually in Obsidian**

1. Open the PLW vault (Hot Reload picks up the new `main.js` automatically).
2. Switch to Agent mode, ask a question that causes the model to reference a vault file using `[[filename]]` syntax in its response, e.g. "Was steht in [[Some Note]]?".
3. Click the rendered wikilink in the response bubble.
4. Expected: the referenced file opens in the active Obsidian leaf.
5. Click a wikilink that references a file that does not exist in the vault.
6. Expected: nothing happens (no error, no navigation).

- [ ] **Step 5: Commit**

```bash
git add src/view/ChatView.ts
git commit -m "feat: open vault file on [[wikilink]] click in chat bubble"
```
