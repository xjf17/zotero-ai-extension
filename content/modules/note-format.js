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

  function normalizeMarkdown(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function readListMarker(rawLine) {
    const match = String(rawLine || "").match(/^(\s*)([-*]|\d+[.)])\s+(.+)$/);
    if (!match) {
      return null;
    }
    return {
      indent: match[1].replace(/\t/g, "    ").length,
      type: /^\d/.test(match[2]) ? "ol" : "ul",
      text: match[3].trim()
    };
  }

  function renderList(list) {
    const items = list.items.map((item) => {
      const nested = item.children.map(renderList).join("");
      return `<li>${inlineMarkdownToHTML(item.text)}${nested}</li>`;
    }).join("");
    return `<${list.type}>${items}</${list.type}>`;
  }

  function attachList(listStack, list) {
    if (!listStack.length) {
      listStack.push(list);
      return;
    }
    const parent = listStack[listStack.length - 1];
    const parentItem = parent.items[parent.items.length - 1];
    if (!parentItem) {
      listStack.length = 0;
      listStack.push(list);
      return;
    }
    parentItem.children.push(list);
    listStack.push(list);
  }

  function appendListItem(listStack, marker) {
    while (listStack.length && marker.indent < listStack[listStack.length - 1].indent) {
      listStack.pop();
    }

    let current = listStack[listStack.length - 1] || null;
    if (!current || marker.indent > current.indent) {
      current = {
        type: marker.type,
        indent: marker.indent,
        items: []
      };
      attachList(listStack, current);
    } else if (marker.type !== current.type) {
      listStack.pop();
      current = {
        type: marker.type,
        indent: marker.indent,
        items: []
      };
      attachList(listStack, current);
    }

    current.items.push({
      text: marker.text,
      children: []
    });
  }

  function flushList(out, listStack) {
    if (!listStack.length) {
      return [];
    }
    out.push(renderList(listStack[0]));
    return [];
  }

  function splitMarkdownTableRow(row) {
    const source = String(row || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let cell = "";
    let escaped = false;

    for (const char of source) {
      if (escaped) {
        cell += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        cell += char;
        escaped = true;
        continue;
      }
      if (char === "|") {
        cells.push(cell.trim());
        cell = "";
        continue;
      }
      cell += char;
    }
    cells.push(cell.trim());
    return cells;
  }

  function isMarkdownTableSeparator(line) {
    const cells = splitMarkdownTableRow(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
  }

  function isMarkdownTableRow(line) {
    return String(line || "").includes("|") && splitMarkdownTableRow(line).length > 1;
  }

  function normalizeTableCells(cells, width) {
    const normalized = cells.slice(0, width);
    while (normalized.length < width) {
      normalized.push("");
    }
    return normalized;
  }

  function renderTableCell(tag, content) {
    const style = "border:1px solid #d0d7de;padding:4px 6px;vertical-align:top;";
    return `<${tag} style="${style}">${inlineMarkdownToHTML(content)}</${tag}>`;
  }

  function renderTable(header, rows) {
    const tableStyle = "border-collapse:collapse;width:100%;";
    const head = `<thead><tr>${header.map((cell) => renderTableCell("th", cell)).join("")}</tr></thead>`;
    const body = rows.length
      ? `<tbody>${rows.map((row) => `<tr>${row.map((cell) => renderTableCell("td", cell)).join("")}</tr>`).join("")}</tbody>`
      : "";
    return `<table style="${tableStyle}">${head}${body}</table>`;
  }

  function readMarkdownTable(lines, startIndex) {
    if (startIndex + 1 >= lines.length || !isMarkdownTableSeparator(lines[startIndex + 1])) {
      return null;
    }

    const header = splitMarkdownTableRow(lines[startIndex]);
    if (header.length < 2 || !isMarkdownTableRow(lines[startIndex])) {
      return null;
    }

    const width = header.length;
    const rows = [];
    let endIndex = startIndex + 1;
    for (let i = startIndex + 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || !isMarkdownTableRow(line)) {
        break;
      }
      rows.push(normalizeTableCells(splitMarkdownTableRow(line), width));
      endIndex = i;
    }

    return {
      html: renderTable(normalizeTableCells(header, width), rows),
      endIndex
    };
  }

  function markdownToNoteHTML(markdown) {
    const lines = normalizeMarkdown(markdown).split("\n");
    const out = [];
    let paragraph = [];
    let listStack = [];

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
        listStack = flushList(out, listStack);
        if (displayMath.content) {
          out.push(mathToNoteHTML(displayMath.content, true));
        }
        i = displayMath.endIndex;
        continue;
      }
      if (!line) {
        flushParagraph();
        listStack = flushList(out, listStack);
        continue;
      }
      if (/^---+$/.test(line)) {
        flushParagraph();
        listStack = flushList(out, listStack);
        out.push("<hr/>");
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        listStack = flushList(out, listStack);
        const level = Math.min(6, heading[1].length);
        out.push(`<h${level}>${inlineMarkdownToHTML(heading[2])}</h${level}>`);
        continue;
      }

      const table = readMarkdownTable(lines, i);
      if (table) {
        flushParagraph();
        listStack = flushList(out, listStack);
        out.push(table.html);
        i = table.endIndex;
        continue;
      }

      const listMarker = readListMarker(rawLine);
      if (listMarker) {
        flushParagraph();
        if (listStack.length === 1
          && listMarker.indent === listStack[0].indent
          && listMarker.type !== listStack[0].type) {
          listStack = flushList(out, listStack);
        }
        appendListItem(listStack, listMarker);
        continue;
      }

      listStack = flushList(out, listStack);
      paragraph.push(line);
    }

    flushParagraph();
    flushList(out, listStack);
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
