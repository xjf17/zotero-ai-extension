# Zotero AI Assistant

Zotero 7-9 compatible extension for three OpenRouter-powered workflows:

- Read the current paper and save a Chinese structured reading note.
- Search the local Zotero library for citation candidates using text extraction, local chunking, embeddings, and reranking.
- Answer the latest unanswered `Q:` in a Zotero note and append a formatted `Answer:`.

## User Interface

The primary entry point is the right-side Zotero pane navigation bar. The plugin injects three persistent icon buttons into the visible `sidenav`/vertical tab bar:

- `读取论文`: extracts the selected/current paper text, asks the chat model for a Chinese reading note, and saves the result as a child Zotero note.
- `查找引用`: opens the citation-search panel where the user enters one idea or claim, searches the local vector index, reranks candidates, and displays recommendations.
- `回答笔记问题`: reads the current/selected note, finds the latest unanswered `Q:`, sends the parent PDF full text before the note context, and appends `Answer:`.

The previous main-list top toolbar and reader-note-toolbar experiments have been removed. The right-side button group is now the single visual entry point. Right-click context menu entries remain as auxiliary access.

## Main Files

- `bootstrap.js`: Zotero plugin lifecycle. It registers chrome content, registers the preferences pane, loads `content/zotero-ai.js`, exposes `Zotero.ZoteroAI`, and injects UI into open Zotero windows.
- `content/zotero-ai.js`: core plugin logic. It owns UI injection, OpenRouter calls, PDF text extraction, chunking, embeddings, local index storage, summary generation, citation search, note Q&A, and progress feedback.
- `content/toolbar.css`: styles for the three right-side icon buttons.
- `content/search.xhtml`: citation-search dialog shell.
- `content/search.js`: citation-search dialog behavior, including query submission, rebuild-index button handling, result rendering, and progress status forwarding.
- `content/search.css`: citation-search dialog layout and result styling.
- `content/preferences-pane.xhtml`: Zotero Settings pane UI.
- `content/preferences-pane.js`: preference loading/saving and rebuild-index button behavior in settings.
- `content/preferences-pane.css`: settings pane styling.
- `prefs.js`: default preference values.
- `tools/build-xpi.ps1`: builds the `.xpi` package.
- `tools/validate.js`: checks required files, manifest/package consistency, JS syntax, basic XHTML quote sanity, and XPI entry paths.
- `tools/diagnose-xpi.js`: inspects the built XPI and Zotero version compatibility metadata.

## Prompt Locations

Prompts are intentionally kept in `content/zotero-ai.js` so they are easy to edit during current development:

- `parsePdfBase64()`: fallback PDF parser/OCR extraction prompt.
- `summarizePaperV2()`: paper-reading summary prompt.
- `rerankReferences()`: citation-search reranking prompt.
- `answerLatestQuestion()`: note Q&A prompt.

If prompt editing becomes frequent, the next sensible cleanup is moving these strings into a small `content/prompts.js` module. For now they remain in place to preserve your current manual edits.

## Workflow Logic

### Paper Reading

1. Resolve the target paper from the active reader PDF when possible; otherwise use the selected regular Zotero item.
2. Find the best PDF attachment.
3. Prefer Zotero indexed full text and page text.
4. If local text is unavailable and PDF mode allows it, use OpenRouter PDF parser/OCR fallback.
5. If page boundaries are available, remove the configured number of trailing pages before summarization.
6. Split the selected text into summary chunks. `maxSummaryChunks = 0` means no chunk-count cap.
7. Call the configured chat model through OpenRouter.
8. Convert Markdown to Zotero note HTML and save a child note under the paper.

### Citation Search

1. The second icon opens `content/search.xhtml`.
2. The user enters a Chinese idea or claim.
3. `search.js` calls `app.searchReferences()`.
4. The plugin loads the local index for the current library.
5. If the index is empty, it asks whether to rebuild the current visible item-view index.
6. Rebuild extracts PDF text, chunks it, calls the embedding model in batches, and stores vectors under Zotero storage in `zotero-ai-assistant/index-<libraryID>.json`.
7. Search embeds the query, computes cosine similarity against local chunks, and returns top candidates.
8. The chat model reranks candidates and extracts reasons plus short original excerpts.
9. Results are displayed only in the search panel; they are not written to notes automatically.

### Note Q&A

1. Resolve the current note from the active note editor if possible; otherwise use the selected Zotero note.
2. Parse note text for `Q:`, `Question:`, `问题:`, `Answer:`, or `回答:` markers.
3. Work backward from the end and answer only the latest question that does not already have a following answer marker.
4. Read the parent paper PDF text in full when available.
5. Build one prompt with the PDF full text first, followed by the current note and sibling child notes.
6. Call the chat model.
7. Convert Markdown to Zotero note HTML and append it under an `Answer:` heading.

## Progress Feedback

Progress feedback uses Zotero's built-in `Zotero.ProgressWindow`, not a custom dialog. Each long operation creates a progress handle with:

- `changeHeadline("Zotero AI")`
- one `ItemProgress` line for current operation text
- `setText()` updates as the task advances
- `close()` when the operation ends or fails

This avoids the blank custom XUL/HTML progress-window issue seen during earlier experiments.

## Settings

Preferences are stored under `extensions.zotero-ai.*`:

- `openrouterApiKey`: OpenRouter API key.
- `chatModel`: selected chat model preset or `custom`.
- `customChatModel`: model id used when `chatModel = custom`.
- `embeddingModel`: selected embedding model preset or `custom`.
- `customEmbeddingModel`: embedding model id used when `embeddingModel = custom`.
- `pdfMode`: `local-first` or `openrouter-pdf`.
- `maxSummaryChunks`: maximum number of summary chunks; `0` means unlimited.
- `summaryExcludeTrailingPages`: number of final PDF pages to skip when page text is available.
- `referenceTopK`: number of citation-search results requested from semantic recall.

## Development

```powershell
npm run validate
npm run build
npm run diagnose
```

The build script creates:

```text
dist/zotero-ai-assistant-0.1.19.xpi
```

## Install For Testing

1. Run `npm run build`.
2. Open Zotero.
3. Go to `Tools -> Plugins`.
4. Drag `dist/zotero-ai-assistant-0.1.19.xpi` into the plugin window.
5. Restart Zotero if prompted.

## Implementation Notes

OpenRouter embeddings work on text input, not a complete PDF file. The plugin therefore follows a RAG-style pipeline: obtain PDF text, normalize and chunk locally, embed chunks through OpenRouter, store vectors locally, semantically recall chunks, and use the chat model only for generation/reranking.

The extension currently uses Zotero internal UI selectors for the right-side `sidenav`, because Zotero's reader and item panes vary across versions. The selectors are kept narrow enough to avoid the old top-toolbar injection path, and the mutation observer only re-injects the right-side button group.
