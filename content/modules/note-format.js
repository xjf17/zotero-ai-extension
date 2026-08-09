(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
  const { normalizeText, escapeHTML } = ns;

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

  Object.assign(ns, {
    textToNoteHTML,
    markdownToNoteHTML,
    normalizeMathDelimiters
  });

  if (typeof module === "object" && module.exports) {
    module.exports = {
      textToNoteHTML,
      markdownToNoteHTML,
      normalizeMathDelimiters
    };
  }
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
