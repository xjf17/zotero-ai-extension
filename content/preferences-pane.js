/* global document, window, Zotero */
(function () {
  const BRANCH = "extensions.zotero-ai.";
  let initialized = false;

  function $(id) {
    return document.getElementById(id);
  }

  function pref(key, fallback = "") {
    const value = Zotero.Prefs.get(BRANCH + key, true);
    return value === undefined || value === null ? fallback : value;
  }

  function setPref(key, value) {
    Zotero.Prefs.set(BRANCH + key, value, true);
  }

  function getValue(id) {
    const element = $(id);
    return element ? element.value : "";
  }

  function setValue(id, value) {
    const element = $(id);
    if (element) {
      element.value = value;
    }
  }

  function setStatus(message) {
    const status = $("zotero-ai-pref-status");
    if (status) {
      status.textContent = message;
      status.setAttribute("value", message);
    }
  }

  function loadPrefs() {
    setValue("zotero-ai-api-key", pref("openrouterApiKey", ""));
    setValue("zotero-ai-chat-model", pref("chatModel", "google/gemini-flash-latest"));
    setValue("zotero-ai-custom-chat-model", pref("customChatModel", ""));
    setValue("zotero-ai-embedding-model", pref("embeddingModel", "openai/text-embedding-3-small"));
    setValue("zotero-ai-custom-embedding-model", pref("customEmbeddingModel", ""));
    setValue("zotero-ai-pdf-mode", pref("pdfMode", "local-first"));
    setValue("zotero-ai-summary-chunks", pref("maxSummaryChunks", 0));
    setValue("zotero-ai-summary-exclude-pages", pref("summaryExcludeTrailingPages", 2));
    setValue("zotero-ai-top-k", pref("referenceTopK", 5));
  }

  function savePrefs() {
    setPref("openrouterApiKey", getValue("zotero-ai-api-key").trim());
    setPref("chatModel", getValue("zotero-ai-chat-model"));
    setPref("customChatModel", getValue("zotero-ai-custom-chat-model").trim());
    setPref("embeddingModel", getValue("zotero-ai-embedding-model"));
    setPref("customEmbeddingModel", getValue("zotero-ai-custom-embedding-model").trim());
    setPref("pdfMode", getValue("zotero-ai-pdf-mode"));
    setPref("maxSummaryChunks", Number(getValue("zotero-ai-summary-chunks") || 0));
    setPref("summaryExcludeTrailingPages", Number(getValue("zotero-ai-summary-exclude-pages") || 0));
    setPref("referenceTopK", Number(getValue("zotero-ai-top-k") || 5));
    setStatus("Saved");
  }

  async function rebuildIndex() {
    savePrefs();
    const button = $("zotero-ai-rebuild-index");
    if (button) {
      button.disabled = true;
    }
    try {
      const app = Zotero.ZoteroAI;
      if (!app) {
        throw new Error("Zotero AI plugin instance was not found. Restart Zotero and try again.");
      }
      const result = await app.rebuildIndexFromAnyWindow(setStatus);
      const skipped = result.total - result.indexed;
      const suffix = result.failures.length ? `, failed ${result.failures.length}` : "";
      setStatus(`Indexed ${result.indexed}, skipped ${skipped}${suffix}`);
    }
    catch (err) {
      setStatus(err.message || String(err));
    }
    finally {
      if (button) {
        button.disabled = false;
      }
    }
  }

  function init() {
    if (initialized || !$("zotero-ai-preferences")) {
      return;
    }
    initialized = true;
    loadPrefs();
    $("zotero-ai-save-prefs")?.addEventListener("click", savePrefs);
    $("zotero-ai-rebuild-index")?.addEventListener("click", rebuildIndex);
  }

  window.addEventListener("load", init);
  window.addEventListener("DOMContentLoaded", init);
  init();
}).call(this);
