(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
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

  Object.assign(ns, {
    PREF_BRANCH,
    PLUGIN_NS,
    MATH_OUTPUT_INSTRUCTIONS,
    DEFAULTS,
    DEFAULT_API_BASE_URL,
    SELECTORS,
    pref
  });

  if (typeof module === "object" && module.exports) {
    module.exports = ns;
  }
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
