const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const preferences = new Map();
global.Zotero = {
  Prefs: { get: (key) => preferences.get(key) },
  debug() {}
};
require("../content/modules/config.js");
require("../content/modules/text-utils.js");
require("../content/modules/zotero-helpers.js");
require("../content/modules/index-store.js");
const { DEFAULTS, IndexStore, chunkText, hashText } = global.ZoteroAIShared;
const concurrencyKey = "extensions.zotero-ai.embedConcurrentRequests";
const batchSizeKey = "extensions.zotero-ai.embedBatchSize";
const vector = (text) => [parseInt(hashText(text), 16), text.length];

function createStore({ fail = () => false } = {}) {
  const state = { active: 0, peak: 0, calls: [], finished: [], indexes: new Map(), saves: [] };
  const client = {
    embeddingModel: "test-embedding-model",
    async embed(texts) {
      const request = state.calls.length;
      state.calls.push(texts);
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, request % 3 === 0 ? 8 : 1));
        if (fail(texts, request)) {
          throw new Error("Simulated embedding failure");
        }
        state.finished.push(request);
        return texts.map(vector);
      }
      finally {
        state.active--;
      }
    }
  };
  const store = new IndexStore(client, {
    async getTextForItem(item) {
      if (item.noText) {
        throw new Error("Missing PDF text");
      }
      return { text: item.text, attachmentID: item.id + 1000, source: "test-text" };
    }
  });
  store.load = async (libraryID) => {
    if (!state.indexes.has(libraryID)) {
      state.indexes.set(libraryID, { embeddingModel: client.embeddingModel, items: {} });
    }
    return state.indexes.get(libraryID);
  };
  store.save = async (libraryID, index) => {
    assert.equal(state.active, 0, "All requests must settle before saving an index");
    state.saves.push({ libraryID, index: structuredClone(index) });
  };
  return { store, state };
}

function item(id, libraryID = 1, paragraphs = 1) {
  return {
    id,
    libraryID,
    text: Array.from({ length: paragraphs }, (_, i) => `Paper ${id}, chunk ${i}: ${"x".repeat(160)}`).join("\n\n"),
    getField: (field) => field === "title" ? `Paper ${id}` : "",
    getCreators: () => [{ lastName: `Author ${id}` }]
  };
}

function assertIndexedVectors(index, items, options = {}) {
  for (const source of items) {
    const chunks = chunkText(source.text, options);
    const entry = index.items[source.id];
    assert.deepEqual(entry.chunks.map((chunk) => chunk.text), chunks);
    assert.deepEqual(entry.chunks.map((chunk) => chunk.embedding), chunks.map(vector));
  }
}

async function testBatchConcurrency() {
  const chunks = Array.from({ length: DEFAULTS.embedBatchSize * 18 + 7 }, (_, i) => `chunk-${i}`);
  for (const value of [undefined, 1, 3, 10, 15, 0, -1, 1.5, "invalid", Infinity]) {
    preferences.set(concurrencyKey, value);
    const { store, state } = createStore();
    const expected = Number.isSafeInteger(value) && value > 0 ? value : 10;
    assert.deepEqual(await store.embedChunks(chunks), chunks.map(vector));
    assert.equal(state.peak, expected, `Unexpected concurrency for ${value}`);
    assert.equal(state.calls.length, 19);
    assert.equal(state.calls.at(-1).length, 7);
    assert.equal(state.active, 0);
    assert.ok(state.calls.every((batch) => batch.length <= DEFAULTS.embedBatchSize));
    if (expected > 1) {
      assert.notEqual(state.finished[0], 0, "Requests should finish out of order in this fixture");
    }
  }
  const { store, state } = createStore();
  assert.deepEqual(await store.embedChunks([]), []);
  assert.equal(state.calls.length, 0);
}

async function testBatchSize() {
  preferences.set(concurrencyKey, 3);
  const chunks = Array.from({ length: 207 }, (_, i) => `chunk-${i}`);
  for (const value of [undefined, 1, 24, 48, 64, 96, 0, -1, 1.5, "invalid"]) {
    preferences.set(batchSizeKey, value);
    const expected = Number.isSafeInteger(value) && value > 0 ? value : 64;
    const { store, state } = createStore();
    assert.deepEqual(await store.embedChunks(chunks), chunks.map(vector));
    assert.equal(state.calls.length, Math.ceil(chunks.length / expected));
    assert.ok(state.calls.every((batch) => batch.length <= expected));
    assert.deepEqual(state.calls.flat(), chunks, "Batching must preserve every input fragment");
    assert.ok(state.peak <= 3);
  }
  preferences.delete(batchSizeKey);
}

