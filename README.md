# Zotero AI Assistant

A Zotero plugin that uses AI to help you read papers, find citation candidates, and answer questions written in your notes. It connects to any OpenAI-compatible API; the default and recommended provider is [OpenRouter](https://openrouter.ai), which gives access to many AI models through one API key.

Compatible with Zotero 7, 8, and 9.

---

## Table of Contents

- [Zotero AI Assistant](#zotero-ai-assistant)
  - [Table of Contents](#table-of-contents)
  - [Installation](#installation)
  - [API Setup](#api-setup)
    - [Getting an OpenRouter API Key (recommended)](#getting-an-openrouter-api-key-recommended)
    - [Configuring the API Key in Zotero](#configuring-the-api-key-in-zotero)
  - [Features](#features)
    - [1. Read Paper](#1-read-paper)
    - [2. Find Citations](#2-find-citations)
    - [3. Answer Note Questions](#3-answer-note-questions)
    - [4. Explain Figures and Formulas](#4-explain-figures-and-formulas)
  - [Advanced Settings](#advanced-settings)
    - [AI Model Selection](#ai-model-selection)
    - [Using a Different API Provider](#using-a-different-api-provider)
    - [Index Settings](#index-settings)
    - [PDF Mode](#pdf-mode)
  - [Troubleshooting](#troubleshooting)

---

## Installation

1. Download the latest `.xpi` file from the [Releases](../../releases) page.
2. Open Zotero.
3. Go to **Tools → Plugins**.
4. Drag the `.xpi` file into the Plugins window, or click the gear icon and choose **Install Plugin From File…**
5. Restart Zotero when prompted.

After restarting, three new icon buttons appear in the right-side navigation bar of Zotero.

---

## API Setup

The plugin calls AI models through an API. You need an API key before any feature will work.

### Getting an OpenRouter API Key (recommended)

OpenRouter is a service that provides access to many AI models (GPT-5.6 Luna, Claude, Gemini, DeepSeek, and more) through a single API key. It uses pay-as-you-go pricing; most requests cost a fraction of a cent.

1. Go to [openrouter.ai](https://openrouter.ai) and create a free account.
2. Go to **Keys** in your dashboard and click **Create Key**.
3. Copy the key — it starts with `sk-or-`.

### Configuring the API Key in Zotero

1. In Zotero, open **Edit → Settings** (Windows/Linux) or **Zotero → Settings** (macOS).
2. Click the **Zotero AI** tab.
3. Paste your API key into the **Text Model API Key** field.
4. Paste the same key into the **Embedding Model API Key** field (required for citation search).
5. Click **Save Settings**.

> The default API address and pre-selected models work out of the box with OpenRouter. You do not need to change anything else to get started.

---

## Features

The plugin adds three icon buttons to the right-side navigation bar in Zotero. All three actions are also available by right-clicking any item in your library under the **AI …** menu.

---

### 1. Read Paper

**What it does:** Reads the full text of a selected paper's PDF and generates a structured reading note in Chinese, saved automatically as a child note attached to the paper.

**How to use:**

1. Open a paper in the Zotero PDF reader, or select a paper in your library that has a PDF attachment.
2. Click the **Read Paper** button (document icon) in the right-side navigation bar.
3. A progress indicator appears. The plugin extracts the PDF text, sends it to the AI, and saves the result.
4. When complete, a new child note appears under the paper.

**What the note includes:**
- Research question and objectives
- Methodology
- Key findings and contributions
- Limitations and future directions

**Tips:**
- You can cap the number of text chunks processed in **Settings → Summary Max Chunks** to reduce cost. Setting it to `0` uses the full paper.
- The last few pages are excluded by default (usually reference lists). Adjust this in **Settings → Summary Exclude Trailing Pages**.
- The model label is included at the start of the note so you know which AI generated it.


---

### 2. Find Citations

**What it does:** Searches your entire Zotero library for papers semantically related to an idea or claim you type in. It finds conceptually related papers even if they use different words.

**How to use:**

1. Click the **Find Citations** button (quote-search icon) in the right-side navigation bar.
2. A search panel opens. Type your idea or claim — for example: *"attention mechanisms improve performance in long-document tasks"*.
3. Click **Search**.
4. The plugin searches your local library index and displays the most relevant papers, each with a short reason and an excerpt.

**First-time use — building the index:**

Citation search requires a local index built from your library's PDFs. On your first search, the plugin will ask whether to build the index now. Click **OK** and wait — indexing a few hundred papers typically takes a few minutes.

- The index covers only papers visible in the current Zotero view. Switch to **My Library** to index your entire library.
- You can also rebuild the index at any time from **Settings → Rebuild Index for Current View**.
- If you change the embedding model, the old index is cleared automatically and you will be prompted to rebuild.

---

### 3. Answer Note Questions

**What it does:** Reads a question written in a Zotero note and appends an AI-generated answer using the parent paper's full text as context.

**How to use:**

1. Open a Zotero note that is attached to a paper (child note).
2. Write your question at the end of the note in one of these formats:
   ```
   Q: What does this paper say about data augmentation?
   ```

3. Click the **Answer Note Question** button (question-mark chat icon) in the right-side navigation bar.
4. The plugin reads the parent paper's PDF and appends an `Answer:` section to the note.

**Tips:**
- You can have multiple Q&A pairs in one note. The plugin answers only the **last unanswered** question.
- To ask another question after receiving an answer, write a new `Q:` at the end of the note.


---

### 4. Explain Figures and Formulas

**What it does:** A small sparkle button (✨) appears on image annotations in the PDF reader sidebar. Clicking it sends the image to the AI multimodal model and writes an explanation into the annotation comment.

**How to use:**

1. Open a paper in the Zotero PDF reader.
2. Use the **Area Annotation** tool (the rectangle selector) to select a figure, chart, or equation region.
3. The annotation appears in the right-side annotation list. A small sparkle icon (✨) appears in the top-right corner of the annotation card.
4. Click the sparkle icon.
5. The AI explanation is written into the annotation's comment field — visible when you hover over or open the annotation.

**Tips:**
- To ask a specific question, write `Q: your question` in the annotation comment before clicking the sparkle button. The AI will answer that question instead of giving a generic explanation.
- This feature uses the **Multimodal Model** setting, which defaults to Gemini 3.6 Flash.

---

## Advanced Settings

Open Zotero Settings and click the **Zotero AI** tab to access all options.

### AI Model Selection

| Model type | Default | Used for |
|---|---|---|
| Text Model | DeepSeek V4 Flash | Paper reading, citation reranking, note Q&A |
| Multimodal Model | Gemini 3.6 Flash | Figure/annotation explanation |
| Embedding Model | Nemotron Embed 1B (free) | Building and searching the citation index |

Select a different model from the dropdown, or choose **Custom model id** and type any model ID supported by your API provider.

### Using a Different API Provider

If you have an API key from OpenAI, Anthropic, or another OpenAI-compatible service:

1. Change the **API Format** for the relevant model type from `OpenRouter` to `OpenAI Compatible`.
2. Enter the full API base URL (e.g., `https://api.openai.com/v1`).
3. Enter your API key.
4. Enter the exact model ID (e.g., `gpt-4o`).

### Index Settings

- **Summary Max Chunks (0 = unlimited):** Caps how much text is sent when reading a paper. Lower values are faster and cheaper but may miss details.
- **Summary Exclude Trailing Pages:** Pages to skip from the end of each PDF (typically reference lists). Default is 2.
- **Citation Result Count:** How many results the citation search returns. Default is 5.

### PDF Mode

- **Local text first (default):** Uses text already indexed by Zotero. Fast and free.
- **Remote PDF parser/OCR fallback:** If local text is unavailable (e.g., a scanned PDF), the plugin sends the PDF to the remote API for parsing. This uses more API tokens.


---

## Troubleshooting

**"Please select a paper with a PDF attachment"**
Select a Zotero item that has a PDF before clicking Read Paper.

**"No unanswered question found"**
Make sure your note ends with a `Q:` or `问题:` line that does not already have a following `Answer:` block.

**Citation search returns no results**
The index may be empty or out of date. In the search panel, confirm when asked to rebuild, or go to Settings and click **Rebuild Index for Current View**.

**API errors / "API key not set"**
Go to Settings and make sure the API key field for the relevant model type is filled in. Verify the API base URL matches your provider.

**The sparkle button does not appear on annotations**
The button only appears on image/area annotations, not text highlight annotations. Use the area selection tool to create the annotation.

**Changing the embedding model clears my index**
This is intentional — vectors built with one model cannot be searched with another. Rebuild the index after switching models.

