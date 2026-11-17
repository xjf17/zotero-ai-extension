/* global document, window, MutationObserver, Zotero */
(function () {
  const BRANCH = "extensions.zotero-ai.";
  let initializedRoot = null;

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

  function setIndexErrors(message) {
    const details = $("zotero-ai-pref-index-errors");
    if (details) {
      details.value = message;
      details.hidden = !message;
    }
    else if (message) {
      setStatus(`${$("zotero-ai-pref-status")?.textContent || ""}\n${message}`.trim());
    }
  }

  function loadPrefs() {
    setValue("zotero-ai-chat-api-format", pref("chatAPIFormat", "openrouter"));
    setValue("zotero-ai-chat-base-url", pref("chatBaseURL", "https://openrouter.ai/api/v1"));
    setValue("zotero-ai-chat-api-key", pref("chatApiKey", pref("openrouterApiKey", "")));
    setValue("zotero-ai-chat-model", pref("chatModel", "deepseek/deepseek-v4-flash-0731"));
    setValue("zotero-ai-custom-chat-model", pref("customChatModel", ""));
    setValue("zotero-ai-multimodal-api-format", pref("multimodalAPIFormat", "openrouter"));
    setValue("zotero-ai-multimodal-base-url", pref("multimodalBaseURL", "https://openrouter.ai/api/v1"));
    setValue("zotero-ai-multimodal-api-key", pref("multimodalApiKey", pref("openrouterApiKey", "")));
    setValue("zotero-ai-embedding-model", pref("embeddingModel", "qwen/qwen3-embedding-8b"));
    setValue("zotero-ai-custom-embedding-model", pref("customEmbeddingModel", ""));
    setValue("zotero-ai-multimodal-model", pref("multimodalModel", "google/gemini-3.6-flash"));
    setValue("zotero-ai-custom-multimodal-model", pref("customMultimodalModel", ""));
    setValue("zotero-ai-embedding-api-format", pref("embeddingAPIFormat", "openrouter"));
    setValue("zotero-ai-embedding-base-url", pref("embeddingBaseURL", "https://openrouter.ai/api/v1"));
    setValue("zotero-ai-embedding-api-key", pref("embeddingApiKey", pref("openrouterApiKey", "")));
    setValue("zotero-ai-pdf-mode", pref("pdfMode", "local-first"));
    setValue("zotero-ai-summary-chunks", pref("maxSummaryChunks", 0));
    setValue("zotero-ai-summary-exclude-pages", pref("summaryExcludeTrailingPages", 2));
    setValue("zotero-ai-top-k", pref("referenceTopK", 5));
    setValue("zotero-ai-embed-concurrency", pref("embedConcurrentRequests", 10));
    setValue("zotero-ai-embed-batch-size", pref("embedBatchSize", 64));
  }

  function savePrefs() {
    const concurrency = Number(getValue("zotero-ai-embed-concurrency") || 10);
    const batchSize = Number(getValue("zotero-ai-embed-batch-size") || 64);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      setStatus("Embedding 并发请求数必须是大于 0 的整数。");
      $("zotero-ai-embed-concurrency")?.focus();
      return false;
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      setStatus("Embedding 每批片段数必须是大于 0 的整数。");
      $("zotero-ai-embed-batch-size")?.focus();
      return false;
    }

    setPref("chatAPIFormat", getValue("zotero-ai-chat-api-format"));
    setPref("chatBaseURL", getValue("zotero-ai-chat-base-url").trim());
    setPref("chatApiKey", getValue("zotero-ai-chat-api-key").trim());
    setPref("chatModel", getValue("zotero-ai-chat-model"));
    setPref("customChatModel", getValue("zotero-ai-custom-chat-model").trim());
    setPref("multimodalAPIFormat", getValue("zotero-ai-multimodal-api-format"));
    setPref("multimodalBaseURL", getValue("zotero-ai-multimodal-base-url").trim());
    setPref("multimodalApiKey", getValue("zotero-ai-multimodal-api-key").trim());
    setPref("embeddingModel", getValue("zotero-ai-embedding-model"));
    setPref("customEmbeddingModel", getValue("zotero-ai-custom-embedding-model").trim());
    setPref("multimodalModel", getValue("zotero-ai-multimodal-model"));
    setPref("customMultimodalModel", getValue("zotero-ai-custom-multimodal-model").trim());
    setPref("embeddingAPIFormat", getValue("zotero-ai-embedding-api-format"));
    setPref("embeddingBaseURL", getValue("zotero-ai-embedding-base-url").trim());
    setPref("embeddingApiKey", getValue("zotero-ai-embedding-api-key").trim());
    setPref("pdfMode", getValue("zotero-ai-pdf-mode"));
    setPref("maxSummaryChunks", Number(getValue("zotero-ai-summary-chunks") || 0));
    setPref("summaryExcludeTrailingPages", Number(getValue("zotero-ai-summary-exclude-pages") || 0));
    setPref("referenceTopK", Number(getValue("zotero-ai-top-k") || 5));
    setPref("embedConcurrentRequests", concurrency);
    setPref("embedBatchSize", batchSize);
    setStatus("Saved");
    return true;
  }

  async function rebuildIndex() {
    if (!savePrefs()) {
      return;
    }
    setIndexErrors("");
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
      const report = app.formatIndexResult(result);
      setStatus(report.summary);
      setIndexErrors(report.details);
    }
    catch (err) {
      setStatus(err.message || String(err));
      setIndexErrors(err.message || String(err));
    }
    finally {
      if (button) {
        button.disabled = false;
      }
    }
  }

  function init() {
    const root = $("zotero-ai-preferences");
    if (!root || initializedRoot === root) {
      return;
    }
    initializedRoot = root;
    loadPrefs();
    $("zotero-ai-save-prefs")?.addEventListener("click", savePrefs);
    $("zotero-ai-rebuild-index")?.addEventListener("click", rebuildIndex);
  }

  window.addEventListener("load", init);
  window.addEventListener("DOMContentLoaded", init);
  try {
    new MutationObserver(init).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
  catch (err) {
    // Some Zotero preference contexts may not expose MutationObserver early.
  }
  init();
}).call(this);
