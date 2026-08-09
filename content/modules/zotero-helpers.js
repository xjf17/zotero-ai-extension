(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
  const { normalizeText } = ns;

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

  Object.assign(ns, {
    isRegularItem,
    isNoteItem,
    getSelectedItems,
    getSelectedRegularItems,
    getSelectedNote,
    alertUser,
    confirmUser,
    findFirstElement,
    createXULElement,
    isHTMLDocument,
    getMainWindows,
    createIconButton,
    getAccessibleDocuments,
    isVisibleElement,
    getActiveReader,
    getReaderAttachmentID,
    getParentRegularItem,
    getReaderRegularItem,
    getNoteEditors,
    getActiveNoteEditor,
    getEditorNoteItem,
    getItemTitle,
    truncateTitle,
    getCreators
  });
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
