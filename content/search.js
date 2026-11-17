/* global window, document, navigator */
(function () {
  let app;
  let openerWindow;

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(message) {
    $("zotero-ai-status").textContent = message;
    $("zotero-ai-status").setAttribute("value", message);
  }

  function setIndexErrors(message) {
    const details = $("zotero-ai-index-errors");
    if (details) {
      details.value = message;
      details.hidden = !message;
    }
    else if (message) {
      setStatus(`${$("zotero-ai-status")?.textContent || ""}\n${message}`.trim());
    }
  }

  function getChunkOptions() {
    const size = parseInt($("zotero-ai-chunk-size")?.value, 10);
    const overlap = parseInt($("zotero-ai-overlap")?.value, 10);
    return {
      chunkSize: Number.isFinite(size) && size > 0 ? size : 500,
      chunkOverlap: Number.isFinite(overlap) && overlap >= 0 ? overlap : 100
    };
  }

  function clearResults() {
    const list = $("zotero-ai-results");
    while (list.firstChild) {
      list.firstChild.remove();
    }
  }

  function renderResults(results) {
    clearResults();
    const list = $("zotero-ai-results");
    if (!results.length) {
      const item = document.createElement("div");
      item.className = "zotero-ai-empty";
      item.textContent = "没有找到结果。请先重建索引，或换一种表述。";
      list.appendChild(item);
      return;
    }

    for (const result of results) {
      const item = document.createElement("div");
      item.className = "zotero-ai-result";

      const title = document.createElement("div");
      title.className = "zotero-ai-result-title";
      title.textContent = result.title || "Untitled";
      item.appendChild(title);

      const meta = document.createElement("p");
      meta.className = "zotero-ai-result-meta";
      meta.textContent = [result.creators, result.year, `score ${Number(result.score || 0).toFixed(3)}`]
        .filter(Boolean)
        .join(" · ");
      item.appendChild(meta);

      const reason = document.createElement("p");
      reason.className = "zotero-ai-result-reason";
      reason.textContent = `推荐理由: ${result.reason || ""}`;
      item.appendChild(reason);

      const quote = document.createElement("p");
      quote.className = "zotero-ai-result-quote";
      quote.textContent = `"${result.quote || result.text || ""}"`;
      item.appendChild(quote);

      const copy = document.createElement("button");
      copy.className = "zotero-ai-copy";
      copy.textContent = "复制摘录";
      copy.addEventListener("click", async () => {
        const text = [
          result.title,
          result.creators,
          result.year,
          "",
          result.reason,
          "",
          result.quote || result.text || ""
        ].filter(Boolean).join("\n");
        await navigator.clipboard.writeText(text);
        setStatus("摘录已复制");
      });
      item.appendChild(copy);

      list.appendChild(item);
    }
  }

  function setBusy(value) {
    $("zotero-ai-search").disabled = value;
    $("zotero-ai-rebuild").disabled = value;
    $("zotero-ai-clear").disabled = value;
  }

  function ensureReady() {
    if (!app || !openerWindow) {
      throw new Error("搜索面板没有连接到 Zotero 主窗口。请关闭后重新打开。");
    }
  }

  async function runSearch() {
    const query = $("zotero-ai-query").value.trim();
    if (!query) {
      setStatus("请输入一句想法或论点");
      return;
    }

    setBusy(true);
    clearResults();
    try {
      ensureReady();
      setStatus("正在准备查找引用...");
      const results = await app.searchReferences(openerWindow, query, setStatus);
      setStatus("正在显示查找结果...");
      renderResults(results);
      setStatus(`找到 ${results.length} 条结果`);
    }
    catch (err) {
      setStatus(err.message || String(err));
    }
    finally {
      setBusy(false);
    }
  }

  async function rebuildIndex() {
    setBusy(true);
    clearResults();
    try {
      ensureReady();
      const chunkOptions = getChunkOptions();
      setIndexErrors("");
      setStatus(`使用 chunk=${chunkOptions.chunkSize} overlap=${chunkOptions.chunkOverlap} 重建索引...`);
      const result = await app.rebuildIndexForVisibleItems(openerWindow, setStatus, chunkOptions);
      const report = app.formatIndexResult(result);
      setStatus(report.summary);
      setIndexErrors(report.details);
    }
    catch (err) {
      setStatus(err.message || String(err));
      setIndexErrors(err.message || String(err));
    }
    finally {
      setBusy(false);
    }
  }

  window.addEventListener("load", () => {
    const args = window.arguments?.[0] || {};
    app = args.app;
    openerWindow = args.opener || window.opener;

    $("zotero-ai-search").addEventListener("click", runSearch);
    $("zotero-ai-rebuild").addEventListener("click", rebuildIndex);
    $("zotero-ai-clear").addEventListener("click", () => {
      $("zotero-ai-query").value = "";
      clearResults();
      setStatus("准备就绪");
    });
    $("zotero-ai-query").focus();
  });
}).call(this);
