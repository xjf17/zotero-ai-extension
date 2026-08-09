(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
  const { DEFAULTS, DEFAULT_API_BASE_URL } = ns;

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

  Object.assign(ns, {
    normalizeText,
    normalizeAPIBaseURL,
    isOpenRouterURL,
    normalizePositiveInt,
    stripHTML,
    escapeHTML,
    modelLabelFromID,
    cleanSummaryMarkdown,
    cleanMarkdown,
    cosineSimilarity,
    chunkText,
    hashText,
    extractJSONArray,
    parseAnnotationComment
  });

  if (typeof module === "object" && module.exports) {
    module.exports = ns;
  }
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