async function testRebuildConcurrencyAndCache() {
  preferences.delete(concurrencyKey);
  const { store, state } = createStore();
  const items = Array.from({ length: 16 }, (_, i) => item(i + 1));
  const progress = [];
  const { updatedIDs, reusedIDs, itemFailures, ...firstResult } = await store.rebuildItems(items, (message) => progress.push(message));
  assert.equal(new Set(updatedIDs).size, items.length);
  assert.deepEqual(reusedIDs, []);
  assert.deepEqual(itemFailures, []);
  assert.deepEqual(firstResult, {
    indexed: items.length, skipped: 0, failures: []
  });
  assert.equal(state.peak, 10, "Short papers must share the available request concurrency");
  assertIndexedVectors(state.indexes.get(1), items);
  assert.equal(state.saves.length, 1);
  assert.match(progress[0], /10/);
  assert.match(progress.at(-1), /16\/16/);

  const callsBeforeCache = state.calls.length;
  const cached = await store.rebuildItems(items);
  assert.equal(cached.indexed, 0);
  assert.equal(cached.skipped, items.length);
  assert.deepEqual(cached.failures, []);
  assert.equal(state.calls.length, callsBeforeCache, "Unchanged papers must reuse their embeddings");
  preferences.set(batchSizeKey, 24);
  await store.rebuildItems(items);
  assert.equal(state.calls.length, callsBeforeCache, "Batch size changes must not invalidate existing embeddings");
  preferences.delete(batchSizeKey);

  preferences.set(concurrencyKey, 3);
  state.peak = 0;
  const longItems = Array.from({ length: 6 }, (_, i) => item(i + 50, i < 5 ? 1 : 2, 80));
  const options = { chunkSize: 200, chunkOverlap: 20 };
  await store.rebuildItems(longItems, null, options);
  assert.equal(state.peak, 3, "Concurrent papers must not multiply the request limit");
  assertIndexedVectors(state.indexes.get(1), longItems.slice(0, 5), options);
  assertIndexedVectors(state.indexes.get(2), longItems.slice(5), options);
  assert.deepEqual(state.saves.slice(-2).map((save) => save.libraryID), [1, 2]);
}

async function testFailures() {
  preferences.set(concurrencyKey, 3);
  const { store, state } = createStore({ fail: (texts) => texts.some((text) => text.startsWith("Paper 1,")) });
  const items = [item(1, 1, 100), item(2, 1, 100), item(3), { ...item(4), noText: true }, item(5)];
  const index = await store.load(1);
  const oldEntry = { textHash: "old", chunks: [{ text: "Previous successful index" }] };
  index.items[1] = oldEntry;
  const result = await store.rebuildItems(items, null, { chunkSize: 200, chunkOverlap: 20 });
  assert.equal(result.indexed, 3);
  assert.equal(result.failures.length, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.indexed + result.skipped + result.failures.length, items.length);
  assert.ok(result.failures.some((message) => /读取 PDF 文本失败: Missing PDF text/.test(message)));
  assert.ok(result.failures.some((message) => /Embedding 批次.*Simulated embedding failure/.test(message)));
  assert.equal(index.items[1], oldEntry, "A failed rebuild must preserve the previous item entry");
  assert.equal(index.items[4], undefined);
  assertIndexedVectors(index, [items[1], items[2], items[4]], { chunkSize: 200, chunkOverlap: 20 });
  assert.equal(state.peak, 3);
  assert.equal(state.active, 0);
  assert.equal(state.saves.length, 1);
  assert.deepEqual(state.saves[0].index, index);
}

function createPreferencesPane(values, app) {
  const root = path.resolve(__dirname, "..");
  const xml = fs.readFileSync(path.join(root, "content/preferences-pane.xhtml"), "utf8");
  const elements = new Map([...xml.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], {
    value: "",
    listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; },
    setAttribute() {},
    focus() {}
  }]));
  vm.runInNewContext(fs.readFileSync(path.join(root, "content/preferences-pane.js"), "utf8"), {
    document: { getElementById: (id) => elements.get(id), documentElement: {} },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    Zotero: {
      ZoteroAI: app,
      Prefs: {
        get: (key) => values.get(key),
        set: (key, value) => values.set(key, value)
      }
    }
  });
  return elements;
}

