(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
  const {
    DEFAULTS,
    SELECTORS,
    PLUGIN_NS,
    pref,
    normalizeText,
    stripHTML,
    textToNoteHTML,
    markdownToNoteHTML,
    normalizeMathDelimiters,
    modelLabelFromID,
    cleanSummaryMarkdown,
    cleanMarkdown,
    extractJSONArray,
    parseAnnotationComment,
    isRegularItem,
    isNoteItem,
    getSelectedRegularItems,
    getSelectedNote,
    alertUser,
    confirmUser,
    findFirstElement,
    getMainWindows,
    createIconButton,
    getAccessibleDocuments,
    isHTMLDocument,
    isVisibleElement,
    createXULElement,
    getReaderRegularItem,
    getEditorNoteItem,
    getItemTitle,
    truncateTitle,
    getCreators,
    getSummaryInput,
    getSummaryChunks,
    OpenAICompatibleClient,
    TextSource,
    IndexStore,
    buildPaperSummaryMessages,
    buildPaperSummaryV2Messages,
    buildReferenceRerankMessages,
    buildNoteQAMessages
  } = ns;

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
      this.annotationDocObservers = new WeakMap();
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
        const annotationObserver = this.annotationDocObservers.get(currentDoc);
        annotationObserver?.disconnect();
        this.annotationDocObservers.delete(currentDoc);
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

      const answer = await this.client.chat(buildPaperSummaryMessages({
        title: getItemTitle(item),
        creators: getCreators(item),
        source,
        context
      }), {
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

      const answer = await this.client.chat(buildPaperSummaryV2Messages({
        title: getItemTitle(item),
        creators: getCreators(item),
        publication,
        date,
        source,
        summaryRange: summaryInput.range,
        chunkCount: chunks.length,
        context
      }), {
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

      const response = await this.client.chat(buildReferenceRerankMessages({
        query,
        compact
      }), {
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
      return this.client.chat(buildNoteQAMessages(combinedContext), {
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
            this.observeAnnotationDocument(win, doc);
            this.injectAnnotationExplainButtons(doc);
          }
          catch (err) {
            Zotero.debug(`Zotero AI Assistant: annotation button injection failed: ${err}`);
          }
        }
      }
    }

    observeAnnotationDocument(win, doc) {
      if (!doc?.documentElement || this.annotationDocObservers.has(doc)) {
        return;
      }
      const view = doc.defaultView || win;
      if (!view?.MutationObserver) {
        return;
      }
      let pending = false;
      const retry = () => {
        if (pending) {
          return;
        }
        pending = true;
        view.setTimeout(() => {
          pending = false;
          try {
            this.injectAnnotationExplainButtons(doc);
          }
          catch (err) {
            Zotero.debug(`Zotero AI Assistant: annotation document injection failed: ${err}`);
          }
        }, 150);
      };
      const observer = new view.MutationObserver(retry);
      observer.observe(doc.documentElement, {
        childList: true,
        subtree: true
      });
      this.annotationDocObservers.set(doc, observer);
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
          if (!this.annotationCardHasImage(card)) {
            continue;
          }
          const key = this.getAnnotationCardKey(card);
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

    annotationCardHasImage(card) {
      if (card.querySelector?.("img, canvas, svg")) {
        return true;
      }
      const view = card.ownerDocument?.defaultView;
      try {
        const background = view?.getComputedStyle?.(card)?.backgroundImage || "";
        return background && background !== "none";
      }
      catch (err) {
        return false;
      }
    }

    getAnnotationCardKey(card) {
      const withKey = card.closest?.("[data-sidebar-annotation-id], [data-annotation-id], [data-key], [data-id]")
        || card.querySelector?.("[data-sidebar-annotation-id], [data-annotation-id], [data-key], [data-id]");
      return card.dataset?.sidebarAnnotationId
        || card.dataset?.annotationId
        || card.dataset?.key
        || card.dataset?.id
        || withKey?.dataset?.sidebarAnnotationId
        || withKey?.dataset?.annotationId
        || withKey?.dataset?.key
        || withKey?.dataset?.id
        || "";
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

  ns.ZoteroAIApp = ZoteroAIApp;
  root.ZoteroAIApp = ZoteroAIApp;
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
