(function () {
  const PREF_BRANCH = "extensions.zotero-ai.";
  const PLUGIN_NS = "zotero-ai";
  const MATH_OUTPUT_INSTRUCTIONS = [
    "数学公式必须使用 Zotero 可渲染的 LaTeX 定界符。",
    "行内公式使用单个美元符号包裹，例如 $x_i$。",
    "独立公式使用单独成行的 $$、公式内容、单独成行的 $$。",
    "不要使用 \\(...\\) 或 \\[...\\]，不要把公式放进代码块。"
  ].join("");

  const DEFAULTS = {
    chunkSize: 500,
    chunkOverlap: 100,
    maxContextChars: 18000,
    maxSummaryChunks: 0,
    summaryExcludeTrailingPages: 2,
    referenceTopK: 5,
    embedBatchSize: 24,
    requestTimeoutMs: 60000
  };
  const DEFAULT_API_BASE_URL = "https://openrouter.ai/api/v1";

  const SELECTORS = {
    sideNav: [
      "sidenav",
      "#sidenav",
      ".sidenav",
      ".side-nav",
      "[id*='sidenav']",
      "[class*='sidenav']",
      "[id*='side-nav']",
      "[class*='side-nav']",
      "#zotero-context-pane sidenav",
      "#zotero-context-pane .sidenav",
      "#zotero-context-pane [class*='sidenav']",
      "#zotero-item-pane sidenav",
      "#zotero-item-pane .sidenav",
      "#zotero-item-pane [class*='sidenav']",
      ".context-pane sidenav",
      ".context-pane .sidenav",
      ".item-pane sidenav",
      ".item-pane .sidenav",
      "[role='tablist'][aria-orientation='vertical']",
      "[role='toolbar'][aria-orientation='vertical']",
      "[class*='sidebar'] [role='tablist']",
      "[class*='pane'] [role='tablist']"
    ]
  };

  function pref(key, fallback = "") {
    try {
      const value = Zotero.Prefs.get(PREF_BRANCH + key, true);
      return value === undefined || value === null ? fallback : value;
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: failed to read pref ${key}: ${err}`);
      return fallback;
    }
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\r/g, "\n")
      .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function normalizeAPIBaseURL(value, fallback = DEFAULT_API_BASE_URL) {
    let baseURL = String(value || fallback).trim();
    if (!baseURL) {
      baseURL = fallback;
    }
    if (!/^https?:\/\//i.test(baseURL)) {
      baseURL = `https://${baseURL}`;
    }
    return baseURL
      .replace(/\/(?:chat\/completions|embeddings)$/i, "")
      .replace(/\/+$/, "");
  }

  function isOpenRouterURL(baseURL) {
    try {
      return /(^|\.)openrouter\.ai$/i.test(new URL(baseURL).hostname);
    }
    catch (err) {
      return false;
    }
  }

  function normalizePositiveInt(value, fallback, min = 0, max = Infinity) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(number)));
  }

  function stripHTML(html) {
    return String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  function escapeHTML(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function textToNoteHTML(text) {
    return normalizeText(text)
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escapeHTML(paragraph).replace(/\n/g, "<br/>")}</p>`)
      .join("\n");
  }

  function mathToNoteHTML(content, display) {
    const formula = String(content || "").trim();
    if (!formula) {
      return "";
    }
    const escaped = escapeHTML(formula);
    return display
      ? `<pre class="math">$$${escaped}$$</pre>`
      : `<span class="math">$${escaped}$</span>`;
  }

  function isEscaped(text, index) {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
      slashes++;
    }
    return slashes % 2 === 1;
  }

  function inlineMarkdownToHTML(text) {
    const source = String(text || "");
    const formulas = [];
    let masked = "";
    let index = 0;

    function addFormula(content) {
      const placeholder = `ZOTEROAIMATH${formulas.length}TOKEN`;
      formulas.push({ placeholder, content });
      masked += placeholder;
    }

    while (index < source.length) {
      if (source[index] === "`") {
        const end = source.indexOf("`", index + 1);
        if (end !== -1) {
          masked += source.slice(index, end + 1);
          index = end + 1;
          continue;
        }
      }

      if (source.startsWith("\\(", index)) {
        const end = source.indexOf("\\)", index + 2);
        if (end !== -1) {
          const formula = source.slice(index + 2, end).trim();
          if (formula) {
            addFormula(formula);
            index = end + 2;
            continue;
          }
        }
      }

      if (source[index] === "$"
        && source[index + 1] !== "$"
        && !isEscaped(source, index)) {
        let end = index + 1;
        while (end < source.length) {
          if (source[end] === "$"
            && source[end - 1] !== "$"
            && source[end + 1] !== "$"
            && !isEscaped(source, end)) {
            break;
          }
          end++;
        }
        if (end < source.length) {
          const formula = source.slice(index + 1, end).trim();
          if (formula) {
            addFormula(formula);
            index = end + 1;
            continue;
          }
        }
      }

      masked += source[index];
      index++;
    }

    let html = escapeHTML(masked)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

    for (const formula of formulas) {
      html = html.split(formula.placeholder).join(mathToNoteHTML(formula.content, false));
    }
    return html;
  }

  function readDisplayMath(lines, startIndex) {
    const line = lines[startIndex].trim();
    const bracketed = line.match(/^\\\[\s*([\s\S]*?)\s*\\\]$/);
    if (bracketed?.[1]?.trim()) {
      return { content: bracketed[1].trim(), endIndex: startIndex };
    }
    const dollarDelimited = line.match(/^\$\$\s*([\s\S]*?)\s*\$\$$/);
    if (dollarDelimited?.[1]?.trim()) {
      return { content: dollarDelimited[1].trim(), endIndex: startIndex };
    }

    if (line !== "\\[" && line !== "$$") {
      return null;
    }
    const closing = line === "\\[" ? "\\]" : "$$";
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (lines[i].trim() === closing) {
        return {
          content: lines.slice(startIndex + 1, i).join("\n").trim(),
          endIndex: i
        };
      }
    }
    return null;
  }

  function normalizeMathDelimiters(text) {
    return String(text || "")
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => `$$\n${formula.trim()}\n$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, formula) => `$${formula.trim()}$`);
  }

  function flushList(out, list) {
    if (!list) {
      return null;
    }
    out.push(`<${list.type}>`);
    for (const item of list.items) {
      out.push(`<li>${inlineMarkdownToHTML(item)}</li>`);
    }
    out.push(`</${list.type}>`);
    return null;
  }

  function markdownToNoteHTML(markdown) {
    const lines = normalizeText(markdown).split("\n");
    const out = [];
    let paragraph = [];
    let list = null;

    function flushParagraph() {
      if (!paragraph.length) {
        return;
      }
      out.push(`<p>${inlineMarkdownToHTML(paragraph.join(" ")).trim()}</p>`);
      paragraph = [];
    }

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const line = rawLine.trim();
      const displayMath = readDisplayMath(lines, i);
      if (displayMath) {
        flushParagraph();
        list = flushList(out, list);
        if (displayMath.content) {
          out.push(mathToNoteHTML(displayMath.content, true));
        }
        i = displayMath.endIndex;
        continue;
      }
      if (!line) {
        flushParagraph();
        list = flushList(out, list);
        continue;
      }
      if (/^---+$/.test(line)) {
        flushParagraph();
        list = flushList(out, list);
        out.push("<hr/>");
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        list = flushList(out, list);
        const level = Math.min(6, heading[1].length);
        out.push(`<h${level}>${inlineMarkdownToHTML(heading[2])}</h${level}>`);
        continue;
      }

      const unordered = line.match(/^[-*]\s+(.+)$/);
      if (unordered) {
        flushParagraph();
        if (!list || list.type !== "ul") {
          list = flushList(out, list);
          list = { type: "ul", items: [] };
        }
        list.items.push(unordered[1]);
        continue;
      }

      const ordered = line.match(/^\d+[.)]\s+(.+)$/);
      if (ordered) {
        flushParagraph();
        if (!list || list.type !== "ol") {
          list = flushList(out, list);
          list = { type: "ol", items: [] };
        }
        list.items.push(ordered[1]);
        continue;
      }

      list = flushList(out, list);
      paragraph.push(line);
    }

    flushParagraph();
    flushList(out, list);
    return out.join("\n");
  }

  function modelLabelFromID(modelID) {
    const id = String(modelID || "").trim();
    const label = id.includes("/") ? id.split("/").pop() : id;
    return (label || "unknown-model").toLowerCase();
  }

  function cleanSummaryMarkdown(markdown) {
    let text = normalizeText(markdown)
      .replace(/^```(?:markdown)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    text = text
      .replace(/^#+\s*AI\s*论文阅读笔记\s*\n+/i, "")
      .replace(/^这是一份[^\n]*?(?:阅读笔记|学术阅读笔记)[^\n]*[:：]?\s*/i, "")
      .replace(/^---+\s*/i, "")
      .trim();

    return text;
  }

  function cleanMarkdown(markdown) {
    return normalizeText(markdown)
      .replace(/^```(?:markdown)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }

  function isRegularItem(item) {
    return !!item && !item.isNote?.() && !item.isAttachment?.();
  }

  function isNoteItem(item) {
    return !!item && item.isNote?.();
  }

  function getSelectedItems(win) {
    try {
      return win.ZoteroPane.getSelectedItems() || [];
    }
    catch (err) {
      return [];
    }
  }

  function getSelectedRegularItems(win) {
    return getSelectedItems(win).filter(isRegularItem);
  }

  function getSelectedNote(win) {
    return getSelectedItems(win).find(isNoteItem) || null;
  }

  function alertUser(win, title, message) {
    Services.prompt.alert(win, title, message);
  }

  function confirmUser(win, title, message) {
    return Services.prompt.confirm(win, title, message);
  }

  function findFirstElement(doc, selectors) {
    for (const selector of selectors) {
      try {
        const element = doc.querySelector(selector);
        if (element) {
          return element;
        }
      }
      catch (err) {
        // Zotero UI internals differ across 7.x builds.
      }
    }
    return null;
  }

  function createXULElement(doc, name) {
    return doc.createXULElement ? doc.createXULElement(name) : doc.createElement(name);
  }

  function isHTMLDocument(doc) {
    return doc?.documentElement?.namespaceURI === "http://www.w3.org/1999/xhtml"
      || /^text\/html\b/i.test(doc?.contentType || "");
  }

  function getMainWindows() {
    if (typeof Zotero.getMainWindows === "function") {
      return Zotero.getMainWindows().filter((win) => win?.ZoteroPane);
    }

    const result = [];
    const windows = Services.wm.getEnumerator("navigator:browser");
    while (windows.hasMoreElements()) {
      const win = windows.getNext();
      if (win.ZoteroPane) {
        result.push(win);
      }
    }
    return result;
  }

  function createIconButton(doc, id, title, iconURI, onCommand) {
    const isHTML = isHTMLDocument(doc);
    const button = isHTML ? doc.createElement("button") : createXULElement(doc, "toolbarbutton");
    button.id = id;
    button.className = "zotero-ai-toolbar-button";
    button.label = title;
    button.setAttribute("tooltiptext", title);
    button.setAttribute("title", title);
    button.setAttribute("aria-label", title);
    button.setAttribute("type", "button");
    button.setAttribute("image", iconURI);
    button.style.backgroundImage = `url("${iconURI}")`;
    button.addEventListener(isHTML ? "click" : "command", onCommand);
    return button;
  }

  function getAccessibleDocuments(rootDoc) {
    const result = [];
    const seen = new Set();

    function add(doc) {
      if (!doc || seen.has(doc)) {
        return;
      }
      seen.add(doc);
      result.push(doc);

      let frames = [];
      try {
        frames = Array.from(doc.querySelectorAll("iframe, browser"));
      }
      catch (err) {
        return;
      }

      for (const frame of frames) {
        try {
          add(frame.contentDocument || frame.contentWindow?.document);
        }
        catch (err) {
          // Some internal browser documents are intentionally inaccessible.
        }
      }
    }

    add(rootDoc);
    return result;
  }

  function isVisibleElement(element) {
    if (!element?.ownerDocument?.defaultView) {
      return false;
    }
    try {
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    catch (err) {
      return false;
    }
  }

  function getActiveReader(win) {
    try {
      const tabID = win.Zotero_Tabs?.selectedID || win.Zotero_Tabs?._selectedID;
      if (tabID && Zotero.Reader?.getByTabID) {
        const reader = Zotero.Reader.getByTabID(tabID);
        if (reader) {
          return reader;
        }
      }
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: failed to get active reader by tab: ${err}`);
    }

    try {
      const readers = Zotero.Reader?._readers || Zotero.Reader?.readers || [];
      const list = Array.isArray(readers) ? readers : Object.values(readers);
      const tabID = win.Zotero_Tabs?.selectedID || win.Zotero_Tabs?._selectedID;
      // Only match by tab ID — never fall back to _window/_iframeWindow, which
      // would pick up a stale reader from a previously opened tab.
      if (!tabID) {
        return null;
      }
      return list.find((reader) =>
        reader?.tabID === tabID
        || reader?._tabID === tabID
      ) || null;
    }
    catch (err) {
      return null;
    }
  }

  function getReaderAttachmentID(reader) {
    return reader?.itemID
      || reader?._itemID
      || reader?.item?.id
      || reader?._item?.id
      || reader?.attachmentID
      || reader?._attachmentID
      || null;
  }

  async function getParentRegularItem(item) {
    if (!item) {
      return null;
    }
    if (isRegularItem(item)) {
      return item;
    }
    if (item.isAttachment?.() && item.parentItemID) {
      const parent = await Zotero.Items.getAsync(item.parentItemID);
      return isRegularItem(parent) ? parent : null;
    }
    return null;
  }

  async function getReaderRegularItem(win) {
    const reader = getActiveReader(win);
    const attachmentID = getReaderAttachmentID(reader);
    if (!attachmentID) {
      return null;
    }
    try {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      return getParentRegularItem(attachment);
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: failed to resolve reader item: ${err}`);
      return null;
    }
  }

  function getNoteEditors(doc) {
    return Array.from(doc.querySelectorAll("note-editor, zotero-note-editor, [id*='note-editor'], [class*='note-editor']"));
  }

  function getActiveNoteEditor(win) {
    if (!win?.document) {
      return null;
    }
    const editors = getAccessibleDocuments(win.document)
      .flatMap(getNoteEditors)
      .filter((editor) => editor?.item || editor?._item || editor?.itemID || editor?._itemID);
    if (!editors.length) {
      return null;
    }
    return editors.find((editor) => {
      const focused = editor.ownerDocument?.activeElement;
      return editor === focused || editor.contains?.(focused);
    }) || editors[editors.length - 1];
  }

  async function getEditorNoteItem(win) {
    const editor = getActiveNoteEditor(win);
    if (!editor) {
      return null;
    }

    try {
      editor.saveSync?.();
      await editor.save?.();
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: note editor save before answer failed: ${err}`);
    }

    const item = editor.item || editor._item;
    if (isNoteItem(item)) {
      return item;
    }

    const itemID = editor.itemID || editor._itemID || editor.getAttribute?.("item-id") || editor.dataset?.itemId;
    if (!itemID) {
      return null;
    }
    try {
      const note = await Zotero.Items.getAsync(Number(itemID));
      return isNoteItem(note) ? note : null;
    }
    catch (err) {
      return null;
    }
  }

  function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) {
      return -Infinity;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (!normA || !normB) {
      return -Infinity;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  function chunkText(text, options = {}) {
    const max = Number(options.chunkSize || DEFAULTS.chunkSize);
    const overlap = Number(options.chunkOverlap || DEFAULTS.chunkOverlap);
    const normalized = normalizeText(text);
    if (!normalized) {
      return [];
    }

    const paragraphs = normalized
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);

    const chunks = [];
    let current = "";
    for (const paragraph of paragraphs) {
      if (paragraph.length > max) {
        if (current) {
          chunks.push(current.trim());
          current = "";
        }
        const step = Math.max(1, max - overlap);
        for (let start = 0; start < paragraph.length; start += step) {
          chunks.push(paragraph.slice(start, start + max).trim());
        }
        continue;
      }

      const joined = current ? `${current}\n\n${paragraph}` : paragraph;
      if (joined.length > max && current) {
        chunks.push(current.trim());
        const suffix = current.slice(Math.max(0, current.length - overlap));
        current = suffix ? `${suffix}\n\n${paragraph}` : paragraph;
      }
      else {
        current = joined;
      }
    }
    if (current.trim()) {
      chunks.push(current.trim());
    }
    return chunks.filter((chunk) => chunk.length > 40);
  }

  function hashText(text) {
    let hash = 2166136261;
    const value = String(text || "");
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  function getItemTitle(item) {
    return item?.getField?.("title") || item?.getDisplayTitle?.() || "Untitled";
  }

  function truncateTitle(title, max = 35) {
    return title.length > max ? title.slice(0, max) + "…" : title;
  }

  function getCreators(item) {
    try {
      return item.getCreators()
        .map((creator) => creator.lastName || creator.name || "")
        .filter(Boolean)
        .join(", ");
    }
    catch (err) {
      return "";
    }
  }

  async function getBestAttachment(item) {
    if (!item) {
      return null;
    }

    let attachments = [];
    try {
      attachments = await item.getAttachments();
    }
    catch (err) {
      attachments = [];
    }

    for (const attachmentID of attachments) {
      const attachment = await Zotero.Items.getAsync(attachmentID);
      if (!attachment?.isAttachment?.()) {
        continue;
      }
      const contentType = attachment.attachmentContentType || "";
      const path = attachment.getFilePath?.() || "";
      if (contentType === "application/pdf" || /\.pdf$/i.test(path)) {
        return attachment;
      }
    }
    return null;
  }

  async function getAttachmentPath(attachment) {
    try {
      return await attachment.getFilePathAsync();
    }
    catch (err) {
      return attachment?.getFilePath?.() || "";
    }
  }

  async function readTextFile(path) {
    if (!path || !(await IOUtils.exists(path))) {
      return "";
    }
    try {
      if (Zotero.File?.getContentsAsync) {
        return await Zotero.File.getContentsAsync(path);
      }
      return await IOUtils.readUTF8(path);
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: failed to read text file ${path}: ${err}`);
      return "";
    }
  }

  async function getFulltextCacheText(attachment) {
    const fulltext = Zotero.Fulltext || Zotero.FullText;
    const candidates = [];

    try {
      const cacheFile = fulltext?.getItemCacheFile?.(attachment);
      if (cacheFile?.path) {
        candidates.push(cacheFile.path);
      }
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: getItemCacheFile failed: ${err}`);
    }

    try {
      const attachmentPath = await getAttachmentPath(attachment);
      if (attachmentPath) {
        candidates.push(PathUtils.join(PathUtils.parent(attachmentPath), ".zotero-ft-cache"));
      }
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: fallback cache path failed: ${err}`);
    }

    for (const path of candidates) {
      const text = normalizeText(await readTextFile(path));
      if (text.length > 100) {
        return text;
      }
    }
    return "";
  }

  async function extractPDFTextWithZoteroWorker(attachment) {
    if (!Zotero.PDFWorker?.getFullText) {
      return "";
    }
    try {
      const result = await Zotero.PDFWorker.getFullText(attachment.id, null);
      const text = normalizeText(result?.text || "");
      if (text.length > 100) {
        return text;
      }
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: PDFWorker.getFullText failed: ${err}`);
    }
    return "";
  }

  async function indexAttachmentAndReadCache(attachment) {
    const fulltext = Zotero.Fulltext || Zotero.FullText;
    if (!fulltext?.indexItems) {
      return "";
    }
    try {
      await fulltext.indexItems([attachment.id], {
        complete: true,
        ignoreErrors: true
      });
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: Fulltext.indexItems failed: ${err}`);
    }
    return getFulltextCacheText(attachment);
  }

  function normalizePageText(page) {
    if (typeof page === "string") {
      return normalizeText(page);
    }
    return normalizeText(page?.text || page?.content || page?.pageText || "");
  }

  async function getIndexedAttachmentPages(attachment) {
    if (!attachment || !Zotero.Fulltext?.getPages) {
      return [];
    }

    const candidates = [
      () => Zotero.Fulltext.getPages(attachment.id),
      () => Zotero.Fulltext.getPages(attachment)
    ];

    for (const candidate of candidates) {
      try {
        const pages = await candidate();
        if (!Array.isArray(pages)) {
          continue;
        }
        const normalized = pages.map(normalizePageText);
        if (normalizeText(normalized.join("\n\n")).length > 100) {
          return normalized;
        }
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: Fulltext.getPages failed: ${err}`);
      }
    }
    return [];
  }

  async function getIndexedAttachmentText(attachment) {
    if (!attachment) {
      return "";
    }

    const candidates = [];
    if (Zotero.Fulltext?.getItemText) {
      candidates.push(() => Zotero.Fulltext.getItemText(attachment.id));
      candidates.push(() => Zotero.Fulltext.getItemText(attachment));
    }
    if (Zotero.Fulltext?.getPages) {
      candidates.push(async () => {
        const pages = await Zotero.Fulltext.getPages(attachment.id);
        if (Array.isArray(pages)) {
          return pages.map((page) => page.text || page).join("\n\n");
        }
        return "";
      });
    }

    for (const candidate of candidates) {
      try {
        const result = await candidate();
        if (typeof result === "string" && normalizeText(result).length > 100) {
          return normalizeText(result);
        }
        if (result?.text && normalizeText(result.text).length > 100) {
          return normalizeText(result.text);
        }
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: fulltext candidate failed: ${err}`);
      }
    }

    const cacheText = await getFulltextCacheText(attachment);
    if (cacheText) {
      return cacheText;
    }

    const workerText = await extractPDFTextWithZoteroWorker(attachment);
    if (workerText) {
      return workerText;
    }

    const indexedText = await indexAttachmentAndReadCache(attachment);
    if (indexedText) {
      return indexedText;
    }

    return "";
  }

  function getSummaryInput(text, pages) {
    const fallbackText = normalizeText(text);
    const excludeTrailingPages = normalizePositiveInt(
      pref("summaryExcludeTrailingPages", DEFAULTS.summaryExcludeTrailingPages),
      DEFAULTS.summaryExcludeTrailingPages,
      0,
      200
    );

    const normalizedPages = Array.isArray(pages)
      ? pages.map(normalizePageText).filter(Boolean)
      : [];

    if (!normalizedPages.length) {
      return {
        text: fallbackText,
        range: "full text; page boundaries unavailable"
      };
    }

    const selectedPages = excludeTrailingPages > 0 && normalizedPages.length > excludeTrailingPages
      ? normalizedPages.slice(0, normalizedPages.length - excludeTrailingPages)
      : normalizedPages;
    const pageText = normalizeText(selectedPages.join("\n\n"));

    if (pageText.length < 100) {
      return {
        text: fallbackText,
        range: "full text; selected page range was too short"
      };
    }

    return {
      text: pageText,
      range: excludeTrailingPages > 0 && normalizedPages.length > excludeTrailingPages
        ? `pages 1-${selectedPages.length}; excluded last ${excludeTrailingPages} page(s)`
        : `pages 1-${selectedPages.length}; no trailing pages excluded`
    };
  }

  function getSummaryChunks(text) {
    const chunks = chunkText(text, {
      chunkSize: 5000,
      chunkOverlap: 350
    });
    const maxChunks = normalizePositiveInt(
      pref("maxSummaryChunks", DEFAULTS.maxSummaryChunks),
      DEFAULTS.maxSummaryChunks,
      0,
      500
    );
    return maxChunks > 0 ? chunks.slice(0, maxChunks) : chunks;
  }

  async function readFileAsBase64(path) {
    if (!path) {
      throw new Error("PDF 文件路径为空。");
    }
    const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
    file.initWithPath(path);
    const bytes = await IOUtils.read(file.path);
    let binary = "";
    const sliceSize = 0x8000;
    for (let i = 0; i < bytes.length; i += sliceSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + sliceSize));
    }
    return btoa(binary);
  }

  function getDataDirectory() {
    const dir = Zotero.getStorageDirectory().clone();
    dir.append("zotero-ai-assistant");
    if (!dir.exists()) {
      dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
    }
    return dir.path;
  }

  function getIndexPath(libraryID) {
    const safeID = String(libraryID || "default").replace(/[^a-z0-9_-]/gi, "_");
    return PathUtils.join(getDataDirectory(), `index-${safeID}.json`);
  }

  async function readJSON(path, fallback) {
    try {
      if (!(await IOUtils.exists(path))) {
        return fallback;
      }
      return JSON.parse(await IOUtils.readUTF8(path));
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: failed reading ${path}: ${err}`);
      return fallback;
    }
  }

  async function writeJSON(path, value) {
    await IOUtils.writeUTF8(path, JSON.stringify(value, null, 2), {
      tmpPath: `${path}.tmp`
    });
  }

  function extractJSONArray(text) {
    const value = String(text || "").trim();
    const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = fenced ? fenced[1].trim() : value;
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("没有找到 JSON 数组。");
    }
    return JSON.parse(candidate.slice(start, end + 1));
  }

  // Parse annotation comment text for the last unanswered Q: (same logic as the note Q:/A: system).
  // Returns { question: string|null, hasUnanswered: boolean }.
  function parseAnnotationComment(text) {
    const plain = normalizeText(text || "");
    if (!plain) {
      return { question: null, hasUnanswered: false };
    }
    const markerRE = /(?:^|\n)\s*(Q|Question|A|Answer)\s*[:：]/gi;
    const markers = Array.from(plain.matchAll(markerRE)).map((match) => ({
      type: /^(Q|Question)$/i.test(match[1]) ? "question" : "answer",
      index: match.index || 0,
      end: (match.index || 0) + match[0].length
    }));
    for (let i = markers.length - 1; i >= 0; i--) {
      const marker = markers[i];
      if (marker.type !== "question") {
        continue;
      }
      const next = markers[i + 1];
      // If the very next marker after this Q: is an A:, this question is already answered.
      if (next?.type === "answer") {
        continue;
      }
      const question = normalizeText(plain.slice(marker.end, next?.index ?? plain.length));
      if (!question) {
        continue;
      }
      return { question, hasUnanswered: true };
    }
    return { question: null, hasUnanswered: false };
  }

  class OpenAICompatibleClient {
    getModelSettings(kind = "text") {
      const settings = {
        text: {
          label: "文本模型",
          formatPref: "chatAPIFormat",
          baseURLPref: "chatBaseURL",
          apiKeyPref: "chatApiKey",
          modelPref: "chatModel",
          customModelPref: "customChatModel",
          defaultModel: "deepseek/deepseek-v4-flash-0731"
        },
        multimodal: {
          label: "多模态模型",
          formatPref: "multimodalAPIFormat",
          baseURLPref: "multimodalBaseURL",
          apiKeyPref: "multimodalApiKey",
          modelPref: "multimodalModel",
          customModelPref: "customMultimodalModel",
          defaultModel: "google/gemini-3.6-flash"
        },
        embedding: {
          label: "Embedding 模型",
          formatPref: "embeddingAPIFormat",
          baseURLPref: "embeddingBaseURL",
          apiKeyPref: "embeddingApiKey",
          modelPref: "embeddingModel",
          customModelPref: "customEmbeddingModel",
          defaultModel: "nvidia/nemotron-3-embed-1b:free"
        }
      }[kind] || null;
      if (!settings) {
        throw new Error(`未知的模型类型：${kind}`);
      }

      const configuredModel = String(pref(settings.modelPref, settings.defaultModel)).trim();
      const model = configuredModel === "custom"
        ? String(pref(settings.customModelPref, "")).trim()
        : configuredModel;
      const apiKey = String(
        pref(settings.apiKeyPref, "") || pref("openrouterApiKey", "")
      ).trim();
      return {
        ...settings,
        format: pref(settings.formatPref, "openrouter") === "openai"
          ? "openai"
          : "openrouter",
        baseURL: normalizeAPIBaseURL(pref(settings.baseURLPref, DEFAULT_API_BASE_URL)),
        apiKey,
        model: model || settings.defaultModel
      };
    }

    get apiKey() {
      return this.getModelSettings("text").apiKey;
    }

    get chatModel() {
      return this.getModelSettings("text").model;
    }

    get embeddingModel() {
      return this.getModelSettings("embedding").model;
    }

    get multimodalModel() {
      return this.getModelSettings("multimodal").model;
    }

    ensureConfigured(kind = "text") {
      const config = this.getModelSettings(kind);
      if (!config.baseURL) {
        throw new Error(`请先在 Zotero 设置中填写${config.label} API 地址。`);
      }
      if (!config.model) {
        throw new Error(`请先在 Zotero 设置中填写${config.label}模型名。`);
      }
      return config;
    }

    async request(kind, path, body) {
      const config = this.ensureConfigured(kind);
      const timeoutMs = DEFAULTS.requestTimeoutMs;
      const headers = {
        "Content-Type": "application/json"
      };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }
      if (config.format === "openrouter" || isOpenRouterURL(config.baseURL)) {
        headers["HTTP-Referer"] = "https://www.zotero.org";
        headers["X-Title"] = "Zotero AI Assistant";
      }
      const fetchPromise = fetch(`${config.baseURL}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`${config.label} API 请求超时（超过 ${timeoutMs / 1000}s），请检查网络或稍后重试。`));
        }, timeoutMs);
      });
      const response = await Promise.race([fetchPromise, timeoutPromise]);

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      }
      catch (err) {
        payload = { error: { message: text } };
      }

      if (!response.ok) {
        const message = payload?.error?.message || response.statusText || "API request failed";
        throw new Error(`${config.label} API ${response.status}: ${message}`);
      }
      return payload;
    }

    async chat(messages, options = {}) {
      const kind = options.modelType || "text";
      const config = this.ensureConfigured(kind);
      const payload = await this.request(kind, "/chat/completions", {
        model: options.model || config.model,
        messages,
        temperature: options.temperature ?? 0.2
      });
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`${config.label} API 没有返回可用回答。`);
      }
      return typeof content === "string"
        ? content
        : content.map((part) => part.text || "").join("\n").trim();
    }

    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts];
      const config = this.ensureConfigured("embedding");
      const payload = await this.request("embedding", "/embeddings", {
        model: config.model,
        input
      });
      const data = payload?.data;
      if (!Array.isArray(data)) {
        throw new Error("Embedding API 返回格式异常。");
      }
      return data
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map((entry) => entry.embedding);
    }

    async parsePdfBase64(base64, prompt) {
      return this.chat([
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                filename: "paper.pdf",
                file_data: `data:application/pdf;base64,${base64}`
              }
            },
            {
              type: "text",
              text: prompt || "请提取这篇 PDF 的正文文本。尽量保留标题、摘要、章节标题、图表说明和关键段落。不要总结，不要编造。"
            }
          ]
        }
      ], {
        modelType: "multimodal",
        temperature: 0
      });
    }

    // Explain an image annotation (figure/formula) using a multimodal model.
    // textContext: surrounding page text; question: optional user question from Q: marker.
    async explainWithVision(imageBase64, textContext, question) {
      const userParts = [];
      if (textContext) {
        userParts.push({ type: "text", text: textContext });
      }
      userParts.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${imageBase64}` }
      });
      const questionText = question
        ? `请根据以上上下文和图片回答：${question}`
        : "请详细解释上图中的图表或公式，包括其含义、关键参数和在论文中的作用。";
      userParts.push({ type: "text", text: questionText });
      return this.chat([
        {
          role: "system",
          content: "你是学术论文图表和公式解释助手。请根据提供的页面文字上下文和图像，详细解释图表或公式的含义、关键参数和在论文中的作用。回答应准确、完整，基于提供的材料。" + MATH_OUTPUT_INSTRUCTIONS
        },
        { role: "user", content: userParts }
      ], {
        modelType: "multimodal",
        model: this.multimodalModel,
        temperature: 0.2
      });
    }
  }

  class TextSource {
    constructor(client) {
      this.client = client;
    }

    async getTextForItem(item, options = {}) {
      const attachment = await getBestAttachment(item);
      if (!attachment) {
        throw new Error(`“${getItemTitle(item)}” 没有找到 PDF 附件。`);
      }

      if (!options.forcePdfParser) {
        const localPages = await getIndexedAttachmentPages(attachment);
        if (localPages.length) {
          return {
            text: normalizeText(localPages.join("\n\n")),
            pages: localPages,
            source: "zotero-fulltext-pages",
            attachmentID: attachment.id
          };
        }

        const localText = await getIndexedAttachmentText(attachment);
        if (localText) {
          return {
            text: localText,
            pages: [],
            source: "zotero-fulltext",
            attachmentID: attachment.id
          };
        }
      }

      const mode = options.forcePdfParser ? "openrouter-pdf" : pref("pdfMode", "local-first");
      if (mode !== "openrouter-pdf") {
        throw new Error("没有找到 Zotero 已索引的 PDF 文本。请先让 Zotero 完成 PDF 全文索引，或在设置中启用远程 PDF parser/OCR fallback。");
      }

      const path = await getAttachmentPath(attachment);
      const base64 = await readFileAsBase64(path);
      const text = await this.client.parsePdfBase64(base64);
      const normalized = normalizeText(text);
      if (normalized.length < 100) {
        throw new Error("远程 PDF parser/OCR 没有提取到足够文本。");
      }
      return {
        text: normalized,
        pages: [],
        source: "openrouter-pdf",
        attachmentID: attachment.id
      };
    }
  }

  class IndexStore {
    constructor(client, textSource) {
      this.client = client;
      this.textSource = textSource;
      this._modelChangedOnLoad = false;
    }

    async load(libraryID) {
      this._modelChangedOnLoad = false;
      const index = await readJSON(getIndexPath(libraryID), {
        version: 1,
        libraryID,
        embeddingModel: this.client.embeddingModel,
        items: {}
      });
      if (index.embeddingModel !== this.client.embeddingModel) {
        this._modelChangedOnLoad = true;
        index.embeddingModel = this.client.embeddingModel;
        index.items = {};
      }
      return index;
    }

    async save(libraryID, index) {
      index.version = 1;
      index.libraryID = libraryID;
      index.embeddingModel = this.client.embeddingModel;
      await writeJSON(getIndexPath(libraryID), index);
    }

    async clear(libraryID) {
      await this.save(libraryID, {
        version: 1,
        libraryID,
        embeddingModel: this.client.embeddingModel,
        items: {}
      });
    }

    async rebuildItems(items, progressCallback, chunkOptions = {}) {
      const byLibrary = new Map();
      for (const item of items) {
        const libraryID = item.libraryID || "default";
        if (!byLibrary.has(libraryID)) {
          byLibrary.set(libraryID, []);
        }
        byLibrary.get(libraryID).push(item);
      }

      let indexed = 0;
      const failures = [];
      for (const [libraryID, libraryItems] of byLibrary.entries()) {
        const index = await this.load(libraryID);
        for (let i = 0; i < libraryItems.length; i++) {
          const item = libraryItems[i];
          progressCallback?.(`正在索引 ${i + 1}/${libraryItems.length}: ${truncateTitle(getItemTitle(item))}`);
          try {
            await this.indexItem(index, item, chunkOptions);
            indexed++;
          }
          catch (err) {
            failures.push(`${truncateTitle(getItemTitle(item))}: ${err.message || err}`);
            Zotero.debug(`Zotero AI Assistant: index failed for item ${item.id}: ${err}\n${err.stack}`);
          }
        }
        await this.save(libraryID, index);
      }
      return { indexed, failures };
    }

    async indexItem(index, item, chunkOptions = {}) {
      const { text, attachmentID, source } = await this.textSource.getTextForItem(item);
      const textHash = hashText(text);
      const chunkKey = `${chunkOptions.chunkSize || DEFAULTS.chunkSize}:${chunkOptions.chunkOverlap || DEFAULTS.chunkOverlap}`;
      const existing = index.items[item.id];
      if (
        existing &&
        existing.textHash === textHash &&
        existing.embeddingModel === this.client.embeddingModel &&
        existing.chunkKey === chunkKey &&
        Array.isArray(existing.chunks) &&
        existing.chunks.length
      ) {
        return existing;
      }

      const chunks = chunkText(text, chunkOptions);
      if (!chunks.length) {
        throw new Error(`“${getItemTitle(item)}” 没有足够的文本可索引。`);
      }

      const embeddings = [];
      for (let start = 0; start < chunks.length; start += DEFAULTS.embedBatchSize) {
        const batch = chunks.slice(start, start + DEFAULTS.embedBatchSize);
        embeddings.push(...await this.client.embed(batch));
      }

      index.items[item.id] = {
        itemID: item.id,
        libraryID: item.libraryID,
        attachmentID,
        title: getItemTitle(item),
        creators: getCreators(item),
        year: item.getField?.("year") || item.getField?.("date") || "",
        source,
        textHash,
        chunkKey,
        embeddingModel: this.client.embeddingModel,
        indexedAt: new Date().toISOString(),
        chunks: chunks.map((chunk, idx) => ({
          id: `${item.id}-${idx}`,
          text: chunk,
          embedding: embeddings[idx]
        }))
      };
      return index.items[item.id];
    }

    async ensureItemsIndexed(items, progressCallback) {
      const missing = [];
      const byLibrary = new Map();
      for (const item of items) {
        const libraryID = item.libraryID || "default";
        if (!byLibrary.has(libraryID)) {
          byLibrary.set(libraryID, await this.load(libraryID));
        }
        const index = byLibrary.get(libraryID);
        if (!index.items?.[item.id]) {
          missing.push(item);
        }
      }
      if (!missing.length) {
        return { indexed: 0, failures: [] };
      }
      progressCallback?.(`当前视图有 ${missing.length} 篇文献尚未索引，正在补建...`);
      return this.rebuildItems(missing, progressCallback);
    }

    async search(libraryID, query, topK = DEFAULTS.referenceTopK) {
      const index = await this.load(libraryID);
      const queryEmbedding = (await this.client.embed(query))[0];
      const scored = [];

      for (const itemEntry of Object.values(index.items || {})) {
        for (const chunk of itemEntry.chunks || []) {
          const score = cosineSimilarity(queryEmbedding, chunk.embedding);
          if (Number.isFinite(score)) {
            scored.push({
              score,
              itemID: itemEntry.itemID,
              title: itemEntry.title,
              creators: itemEntry.creators,
              year: itemEntry.year,
              text: chunk.text
            });
          }
        }
      }

      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topK * 3);
    }
  }

  class ZoteroAIApp {
    init({ id, version, rootURI }) {
      this.id = id;
      this.version = version;
      this.rootURI = rootURI;
      this.client = new OpenAICompatibleClient();
      this.textSource = new TextSource(this.client);
      this.indexStore = new IndexStore(this.client, this.textSource);
      this.windows = new Set();
      this.menuIDs = [];
      this.runningActions = new Set();
      this.windowObservers = new WeakMap();
      this.readerAnnotationHeaderHandler = null;
      this.readerAnnotationHeaderEventSeen = false;
      this.registerAnnotationHeaderHook();
    }

    async runOnce(key, task) {
      if (this.runningActions.has(key)) {
        Zotero.debug(`Zotero AI Assistant: skipped duplicate action ${key}`);
        throw new Error("操作正在进行中，请稍候再试。");
      }
      this.runningActions.add(key);
      try {
        return await task();
      }
      finally {
        this.runningActions.delete(key);
      }
    }

    addToAllWindows() {
      for (const win of getMainWindows()) {
        this.addToWindow(win);
      }
    }

    removeFromAllWindows() {
      for (const win of Array.from(this.windows)) {
        this.removeFromWindow(win);
      }
      this.unregisterAnnotationHeaderHook();
      this.unregisterContextMenus();
    }

    addToWindow(win) {
      if (!win?.document) {
        return;
      }
      this.windows.add(win);
      this.injectStyles(win);
      this.injectSideNavToolbar(win);
      this.observeWindow(win);
      this.injectContextMenu(win);
      this.injectAnnotationExplainButtonsForWindow(win);
    }

    removeFromWindow(win) {
      const doc = win?.document;
      if (!doc) {
        return;
      }
      for (const currentDoc of getAccessibleDocuments(doc)) {
        currentDoc.getElementById(`${PLUGIN_NS}-toolbar`)?.remove();
        currentDoc.getElementById(`${PLUGIN_NS}-sidenav-toolbar`)?.remove();
        currentDoc.getElementById(`${PLUGIN_NS}-style`)?.remove();
        for (const btn of Array.from(currentDoc.querySelectorAll(`.${PLUGIN_NS}-explain-btn`))) {
          btn.remove();
        }
      }
      doc.getElementById(`${PLUGIN_NS}-context-separator`)?.remove();
      doc.getElementById(`${PLUGIN_NS}-context-read`)?.remove();
      doc.getElementById(`${PLUGIN_NS}-context-search`)?.remove();
      doc.getElementById(`${PLUGIN_NS}-context-answer`)?.remove();
      const observer = this.windowObservers.get(win);
      observer?.disconnect();
      this.windowObservers.delete(win);
      this.windows.delete(win);
    }

    injectStyles(win) {
      this.injectStylesForDocument(win.document);
    }

    injectStylesForDocument(doc) {
      if (doc.getElementById(`${PLUGIN_NS}-style`)) {
        return;
      }
      if (isHTMLDocument(doc)) {
        const link = doc.createElement("link");
        link.id = `${PLUGIN_NS}-style`;
        link.rel = "stylesheet";
        link.href = `${this.rootURI}content/toolbar.css`;
        (doc.head || doc.documentElement).appendChild(link);
        return;
      }
      const pi = doc.createProcessingInstruction(
        "xml-stylesheet",
        `href="${this.rootURI}content/toolbar.css" type="text/css"`
      );
      pi.id = `${PLUGIN_NS}-style`;
      doc.insertBefore(pi, doc.documentElement);
    }

    createActionToolbar(win, id, extraClass = "", doc = win.document) {
      const container = isHTMLDocument(doc) ? doc.createElement("div") : createXULElement(doc, "hbox");
      container.id = id;
      container.className = `zotero-ai-toolbar ${extraClass}`.trim();
      container.setAttribute("align", "center");

      const actions = [
        ["read-paper", "读取论文", "file-text.svg", () => this.handleReadPaper(win)],
        ["find-citation", "查找引用", "search-quote.svg", () => this.openSearchPanel(win)],
        ["answer-note", "回答笔记问题", "message-circle-question.svg", () => this.handleAnswerNote(win)]
      ];
      for (const [name, title, icon, command] of actions) {
        container.appendChild(createIconButton(
          doc,
          `${id}-${name}`,
          title,
          `${this.rootURI}content/icons/${icon}`,
          command
        ));
      }
      return container;
    }

    injectSideNavToolbar(win) {
      const docs = getAccessibleDocuments(win.document);
      const candidates = [];
      for (const doc of docs) {
        for (const selector of SELECTORS.sideNav) {
          try {
            candidates.push(...Array.from(doc.querySelectorAll(selector)));
          }
          catch (err) {
            // Selector support differs between XUL and HTML documents.
          }
        }
      }
      const target = candidates.find((element) =>
        !element.closest?.(`#${PLUGIN_NS}-sidenav-toolbar`)
        && isVisibleElement(element)
      );
      if (!target) {
        this.removeSideNavToolbars(docs);
        return false;
      }

      const existing = target.querySelector?.(`#${PLUGIN_NS}-sidenav-toolbar`);
      if (existing) {
        return true;
      }

      this.removeSideNavToolbars(docs);
      const doc = target.ownerDocument;
      this.injectStylesForDocument(doc);
      const container = this.createActionToolbar(
        win,
        `${PLUGIN_NS}-sidenav-toolbar`,
        "zotero-ai-sidenav-toolbar",
        doc
      );
      target.appendChild(container);
      Zotero.debug(`Zotero AI Assistant: injected sidenav toolbar into ${doc.location?.href || doc.URL || "document"}`);
      return true;
    }

    removeSideNavToolbars(docs = getAccessibleDocuments(this.getMainWindow()?.document)) {
      for (const doc of docs || []) {
        doc.getElementById(`${PLUGIN_NS}-sidenav-toolbar`)?.remove();
      }
    }

    observeWindow(win) {
      const doc = win.document;
      if (this.windowObservers.has(win) || !doc?.documentElement) {
        return;
      }
      let pending = false;
      const retry = () => {
        if (pending) {
          return;
        }
        pending = true;
        win.setTimeout(() => {
          pending = false;
          try {
            this.injectSideNavToolbar(win);
            this.injectAnnotationExplainButtonsForWindow(win);
          }
          catch (err) {
            Zotero.debug(`Zotero AI Assistant: dynamic toolbar injection failed: ${err}`);
          }
        }, 150);
      };
      const observer = new win.MutationObserver(retry);
      observer.observe(doc.documentElement, {
        childList: true,
        subtree: true
      });
      this.windowObservers.set(win, observer);
    }

    injectContextMenu(win) {
      if (Zotero.MenuManager?.registerMenu) {
        this.registerContextMenus();
        return;
      }

      const doc = win.document;
      const menu = doc.getElementById("zotero-itemmenu");
      if (!menu || doc.getElementById(`${PLUGIN_NS}-context-read`)) {
        return;
      }

      const separator = createXULElement(doc, "menuseparator");
      separator.id = `${PLUGIN_NS}-context-separator`;
      menu.appendChild(separator);

      const items = [
        ["context-read", "AI 读取论文", () => this.handleReadPaper(win)],
        ["context-search", "AI 查找引用", () => this.openSearchPanel(win)],
        ["context-answer", "AI 回答笔记问题", () => this.handleAnswerNote(win)]
      ];
      for (const [id, label, command] of items) {
        const menuItem = createXULElement(doc, "menuitem");
        menuItem.id = `${PLUGIN_NS}-${id}`;
        menuItem.setAttribute("label", label);
        menuItem.addEventListener("command", command);
        menu.appendChild(menuItem);
      }
    }

    registerContextMenus() {
      if (this.menuIDs.length) {
        return;
      }

      const entries = [
        {
          menuID: "item",
          label: "AI 读取论文",
          command: "read"
        },
        {
          menuID: "item",
          label: "AI 查找引用",
          command: "search"
        },
        {
          menuID: "item",
          label: "AI 回答笔记问题",
          command: "answer"
        }
      ];

      for (const entry of entries) {
        try {
          const id = Zotero.MenuManager.registerMenu({
            menuID: entry.menuID,
            pluginID: this.id,
            label: entry.label,
            command: () => {
              const win = this.getMainWindow();
              if (!win) {
                return;
              }
              if (entry.command === "read") {
                this.handleReadPaper(win);
              }
              else if (entry.command === "search") {
                this.openSearchPanel(win);
              }
              else {
                this.handleAnswerNote(win);
              }
            }
          });
          if (id) {
            this.menuIDs.push(id);
          }
        }
        catch (err) {
          Zotero.debug(`Zotero AI Assistant: MenuManager register failed: ${err}`);
        }
      }
    }

    unregisterContextMenus() {
      if (!this.menuIDs.length || !Zotero.MenuManager?.unregisterMenu) {
        this.menuIDs = [];
        return;
      }
      for (const id of this.menuIDs) {
        try {
          Zotero.MenuManager.unregisterMenu(id);
        }
        catch (err) {
          Zotero.debug(`Zotero AI Assistant: MenuManager unregister failed: ${err}`);
        }
      }
      this.menuIDs = [];
    }

    async getActionRegularItem(win) {
      // If the active tab is a PDF reader, process the article open there.
      // getActiveReader() only matches by tab ID, so this correctly returns
      // null when the library/items view is the active tab.
      const readerItem = await getReaderRegularItem(win);
      if (readerItem) {
        return readerItem;
      }
      // Active tab is the library view — use the selected item.
      return getSelectedRegularItems(win)[0] || null;
    }

    async getActionNote(win) {
      const editorNote = await getEditorNoteItem(win);
      if (editorNote) {
        return editorNote;
      }
      return getSelectedNote(win);
    }

    async handleReadPaper(win) {
      return this.runOnce("read-paper", async () => {
      const progress = this.createProgressHandle(win, "正在准备读取论文...");
      try {
        const item = await this.getActionRegularItem(win);
        if (!item) {
          progress.close();
          alertUser(win, "Zotero AI", "请先选中一篇带 PDF 的文献。");
          return;
        }
        const titleDisplay = truncateTitle(getItemTitle(item), 40);
        progress.update(`正在读取文献: ${titleDisplay}`);
        const { text, source, pages } = await this.textSource.getTextForItem(item);
        const modelLabel = modelLabelFromID(this.client.chatModel);
        progress.update(`${modelLabel} 正在生成笔记 · ${titleDisplay}`);
        const summary = await this.summarizePaperV2(item, text, source, pages);
        progress.update(`正在保存笔记 · ${titleDisplay}`);
        await this.createChildNote(item, summary);
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: read paper failed: ${err}\n${err.stack}`);
        progress.close();
        alertUser(win, "论文读取失败", err.message || String(err));
      }
      finally {
        progress.close();
      }
      });
    }

    async summarizePaper(item, text, source) {
      const summaryInput = getSummaryInput(text, []);
      const chunks = getSummaryChunks(summaryInput.text);
      const context = chunks
        .map((chunk, index) => `【片段 ${index + 1}】\n${chunk}`)
        .join("\n\n");

      const answer = await this.client.chat([
        {
          role: "system",
          content: "你是严谨的中文学术阅读助手。只能根据用户提供的论文文本总结，不要编造。输出清晰的中文结构化笔记。你的回答务必完整，列出所有要点之后再停止。" + MATH_OUTPUT_INSTRUCTIONS
        },
        {
          role: "user",
          content: [
            `论文标题: ${getItemTitle(item)}`,
            `作者: ${getCreators(item) || "未知"}`,
            `文本来源: ${source}`,
            "",
            "请生成中文论文阅读笔记，包含:",
            "1. 研究问题",
            "2. 核心方法",
            "3. 数据/实验/案例",
            "4. 主要发现",
            "5. 可引用观点",
            "6. 局限与可追问问题",
            "",
            context
          ].join("\n")
        }
      ], {
        temperature: 0.2
      });

      return `# AI 论文阅读笔记\n\n${answer}`;
    }

    async summarizePaperV2(item, text, source, pages = []) {
      const summaryInput = getSummaryInput(text, pages);
      const chunks = getSummaryChunks(summaryInput.text);
      const context = chunks
        .map((chunk, index) => `【片段 ${index + 1}】\n${chunk}`)
        .join("\n\n");
      const publication = item.getField?.("publicationTitle") || item.getField?.("proceedingsTitle") || "";
      const date = item.getField?.("date") || item.getField?.("year") || "";

      const answer = await this.client.chat([
        {
          role: "system",
          content: "你是严谨的中文学术阅读助手。只能根据用户提供的论文文本总结，不要编造。输出 Markdown，但不要输出开场套话，不要以“这是一份...”开头，不要在最前面输出横线。你的回答务必完整，不要遗漏任何细节。" + MATH_OUTPUT_INSTRUCTIONS
        },
        {
          role: "user",
          content: [
            `论文标题: ${getItemTitle(item)}`,
            `作者: ${getCreators(item) || "未知"}`,
            `发表来源: ${publication || "未知"}`,
            `日期: ${date || "未知"}`,
            `文本来源: ${source}`,
            `摘要读取范围: ${summaryInput.range}`,
            `摘要实际片段数: ${chunks.length}`,
            "",
            "请生成中文结构化论文阅读笔记，格式必须严格如下：",
            "",
            "第一部分：先用3个非常简练利落的句子，概括论文的主要贡献，这个贡献可以根据文章的内容，写出其方法、知识、应用等方面的贡献，不同的文章可能贡献的侧重点有所不同。不要超过三段。不要写标题。不要写“这是一份...”。",
            "",
            "第二部分：接着写：",
            "# 论文阅读笔记：{用中文概括的论文标题}",
            "**原标题**: {英文原标题}",
            "**作者**: {作者}",
            "**发表期刊**: {发表来源和年份，如果无法判断就写未知}",
            "",
            "---",
            "",
            "### 1. 研究问题",
            "### 2. 核心方法",
            "### 3. 数据/实验/案例",
            "### 4. 主要发现",
            "### 5. 可引用观点",
            "### 6. 局限与可追问问题",
            "",
            "各节内部使用 Markdown 列表和 **粗体关键词**。不要把模型型号写进正文。",
            "",
            context
          ].join("\n")
        }
      ], {
        temperature: 0.2
      });

      const label = modelLabelFromID(this.client.chatModel);
      return `(${label}) ${cleanSummaryMarkdown(answer)}`;
    }

    async createChildNote(parentItem, markdownishText) {
      const note = new Zotero.Item("note");
      note.libraryID = parentItem.libraryID;
      note.parentID = parentItem.id;
      note.setNote(markdownToNoteHTML(markdownishText));
      await note.saveTx();
      return note;
    }

    openSearchPanel(win) {
      if (this.runningActions.has("open-search-panel")) {
        return null;
      }
      this.runningActions.add("open-search-panel");
      const progress = this.createProgressHandle(win, "正在打开查找引用面板...");
      const features = "chrome,centerscreen,resizable,width=920,height=720";
      const url = "chrome://zoteroai/content/search.html";
      let dialog = null;
      try {
        dialog = win.openDialog(url, "zotero-ai-search", features, {
          app: this,
          opener: win
        });
        dialog?.addEventListener?.("load", () => progress.close(), { once: true });
        win.setTimeout(() => progress.close(), 1500);
      }
      catch (err) {
        progress.close();
        throw err;
      }
      finally {
        win.setTimeout(() => this.runningActions.delete("open-search-panel"), 500);
      }
      return dialog;
    }

    openSearchPanelFromAnyWindow() {
      const win = this.getMainWindow();
      if (!win) {
        throw new Error("没有找到 Zotero 主窗口。");
      }
      this.openSearchPanel(win);
    }

    getMainWindow() {
      for (const win of this.windows) {
        if (win?.ZoteroPane) {
          return win;
        }
      }
      return getMainWindows()[0] || null;
    }

    async getCurrentLibraryID(win) {
      try {
        const collectionTreeRow = win.ZoteroPane.collectionsView?.selection?.focused;
        const row = collectionTreeRow != null ? win.ZoteroPane.collectionsView.getRow(collectionTreeRow) : null;
        if (row?.ref?.libraryID) {
          return row.ref.libraryID;
        }
      }
      catch (err) {
        // Fall through to user library.
      }
      return Zotero.Libraries.userLibraryID;
    }

    async getVisibleRegularItems(win) {
      try {
        const items = win.ZoteroPane.getSortedItems?.() || win.ZoteroPane.itemsView?.getSortedItems?.() || [];
        const resolved = [];
        for (const candidate of items) {
          const item = typeof candidate === "number" ? await Zotero.Items.getAsync(candidate) : candidate;
          if (isRegularItem(item)) {
            resolved.push(item);
          }
        }
        if (resolved.length) {
          return resolved;
        }
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: failed to read visible items: ${err}`);
      }

      const libraryID = await this.getCurrentLibraryID(win);
      const itemIDs = await Zotero.Items.getAll(libraryID, true);
      const items = [];
      for (const id of itemIDs) {
        const item = await Zotero.Items.getAsync(id);
        if (isRegularItem(item)) {
          items.push(item);
        }
      }
      return items;
    }

    async rebuildIndexForVisibleItems(win, progressCallback, chunkOptions = {}) {
      return this.runOnce("rebuild-index", async () => {
      // 提前校验：确保已填写 API Key
      this.client.ensureConfigured("embedding");

      const items = await this.getVisibleRegularItems(win);
      if (!items.length) {
        throw new Error("当前视图没有可索引的文献。");
      }
      const result = await this.indexStore.rebuildItems(items, progressCallback, chunkOptions);
      return {
        total: items.length,
        indexed: result.indexed,
        failures: result.failures
      };
      });
    }

    async rebuildIndexFromAnyWindow(progressCallback) {
      const win = this.getMainWindow();
      if (!win) {
        throw new Error("没有找到 Zotero 主窗口。");
      }
      return this.rebuildIndexForVisibleItems(win, progressCallback);
    }

    async searchReferences(win, query, progressCallback) {
      return this.runOnce("search-references", async () => {
      // 提前校验：确保已填写 API Key
      this.client.ensureConfigured("embedding");
      this.client.ensureConfigured("text");

      const normalizedQuery = normalizeText(query);
      if (!normalizedQuery) {
        throw new Error("请输入一句想法或论点。");
      }

      const libraryID = await this.getCurrentLibraryID(win);
      progressCallback?.("正在进行语义召回...");
      let candidates = await this.indexStore.search(
        libraryID,
        normalizedQuery,
        Number(pref("referenceTopK", DEFAULTS.referenceTopK))
      );

      if (!candidates.length) {
        const reason = this.indexStore._modelChangedOnLoad
          ? "检测到 Embedding 模型已变更，原有索引已自动清除。\n是否立即用新模型重建当前视图的索引？"
          : "当前文献库还没有可用向量索引。是否现在为当前视图中的文献建立索引？";
        const shouldBuild = confirmUser(win, "Zotero AI", reason);
        if (!shouldBuild) {
          return [];
        }
        await this.rebuildIndexForVisibleItems(win, progressCallback);
        candidates = await this.indexStore.search(
          libraryID,
          normalizedQuery,
          Number(pref("referenceTopK", DEFAULTS.referenceTopK))
        );
      }

      progressCallback?.("正在用聊天模型重排并提取摘录...");
      return this.rerankReferences(normalizedQuery, candidates.slice(0, 12));
      });
    }

    async rerankReferences(query, candidates) {
      if (!candidates.length) {
        return [];
      }

      const compact = candidates.map((candidate, index) => ({
        id: index + 1,
        title: candidate.title,
        creators: candidate.creators,
        year: candidate.year,
        score: Number(candidate.score.toFixed(4)),
        excerpt: candidate.text.slice(0, 1100)
      }));

      const response = await this.client.chat([
        {
          role: "system",
          content: "你是中文学术检索助手。你会根据用户想法，从候选论文片段中挑选最适合引用的文献。必须只基于候选片段，不要编造。你的回答务必完整，不要遗漏任何细节。"
        },
        {
          role: "user",
          content: [
            `用户想法: ${query}`,
            "",
            "请从候选片段中选择最适合引用的 5 条以内结果。返回 JSON 数组，不要包含 Markdown。",
            "每项包含 id, reason, quote。",
            "reason 中如需写数学公式，行内使用 $...$，独立公式使用 $$...$$。",
            "quote 必须是候选 excerpt 中真实存在的典型原文摘录，尽量短而完整。",
            "",
            JSON.stringify(compact, null, 2)
          ].join("\n")
        }
      ], {
        temperature: 0
      });

      let ranked = [];
      try {
        ranked = extractJSONArray(response);
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: rerank parse failed, falling back: ${err}`);
      }

      if (!Array.isArray(ranked) || !ranked.length) {
        return candidates.slice(0, 5).map((candidate) => ({
          ...candidate,
          reason: "语义相似度较高，建议人工复核。",
          quote: candidate.text.slice(0, 360)
        }));
      }

      return ranked
        .map((entry) => {
          const candidate = candidates[(Number(entry.id) || 0) - 1];
          if (!candidate) {
            return null;
          }
          return {
            ...candidate,
            reason: normalizeMathDelimiters(entry.reason || "与输入想法相关。"),
            quote: entry.quote || candidate.text.slice(0, 360)
          };
        })
        .filter(Boolean);
    }

    async handleAnswerNote(win) {
      return this.runOnce("answer-note", async () => {
      const progress = this.createProgressHandle(win, "正在准备回答笔记问题...");
      try {
        const note = await this.getActionNote(win);
        if (!note) {
          progress.close();
          alertUser(win, "Zotero AI", "请先选中一条 Zotero 笔记。");
          return;
        }
        progress.update("正在读取笔记中的最新问题...");
        const answer = await this.answerLatestQuestion(note);
        progress.update("正在把回答追加到 Zotero 笔记...");
        await this.appendAnswerToNote(note, answer);
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: answer note failed: ${err}\n${err.stack}`);
        progress.close();
        alertUser(win, "笔记问答失败", err.message || String(err));
      }
      finally {
        progress.close();
      }
      });
    }

    extractLatestUnansweredQuestion(noteText) {
      const plain = stripHTML(noteText);
      const markers = Array.from(plain.matchAll(/(?:^|\n)\s*(Q|问题|Answer|回答)\s*[:：]/gi))
        .map((match) => ({
          type: /^(Q|问题)$/i.test(match[1]) ? "question" : "answer",
          index: match.index || 0,
          end: (match.index || 0) + match[0].length
        }));

      for (let i = markers.length - 1; i >= 0; i--) {
        const marker = markers[i];
        if (marker.type !== "question") {
          continue;
        }
        const next = markers[i + 1];
        if (next?.type === "answer") {
          throw new Error("最新问题已经有回答。请在笔记末尾继续写新的 `Q: 问题`。");
        }
        const question = normalizeText(plain.slice(marker.end, next?.index || plain.length));
        if (!question) {
          throw new Error("最新的 `Q:` 后面没有问题内容。");
        }
        return question;
      }

      throw new Error("没有找到 `Q: 问题` 或 `问题: ...` 格式的未回答问题。");
    }

    extractLatestUnansweredQuestionV2(noteText) {
      const plain = stripHTML(noteText);
      const markerRE = /(?:^|\n)\s*(Q|Question|\u95ee\u9898|Answer|\u56de\u7b54)\s*[:：]/gi;
      const markers = Array.from(plain.matchAll(markerRE)).map((match) => ({
        type: /^(Q|Question|\u95ee\u9898)$/i.test(match[1]) ? "question" : "answer",
        index: match.index || 0,
        end: (match.index || 0) + match[0].length
      }));

      for (let i = markers.length - 1; i >= 0; i--) {
        const marker = markers[i];
        if (marker.type !== "question") {
          continue;
        }
        const next = markers[i + 1];
        if (next?.type === "answer") {
          throw new Error("最新问题已经有回答。请在笔记末尾继续写新的 `Q: 问题`。");
        }
        const question = normalizeText(plain.slice(marker.end, next?.index || plain.length));
        if (!question) {
          throw new Error("最新的 `Q:` 后面没有问题内容。");
        }
        return question;
      }

      throw new Error("没有找到 `Q: 问题` 或 `问题: ...` 格式的未回答问题。");
    }

    async answerLatestQuestion(note) {
      const html = note.getNote();
      const question = this.extractLatestUnansweredQuestionV2(html);
      const paperSections = [];
      const noteSections = [];

      const parent = note.parentID ? await Zotero.Items.getAsync(note.parentID) : null;
      if (parent) {
        try {
          const { text } = await this.textSource.getTextForItem(parent);
          const paperText = normalizeText(text);
          if (paperText) {
            paperSections.push(`【论文正文全文】\n${paperText}`);
          }
        }
        catch (err) {
          Zotero.debug(`Zotero AI Assistant: parent PDF context unavailable: ${err}`);
        }

        const childNotes = await this.getChildNoteContexts(parent, note.id);
        if (childNotes) {
          noteSections.push(`【关联论文摘要/笔记】\n${childNotes}`);
        }
      }

      const conversation = stripHTML(html);
      if (conversation) {
        noteSections.push(`【当前 Zotero Note】\n${conversation}`);
      }

      const combinedContext = [
        paperSections.join("\n\n") || "【论文正文全文】\n没有可用的 PDF 正文全文。",
        noteSections.join("\n\n") || "【Zotero Note】\n没有可用的笔记上下文。",
        `【最新问题】\n${question}`
      ].join("\n\n");
      return this.client.chat([
        {
          role: "system",
          content: "你是中文论文阅读问答助手。回答必须优先基于 PDF 正文全文、当前笔记和关联论文摘要。证据不足时明确说明，不要编造。你的回答应该尽量完整，不遗漏任何可能与问题相关的细节，输出完整的答案。" + MATH_OUTPUT_INSTRUCTIONS
        },
        {
          role: "user",
          content: combinedContext
        }
      ], {
        temperature: 0.2
      });
    }

    async getChildNoteContexts(parentItem, currentNoteID) {
      let noteIDs = [];
      try {
        noteIDs = await parentItem.getNotes();
      }
      catch (err) {
        return "";
      }

      const notes = [];
      for (const noteID of noteIDs) {
        if (noteID === currentNoteID) {
          continue;
        }
        const note = await Zotero.Items.getAsync(noteID);
        if (note?.isNote?.()) {
          const text = stripHTML(note.getNote()).slice(0, 4000);
          if (text) {
            notes.push(text);
          }
        }
      }
      return notes.slice(0, 3).join("\n\n");
    }

    async appendAnswerToNote(note, answer) {
      const html = note.getNote();
      const appendHTML = `\n<h3>Answer:</h3>\n${markdownToNoteHTML(cleanMarkdown(answer))}`;
      note.setNote(html + appendHTML);
      await note.saveTx();
    }

    // Iterate all accessible documents in a window and inject sparkle buttons.
    injectAnnotationExplainButtonsForWindow(win) {
      if (!win?.document) {
        return;
      }
      this.registerAnnotationHeaderHook();
      for (const doc of getAccessibleDocuments(win.document)) {
        if (isHTMLDocument(doc)) {
          try {
            this.injectAnnotationExplainButtons(doc);
          }
          catch (err) {
            Zotero.debug(`Zotero AI Assistant: annotation button injection failed: ${err}`);
          }
        }
      }
    }

    registerAnnotationHeaderHook() {
      if (this.readerAnnotationHeaderHandler) {
        return;
      }
      if (!Zotero.Reader?.registerEventListener) {
        Zotero.debug("Zotero AI Assistant: Zotero.Reader is not ready; retrying Reader hook after uiReadyPromise");
        Promise.all([Zotero.initializationPromise, Zotero.uiReadyPromise])
          .then(() => this.registerAnnotationHeaderHook())
          .catch((err) => Zotero.debug(`Zotero AI Assistant: Reader hook retry failed: ${err}`));
        return;
      }
      this.readerAnnotationHeaderHandler = (event) => {
        try {
          if (!this.readerAnnotationHeaderEventSeen) {
            this.readerAnnotationHeaderEventSeen = true;
            Zotero.debug("Zotero AI Assistant: renderSidebarAnnotationHeader fired");
          }
          this.injectAnnotationHeaderExplainButton(event);
        }
        catch (err) {
          Zotero.debug(`Zotero AI Assistant: sidebar annotation header hook failed: ${err}`);
        }
      };
      try {
        Zotero.Reader.registerEventListener(
          "renderSidebarAnnotationHeader",
          this.readerAnnotationHeaderHandler,
          this.id
        );
        Zotero.debug("Zotero AI Assistant: registered sidebar annotation header hook");
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: failed to register sidebar annotation header hook: ${err}`);
        this.readerAnnotationHeaderHandler = null;
      }
    }

    unregisterAnnotationHeaderHook() {
      if (!this.readerAnnotationHeaderHandler) {
        return;
      }
      try {
        Zotero.Reader?.unregisterEventListener?.(
          "renderSidebarAnnotationHeader",
          this.readerAnnotationHeaderHandler
        );
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: failed to unregister sidebar annotation header hook: ${err}`);
      }
      this.readerAnnotationHeaderHandler = null;
      this.readerAnnotationHeaderEventSeen = false;
    }

    injectAnnotationHeaderExplainButton(event) {
      const { reader, doc, params, append } = event || {};
      const annotation = params?.annotation;
      if (!annotation || typeof append !== "function" || !doc) {
        return;
      }
      const annotationRef = annotation.key || annotation.id;
      if (!annotationRef) {
        return;
      }
      this.injectStylesForDocument(doc);
      const libraryID = annotation.libraryID || reader?._item?.libraryID;
      append(this.createAnnotationHeaderExplainButton(doc, annotationRef, libraryID));
    }

    createAnnotationHeaderExplainButton(doc, annotationRef, libraryID) {
      const btn = doc.createElement("button");
      btn.className = `${PLUGIN_NS}-explain-btn ${PLUGIN_NS}-explain-header-btn`;
      btn.type = "button";
      btn.title = "AI 解释图表/公式";
      btn.setAttribute("tabindex", "0");
      btn.setAttribute("aria-label", "AI 解释图表/公式");
      const ico = doc.createElement("img");
      ico.src = `${this.rootURI}content/icons/sparkle.svg`;
      ico.alt = "";
      btn.appendChild(ico);
      const run = (event) => {
        event.stopPropagation();
        event.preventDefault();
        this.handleExplainAnnotation(annotationRef, this.getMainWindow(), libraryID);
      };
      btn.addEventListener("click", run);
      btn.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          run(event);
        }
      });
      return btn;
    }

    // Inject sparkle explain buttons on image annotation cards in the PDF reader sidebar.
    // Tries multiple attribute selectors to handle different Zotero versions.
    injectAnnotationExplainButtons(doc) {
      if (!doc || !isHTMLDocument(doc)) {
        return;
      }
      const CARD_SELECTORS = [
        "[data-sidebar-annotation-id]",
        "[data-annotation-id]",
        ".annotation"
      ];
      for (const selector of CARD_SELECTORS) {
        let cards;
        try {
          cards = Array.from(doc.querySelectorAll(selector));
        }
        catch (err) {
          continue;
        }
        let injected = 0;
        for (const card of cards) {
          if (card.querySelector(`.${PLUGIN_NS}-explain-btn`)) {
            continue;
          }
          if (!card.querySelector("img")) {
            continue;
          }
          const key =
            card.dataset?.sidebarAnnotationId ||
            card.dataset?.annotationId ||
            card.dataset?.key ||
            card.dataset?.id ||
            card.closest?.("[data-sidebar-annotation-id]")?.dataset?.sidebarAnnotationId;
          if (!key) {
            continue;
          }
          this._injectExplainButton(card, key, doc);
          injected++;
        }
        if (injected > 0) {
          Zotero.debug(`Zotero AI Assistant: injected ${injected} annotation explain btn(s) via "${selector}"`);
          break;
        }
      }
    }

    _injectExplainButton(card, annotationKey, doc) {
      const btn = doc.createElement("button");
      btn.className = `${PLUGIN_NS}-explain-btn`;
      btn.title = "AI 解释此图表/公式";
      const ico = doc.createElement("img");
      ico.src = `${this.rootURI}content/icons/sparkle.svg`;
      ico.width = 14;
      ico.height = 14;
      ico.alt = "✨";
      btn.appendChild(ico);
      btn.style.cssText = [
        "position:absolute", "top:4px", "right:32px", "z-index:10",
        "background:rgba(255,255,255,0.85)", "border:1px solid rgba(0,0,0,0.15)",
        "border-radius:3px", "cursor:pointer", "padding:2px 3px", "line-height:1"
      ].join(";");
      const view = doc.defaultView || card.ownerGlobal;
      if (!view?.getComputedStyle || view.getComputedStyle(card).position === "static") {
        card.style.position = "relative";
      }
      const mainWin = this.getMainWindow();
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.handleExplainAnnotation(annotationKey, mainWin);
      });
      card.appendChild(btn);
    }

    async getAnnotationImageBase64(annotation) {
      let imagePath = null;
      try {
        if (typeof Zotero.Annotations?.getCacheImagePath === "function") {
          imagePath = await Zotero.Annotations.getCacheImagePath(annotation);
        }
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: getCacheImagePath failed: ${err}`);
      }
      if (!imagePath) {
        const dataDir = Zotero.DataDirectory.dir;
        imagePath = PathUtils.join(dataDir, "cache", String(annotation.libraryID), `${annotation.key}.png`);
      }
      let data;
      try {
        data = await IOUtils.read(imagePath);
      }
      catch (err) {
        throw new Error(`无法读取注释图像（${imagePath}）：${err.message}`);
      }
      const bytes = new Uint8Array(data);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    }

    async getAnnotationPageTexts(attachment, pageIndex) {
      const result = await Zotero.PDFWorker.getFullText(attachment.id, null);
      const fullText = result?.text || "";
      const pageCharRanges = result?.pageCharRanges;
      let pages;
      if (Array.isArray(pageCharRanges) && pageCharRanges.length > 0) {
        pages = pageCharRanges.map(([start, end], i) => ({ index: i, text: fullText.slice(start, end) }));
      }
      else if (Array.isArray(result?.pages)) {
        pages = result.pages.map((text, i) => ({ index: i, text: text || "" }));
      }
      else {
        pages = [{ index: 0, text: fullText }];
      }
      const totalPages = pages.length;
      const low = Math.max(0, pageIndex - 2);
      const high = Math.min(totalPages - 1, pageIndex + 2);
      const included = new Set([0]);
      for (let i = low; i <= high; i++) {
        included.add(i);
      }
      return Array.from(included)
        .sort((a, b) => a - b)
        .map((i) => {
          const t = normalizeText(pages[i]?.text || "");
          return t ? `【第${i + 1} 页】\n${t}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
    }

    async resolveAnnotation(annotationRef, libraryID) {
      if (annotationRef?.isAnnotation?.()) {
        return annotationRef;
      }
      const raw = String(annotationRef || "").trim();
      if (!raw) {
        return null;
      }
      if (/^\d+$/.test(raw)) {
        const item = await Zotero.Items.getAsync(Number(raw));
        return item?.isAnnotation?.() ? item : null;
      }
      if (libraryID) {
        const item = Zotero.Items.getByLibraryAndKey(Number(libraryID), raw);
        if (item?.isAnnotation?.()) {
          return item;
        }
      }
      for (const library of Zotero.Libraries.getAll()) {
        const item = Zotero.Items.getByLibraryAndKey(library.libraryID, raw);
        if (item?.isAnnotation?.()) {
          return item;
        }
      }
      return null;
    }

    async handleExplainAnnotation(annotationRef, win, libraryID) {
      return this.runOnce(`explain-annotation-${libraryID || ""}-${annotationRef}`, async () => {
        const progress = this.createProgressHandle(win, "正在准备解释图表/公式...");
        try {
          const annotation = await this.resolveAnnotation(annotationRef, libraryID);
          if (!annotation) {
            throw new Error("找不到该注释，请确认注释仍存在。");
          }
          const attachment = annotation.parentID
            ? await Zotero.Items.getAsync(annotation.parentID)
            : null;
          if (!attachment) {
            throw new Error("找不到注释所属的 PDF 附件。");
          }
          progress.update("正在读取注释图像...");
          const imageBase64 = await this.getAnnotationImageBase64(annotation);
          progress.update("正在提取上下文页面文字...");
          let textContext = "";
          try {
            const pos = JSON.parse(annotation.annotationPosition || "{}");
            const pageIndex = typeof pos.pageIndex === "number" ? pos.pageIndex : 0;
            textContext = await this.getAnnotationPageTexts(attachment, pageIndex);
          }
          catch (err) {
            Zotero.debug(`Zotero AI Assistant: page text extraction skipped: ${err}`);
          }
          const comment = annotation.annotationComment || "";
          const { question, hasUnanswered } = parseAnnotationComment(comment);
          const modelLabel = modelLabelFromID(this.client.multimodalModel);
          progress.update(`正在调用 ${modelLabel} 解释图表...`);
          const answer = await this.client.explainWithVision(imageBase64, textContext, question);
          progress.update("正在写入注释评论...");
          const normalizedAnswer = normalizeMathDelimiters(answer.trim());
          const answerBlock = hasUnanswered
            ? `A: (${modelLabel}) ${normalizedAnswer}`
            : `(${modelLabel}) ${normalizedAnswer}`;
          annotation.annotationComment = comment.trimEnd()
            ? `${comment.trimEnd()}\n\n${answerBlock}`
            : answerBlock;
          await annotation.saveTx();
        }
        catch (err) {
          Zotero.debug(`Zotero AI Assistant: explainAnnotation failed: ${err}\n${err.stack}`);
          progress.close();
          alertUser(win, "图表/公式解释失败", err.message || String(err));
          return;
        }
        finally {
          progress.close();
        }
      });
    }

    createProgressHandle(win, message) {
      let progressWin = null;
      let line = null;
      let closed = false;
      let lastMessage = message || "正在处理...";

      try {
        progressWin = new Zotero.ProgressWindow({
          window: win,
          closeOnClick: false
        });
        progressWin.changeHeadline("Zotero AI");
        line = new progressWin.ItemProgress("document", lastMessage);
        line.setProgress(50);
        progressWin.show();
      }
      catch (err) {
        Zotero.debug(`Zotero AI Assistant: progress window failed: ${err}`);
      }

      return {
        update(nextMessage) {
          lastMessage = nextMessage || lastMessage;
          Zotero.debug(`Zotero AI Assistant: ${lastMessage}`);
          try {
            line?.setText(lastMessage);
            line?.setProgress(50);
          }
          catch (err) {
            // Ignore progress UI failures; the task itself should continue.
          }
        },
        close() {
          if (closed) {
            return;
          }
          closed = true;
          try {
            line?.setProgress(100);
            progressWin?.close();
          }
          catch (err) {
            // Ignore progress UI close failures.
          }
        }
      };
    }

  }

  const isNodeTest = typeof process === "object" && process?.versions?.node;
  if (isNodeTest && typeof module === "object" && module.exports) {
    module.exports = {
      markdownToNoteHTML,
      normalizeMathDelimiters,
      normalizeAPIBaseURL
    };
  }
  else {
    this.ZoteroAI = new ZoteroAIApp();
  }
}).call(this);