async function testPreferences() {
  const values = new Map();
  const elements = createPreferencesPane(values);
  const input = elements.get("zotero-ai-embed-concurrency");
  const save = elements.get("zotero-ai-save-prefs").listeners.click;
  assert.equal(input.value, 10);
  const batchInput = elements.get("zotero-ai-embed-batch-size");
  assert.equal(batchInput.value, 64);
  batchInput.value = "48";
  input.value = "4";
  assert.equal(save(), true);
  assert.equal(values.get(concurrencyKey), 4);
  assert.equal(values.get(batchSizeKey), 48);
  assert.equal(createPreferencesPane(values).get("zotero-ai-embed-batch-size").value, 48);
  assert.equal(createPreferencesPane(values).get("zotero-ai-embed-concurrency").value, 4);
  for (const value of ["0", "-2", "1.5", "NaN", "Infinity"]) {
    input.value = value;
    assert.equal(save(), false);
    assert.equal(values.get(concurrencyKey), 4);
    await elements.get("zotero-ai-rebuild-index").listeners.click();
    assert.equal(elements.get("zotero-ai-rebuild-index").disabled, undefined);
  }
  input.value = "15";
  for (const value of ["0", "-2", "1.5", "NaN", "Infinity"]) {
    batchInput.value = value;
    assert.equal(save(), false);
    assert.equal(values.get(batchSizeKey), 48);
  }
  batchInput.value = "96";
  assert.equal(save(), true);
  assert.equal(values.get(concurrencyKey), 15);
  assert.equal(values.get(batchSizeKey), 96);
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../prefs.js"), "utf8"), {
    pref: (key, value) => {
      if (key === concurrencyKey) assert.equal(value, DEFAULTS.embedConcurrentRequests);
      if (key === batchSizeKey) assert.equal(value, DEFAULTS.embedBatchSize);
    }
  });
}

function createSearchWindow(app) {
  const root = path.resolve(__dirname, "..");
  require("../content/app.js");
  let panelURL;
  global.ZoteroAIShared.ZoteroAIApp.prototype.openSearchPanel.call({
    runningActions: new Set(),
    createProgressHandle: () => ({ close() {} })
  }, {
    openDialog(url) {
      panelURL = url;
      return { addEventListener() {}, focus() {} };
    },
    setTimeout() {}
  });
  const prefix = "chrome://zoteroai/content/";
  assert.ok(panelURL.startsWith(prefix));
  const xml = fs.readFileSync(path.join(root, "content", panelURL.slice(prefix.length)), "utf8");
  assert.match(xml, /id="zotero-ai-index-errors"/, "The actual search panel must contain the error display");
  const elements = new Map([...xml.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], {
    value: "", listeners: {},
    appendChild() {},
    addEventListener(event, handler) { this.listeners[event] = handler; },
    setAttribute() {}, focus() {}
  }]));
  let onLoad;
  vm.runInNewContext(fs.readFileSync(path.join(root, "content/search.js"), "utf8"), {
    document: { getElementById: (id) => elements.get(id), createElement: () => ({}) },
    window: {
      arguments: [{ app, opener: {} }],
      addEventListener(event, handler) { if (event === "load") onLoad = handler; }
    }
  });
  onLoad();
  return elements;
}

async function testFailureReporting() {
  require("../content/app.js");
  const formatIndexResult = global.ZoteroAIShared.ZoteroAIApp.prototype.formatIndexResult;
  const { store } = createStore();
  const items = Array.from({ length: 109 }, (_, i) => ({ ...item(i + 1), noText: true }));
  let result = await store.rebuildItems(items);
  assert.equal(result.indexed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.failures.length, 109);
  const app = {
    formatIndexResult,
    async rebuildIndexFromAnyWindow() { return result; },
    async rebuildIndexForVisibleItems() { return result; }
  };
  const panes = [
    [createPreferencesPane(new Map(), app), "zotero-ai-rebuild-index", "zotero-ai-pref-index-errors", "zotero-ai-pref-status"],
    [createSearchWindow(app), "zotero-ai-rebuild", "zotero-ai-index-errors", "zotero-ai-status"]
  ];
  for (const [elements, button, details, status] of panes) {
    await elements.get(button).listeners.click();
    assert.equal(elements.get(button).disabled, false);
    assert.match(elements.get(status).textContent, /新建\/更新 0 篇，复用已有索引 0 篇，失败 109 篇/);
    assert.equal(elements.get(details).hidden, false);
    assert.match(elements.get(details).value, /109\. 文献 109「Paper 109」: 读取 PDF 文本失败: Missing PDF text/);
  }
  result = { indexed: 1, skipped: 2, failures: [] };
  for (const [elements, button, details, status] of panes) {
    await elements.get(button).listeners.click();
    assert.equal(elements.get(details).value, "");
    assert.equal(elements.get(details).hidden, true);
    assert.match(elements.get(status).textContent, /新建\/更新 1 篇，复用已有索引 2 篇，失败 0 篇/);
  }
  result = { indexed: 0, skipped: 0, failures: ["Original provider error"] };
  for (const [elements, button, details, status] of panes) {
    elements.delete(details);
    await elements.get(button).listeners.click();
    assert.equal(elements.get(button).disabled, false);
    assert.match(elements.get(status).textContent, /Original provider error/);
    assert.doesNotMatch(elements.get(status).textContent, /null|undefined/);
  }
  app.rebuildIndexFromAnyWindow = app.rebuildIndexForVisibleItems = async () => {
    throw new Error("Original rebuild failure");
  };
  for (const [elements, button, , status] of panes) {
    await elements.get(button).listeners.click();
    assert.equal(elements.get(button).disabled, false);
    assert.match(elements.get(status).textContent, /Original rebuild failure/);
  }
}

