# Internal Link Click-to-Open

**Date:** 2026-05-14

## Goal

When the LLM response contains `[[wikilinks]]` to vault files, clicking them in the chat panel opens the file in Obsidian.

## Background

`MarkdownRenderer.render()` renders `[[filename]]` wikilinks as `<a class="internal-link" data-href="filename">`. Obsidian's global workspace click handler normally intercepts these, but it does not fire reliably inside an `ItemView` panel. The result: links appear styled but clicks do nothing.

The sources panel already implements click-to-open manually (ChatView.ts lines 755–760) using `app.vault.getAbstractFileByPath` + `app.workspace.getLeaf(false).openFile()`. This feature applies the same pattern to the main message area.

## Design

### Single delegated click handler on `messagesEl`

Registered once in `onOpen()`, after `messagesEl` is created.

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

### Key decisions

- **`closest("a.internal-link")`** — only fires for links that MarkdownRenderer explicitly tagged as internal. Plain text paths and external URLs are unaffected.
- **`metadataCache.getFirstLinkpathDest(href, "")`** — Obsidian's standard API for resolving a link-path to a `TFile`. Returns `null` if the file doesn't exist in the vault, so the handler silently does nothing for unresolvable links.
- **`getLeaf(false)`** — opens in the currently active leaf (same behaviour as clicking a link in a normal note).
- **`preventDefault()`** — stops any browser-level navigation attempt.

### Scope

Only `[[wikilinks]]` in the rendered LLM response bubble are affected. Tool step bodies, sources panel, and user message bubbles are unchanged.

## Files changed

| File | Change |
|---|---|
| `src/view/ChatView.ts` | Add delegated click handler in `onOpen()`, after `messagesEl` is created |

No new files. No other files touched.
