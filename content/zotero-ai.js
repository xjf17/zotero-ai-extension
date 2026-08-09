(function (root) {
  const isNodeTest = typeof process === "object" && process?.versions?.node;
  if (isNodeTest && typeof module === "object" && module.exports) {
    require("./modules/config.js");
    require("./modules/text-utils.js");
    const noteFormat = require("./modules/note-format.js");
    module.exports = {
      markdownToNoteHTML: noteFormat.markdownToNoteHTML,
      normalizeMathDelimiters: noteFormat.normalizeMathDelimiters,
      normalizeAPIBaseURL: root.ZoteroAIShared.normalizeAPIBaseURL
    };
    return;
  }

  root.ZoteroAI = new root.ZoteroAIApp();
  if (typeof ZoteroAI !== "undefined") {
    ZoteroAI = root.ZoteroAI;
  }
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
