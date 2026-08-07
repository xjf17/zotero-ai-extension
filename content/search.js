/* global window, document, navigator */
(function () {
  let app;
  let openerWindow;

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(message) {
    $("zotero-ai-status").textContent = message;
  }

  function getChunkOptions() {
    const size = parseInt($("zotero-ai-chunk-size")?.value, 10);
    const overlap = parseInt($("zotero-ai-overlap")?.value, 10);
    return {
      chunkSize: Number.isFinite(size) && size > 0 ? size : 500,
      chunkOverlap: Number.isFinite(overlap) && overlap >= 0 ? overlap : 100
    };
  }

  function createProgress(message) {
    if (app?.createProgressHandle && openerWindow) {
      return app.createProgressHandle(openerWindow, message);
    }
    return {
      update: setStatus,
      close() {}
    };
  }

  function updateProgress(progress, message) {
    setStatus(message);
    progress?.update?.(message);
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

    let progress = null;
    setBusy(true);
    clearResults();
    try {
      ensureReady();
      progress = createProgress("正在准备查找引用...");
      const results = await app.searchReferences(openerWindow, query, (message) => {
        updateProgress(progress, message);
      });
      updateProgress(progress, "正在显示查找结果...");
      renderResults(results);
      setStatus(`找到 ${results.length} 条结果`);
    }
    catch (err) {
      setStatus(err.message || String(err));
    }
    finally {
      progress?.close?.();
      setBusy(false);
    }
  }

  async function rebuildIndex() {
    let progress = null;
    setBusy(true);
    clearResults();
    try {
      ensureReady();
      const chunkOptions = getChunkOptions();
      setStatus(`使用 chunk=${chunkOptions.chunkSize} overlap=${chunkOptions.chunkOverlap} 重建索引...`);
      progress = createProgress("正在准备重建引用索引...");
      const result = await app.rebuildIndexForVisibleItems(openerWindow, (message) => {
        updateProgress(progress, message);
      }, chunkOptions);
      const skipped = result.total - result.indexed;
      const suffix = result.failures.length ? `，失败 ${result.failures.length} 篇` : "";
      updateProgress(progress, "正在完成索引重建...");
      setStatus(`索引完成: 新建/更新 ${result.indexed} 篇，跳过 ${skipped} 篇${suffix}`);
    }
    catch (err) {
      setStatus(err.message || String(err));
    }
    finally {
      progress?.close?.();
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
