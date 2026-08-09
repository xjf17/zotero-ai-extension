(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
  const {
    DEFAULTS,
    pref,
    normalizeText,
    normalizePositiveInt,
    chunkText,
    getItemTitle
  } = ns;

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

  Object.assign(ns, {
    getBestAttachment,
    getAttachmentPath,
    readTextFile,
    getFulltextCacheText,
    extractPDFTextWithZoteroWorker,
    indexAttachmentAndReadCache,
    normalizePageText,
    getIndexedAttachmentPages,
    getIndexedAttachmentText,
    getSummaryInput,
    getSummaryChunks,
    readFileAsBase64,
    TextSource
  });
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