async function testSearchProgress() {
  let elements;
  let popupCount = 0;
  const app = {
    createProgressHandle() { popupCount++; throw new Error("Unexpected progress popup"); },
    formatIndexResult: global.ZoteroAIShared.ZoteroAIApp.prototype.formatIndexResult,
    async searchReferences(win, query, progress) {
      assert.equal(query, "test query");
      progress("Search progress");
      assert.equal(elements.get("zotero-ai-status").textContent, "Search progress");
      return [];
    },
    async rebuildIndexForVisibleItems(win, progress) {
      progress("Index progress");
      assert.equal(elements.get("zotero-ai-status").textContent, "Index progress");
      return { indexed: 1, skipped: 0, failures: [] };
    }
  };
  elements = createSearchWindow(app);
  elements.get("zotero-ai-query").value = "test query";
  await elements.get("zotero-ai-search").listeners.click();
  assert.equal(elements.get("zotero-ai-status").textContent, "找到 0 条结果");
  await elements.get("zotero-ai-rebuild").listeners.click();
  assert.match(elements.get("zotero-ai-status").textContent, /新建\/更新 1 篇/);
  assert.equal(popupCount, 0);
  assert.equal(elements.get("zotero-ai-search").disabled, false);
}

async function testModelMigration() {
  require("../content/modules/ai-client.js");
  require("../content/app.js");
  const ns = global.ZoteroAIShared;
  const migrate = ns.ZoteroAIApp.prototype.migrateEmbeddingModel;
  const modelKey = "extensions.zotero-ai.embeddingModel";
  const urlKey = "extensions.zotero-ai.embeddingBaseURL";
  const markerKey = "extensions.zotero-ai.qwenEmbeddingDefaultApplied";
  const saved = new Map(preferences);
  const originalSet = Zotero.Prefs.set;
  Zotero.Prefs.set = (key, value) => preferences.set(key, value);
  try {
    const cases = [
      ["nvidia/nemotron-3-embed-1b:free", "https://openrouter.ai/api/v1", "qwen/qwen3-embedding-8b"],
      ["qwen/qwen3-embedding-8b", "https://openrouter.ai/api/v1", "qwen/qwen3-embedding-8b"],
      ["custom", "https://openrouter.ai/api/v1", "custom"],
      ["another-model", "https://openrouter.ai/api/v1", "another-model"],
      ["nvidia/nemotron-3-embed-1b:free", "https://custom.test/v1", "nvidia/nemotron-3-embed-1b:free"]
    ];
    for (const [model, url, expected] of cases) {
      preferences.clear();
      preferences.set(modelKey, model);
      preferences.set(urlKey, url);
      const app = { client: new ns.OpenAICompatibleClient() };
      migrate.call(app);
      assert.equal(preferences.get(modelKey), expected);
      assert.equal(preferences.get(urlKey), url);
      assert.equal(preferences.get(markerKey), true);
      assert.deepEqual([...preferences.keys()].sort(), [modelKey, urlKey, markerKey].sort(), "Migration must not alter other settings");
      preferences.set(modelKey, "nvidia/nemotron-3-embed-1b:free");
      migrate.call(app);
      assert.equal(preferences.get(modelKey), "nvidia/nemotron-3-embed-1b:free", "Migration must run only once");
    }
    preferences.clear();
    assert.equal(new ns.OpenAICompatibleClient().embeddingModel, "qwen/qwen3-embedding-8b");
    assert.equal(createPreferencesPane(new Map()).get("zotero-ai-embedding-model").value, "qwen/qwen3-embedding-8b");
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../prefs.js"), "utf8"), {
      pref: (key, value) => { if (key === modelKey) assert.equal(value, "qwen/qwen3-embedding-8b"); }
    });
    const context = {
      ZoteroAIShared: { DEFAULTS },
      Zotero: {
        getStorageDirectory: () => ({ clone: () => ({ append() {}, exists: () => true, path: "memory" }) })
      },
      PathUtils: { join: () => "memory-index.json" },
      IOUtils: {
        exists: async () => true,
        readUTF8: async () => JSON.stringify({ embeddingModel: "old-model", items: { 1: { chunks: [{ embedding: [1] }] } } })
      }
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../content/modules/index-store.js"), "utf8"), context);
    const store = new context.ZoteroAIShared.IndexStore({ embeddingModel: "qwen/qwen3-embedding-8b" }, {});
    const index = await store.load(1);
    assert.equal(Object.keys(index.items).length, 0, "Different model vectors must not be reused");
    assert.equal(store._modelChangedOnLoad, true);
  }
  finally {
    preferences.clear();
    for (const [key, value] of saved) preferences.set(key, value);
    Zotero.Prefs.set = originalSet;
  }
}

function testSearchPanelFocus() {
  require("../content/app.js");
  const openSearchPanel = global.ZoteroAIShared.ZoteroAIApp.prototype.openSearchPanel;
  const events = [];
  const timers = [];
  let onLoad;
  let progressWindows = 0;
  const dialog = {
    closed: false,
    focus() { events.push("panel-focus"); },
    document: {
      getElementById(id) {
        assert.equal(id, "zotero-ai-query");
        return { focus() { events.push("query-focus"); } };
      }
    },
    addEventListener(event, handler, options) {
      assert.equal(event, "load");
      assert.equal(options.once, true);
      onLoad = handler;
    },
    setTimeout(handler, delay) {
      assert.equal(delay, 0);
      timers.push(handler);
    }
  };
  const app = {
    runningActions: new Set(),
    createProgressHandle() {
      progressWindows++;
      return { close() { events.push("main-focus"); } };
    }
  };
  const ownerTimers = [];
  let opened = 0;
  const win = {
    openDialog(url, name, features, args) {
      opened++;
      assert.equal(url, "chrome://zoteroai/content/search.html");
      assert.equal(name, "zotero-ai-search");
      assert.ok(features.includes("dialog=no"));
      assert.ok(!features.includes("modal"));
      assert.equal(args.app, app);
      assert.equal(args.opener, win);
      return dialog;
    },
    setTimeout(handler, delay) { ownerTimers.push({ handler, delay }); }
  };
  assert.equal(openSearchPanel.call(app, win), dialog);
  assert.equal(progressWindows, 0, "Opening search must not create a progress window that restores owner focus");
  assert.deepEqual(events, ["panel-focus"]);
  assert.equal(openSearchPanel.call(app, win), null);
  assert.equal(opened, 1, "Rapid duplicate commands must not open more windows");
  onLoad();
  events.push("main-focus");
  timers.shift()();
  assert.deepEqual(events.slice(-2), ["panel-focus", "query-focus"]);
  assert.equal(timers.length, 0, "Do not keep reclaiming focus after the initial opening");
  assert.deepEqual(ownerTimers.map((timer) => timer.delay), [500]);
  ownerTimers.shift().handler();
  assert.equal(app.runningActions.size, 0);

  openSearchPanel.call(app, win);
  onLoad();
  dialog.closed = true;
  const count = events.length;
  timers.shift()();
  assert.equal(events.length, count, "Do not focus a window closed before the callback runs");
  ownerTimers.shift().handler();

  assert.throws(() => openSearchPanel.call(app, {
    openDialog() { throw new Error("Window open failed"); },
    setTimeout: win.setTimeout
  }), /Window open failed/);
  ownerTimers.shift().handler();
  assert.equal(app.runningActions.size, 0, "Opening failure must release the duplicate-command guard");
}

async function main() {
  testSearchPanelFocus();
  await testBatchConcurrency();
  await testBatchSize();
  await testRebuildConcurrencyAndCache();
  await testFailures();
  await testPreferences();
  await testModelMigration();
  await testFailureReporting();
  await testSearchProgress();
  console.log("Index concurrency, ordering, cache, failure and preference tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
