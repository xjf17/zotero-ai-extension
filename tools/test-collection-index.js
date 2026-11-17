const assert = require("node:assert/strict");
const path = require("node:path");
const files = new Map();
const reads = [];
let embeddingCalls = 0;
global.Zotero = {
  Prefs: { get() {} },
  debug() {},
  getStorageDirectory: () => ({ clone: () => ({ append() {}, exists: () => true, path: "indexes" }) }),
  Libraries: { userLibraryID: 1 }
};
global.PathUtils = { join: path.posix.join };
global.IOUtils = {
  exists: async (name) => files.has(name),
  readUTF8: async (name) => { reads.push(name); return files.get(name); },
  writeUTF8: async (name, value) => { files.set(name, value); }
};
require("../content/modules/config.js");
require("../content/modules/text-utils.js");
require("../content/modules/zotero-helpers.js");
require("../content/modules/index-store.js");
require("../content/app.js");
const { IndexStore, ZoteroAIApp, getIndexPath } = global.ZoteroAIShared;
const client = {
  embeddingModel: "test-model", ensureConfigured() {},
  async embed(texts) {
    embeddingCalls++;
    return (Array.isArray(texts) ? texts : [texts]).map(() => [1, 0]);
  }
};
function item(id, collectionIDs = []) {
  return {
    id, libraryID: 1,
    getCollections: () => collectionIDs,
    getField: (field) => field === "title" ? `Paper ${id}` : "",
    getCreators: () => []
  };
}
const one = item(1, [10, 11]);
const two = item(2, [11]);
const other = item(3, [20]);
const unfiled = item(4);
const parent = collection(10, "Parent", [one]);
const child = collection(11, "Child", [one, two]);
const grandchild = collection(12, "Grandchild", [item(6, [12])]);
child.children.push(grandchild);
const unrelated = collection(20, "Other", [other]);
const empty = collection(30, "Empty", []);
parent.children.push(child, empty);
function collection(id, name, items) {
  return {
    id, name, libraryID: 1, children: [],
    async loadAllData() { this.loaded = true; },
    getChildItems() { assert.equal(this.loaded, true); return items; },
    getChildCollections() { assert.equal(this.loaded, true); return this.children; }
  };
}
Zotero.Collections = { getByLibrary: () => [parent, unrelated] };
let selected = parent;
let visible = [one, other, unfiled];
const win = { ZoteroPane: {
  getSelectedLibraryID: () => 1,
  getSelectedCollection: () => selected,
  getSortedItems: () => visible
} };
const store = new IndexStore(client, {
  async getTextForItem(value) {
    return { text: `Paper ${value.id}: ${"text ".repeat(100)}`, attachmentID: value.id + 100, source: "test" };
  }
});
const app = Object.create(ZoteroAIApp.prototype);
app.client = client;
app.indexStore = store;
app.runningActions = new Set();

async function main() {
  const legacy = getIndexPath(1).replace("-unfiled", "");
  files.set(legacy, "Legacy whole-library file must not be parsed or modified");
  assert.notEqual(getIndexPath(1, 10), getIndexPath(2, 10));
  assert.notEqual(getIndexPath(1, 10), getIndexPath(1, 11));
  assert.throws(() => getIndexPath(1, "../bad"), /分类 ID/);
  let scope = await app.getReferenceScope(win);
  assert.deepEqual(scope.groups.map((group) => group.collectionID), [10]);
  assert.deepEqual(scope.groups.map((group) => group.items.map((value) => value.id)), [[1]]);
  assert.deepEqual(await app.rebuildIndexForVisibleItems(win), { total: 1, indexed: 1, skipped: 0, failures: [] });
  assert.ok(files.has(getIndexPath(1, 10)));
  assert.ok(!files.has(getIndexPath(1, 11)));
  assert.ok(!files.has(getIndexPath(1, 12)));
  assert.ok(!files.has(getIndexPath(1, 20)));
  assert.ok(!files.has(getIndexPath(1, 30)));
  const firstCalls = embeddingCalls;
  assert.deepEqual(await app.rebuildIndexForVisibleItems(win), { total: 1, indexed: 0, skipped: 1, failures: [] });
  assert.equal(embeddingCalls, firstCalls);
  parent.name = "Renamed Parent";
  await app.rebuildIndexForVisibleItems(win);
  assert.equal(embeddingCalls, firstCalls, "Collection rename must keep the same cache path");
  const results = await store.search(1, "query", 5, scope.groups);
  assert.equal(new Set(results.map((result) => result.itemID)).size, 1);
  assert.equal(results.filter((result) => result.itemID === 1).length, JSON.parse(files.get(getIndexPath(1, 10))).items[1].chunks.length);
  assert.ok(results.every((result) => result.itemID === 1));
  assert.equal(store._missingScopes.length, 0);

  selected = child;
  scope = await app.getReferenceScope(win);
  assert.deepEqual(scope.groups.map((group) => group.collectionID), [11]);
  assert.deepEqual(await app.rebuildIndexForVisibleItems(win), { total: 2, indexed: 2, skipped: 0, failures: [] });
  assert.ok(!files.has(getIndexPath(1, 12)), "Selecting a child must not index its child");
  reads.length = 0;
  await store.search(1, "query", 1, scope.groups);
  assert.deepEqual(reads, [getIndexPath(1, 11)], "Child search must not read parent or sibling files");
  selected = grandchild;
  scope = await app.getReferenceScope(win);
  assert.deepEqual(scope.groups.map((group) => group.collectionID), [12]);
  assert.deepEqual(await app.rebuildIndexForVisibleItems(win), { total: 1, indexed: 1, skipped: 0, failures: [] });
  reads.length = 0;
  const grandResults = await store.search(1, "query", 5, scope.groups);
  assert.deepEqual(reads, [getIndexPath(1, 12)]);
  assert.ok(grandResults.every((result) => result.itemID === 6));
  selected = parent;
  const childFile = files.get(getIndexPath(1, 11));
  const grandchildFile = files.get(getIndexPath(1, 12));
  await app.rebuildIndexForVisibleItems(win);
  assert.equal(files.get(getIndexPath(1, 11)), childFile, "Parent rebuild must leave existing child indexes untouched");
  assert.equal(files.get(getIndexPath(1, 12)), grandchildFile);
  scope = await app.getReferenceScope(win);
  reads.length = 0;
  await store.search(1, "query", 5, scope.groups);
  assert.deepEqual(reads, [getIndexPath(1, 10)], "Parent search must not read existing descendant indexes");
  selected = collection(31, "Empty parent", []);
  selected.children.push(child);
  scope = await app.getReferenceScope(win);
  assert.deepEqual(scope.groups.map((group) => group.collectionID), [31]);
  await assert.rejects(app.rebuildIndexForVisibleItems(win), /没有可索引/);
  selected = empty;
  visible = [];
  scope = await app.getReferenceScope(win);
  assert.equal(scope.groups[0].items.length, 0);
  reads.length = 0;
  assert.deepEqual(await store.search(1, "query", 5, scope.groups), []);
  assert.deepEqual(reads, []);
  await assert.rejects(app.rebuildIndexForVisibleItems(win), /没有可索引/);

  selected = null;
  visible = [one, two, other, unfiled];
  scope = await app.getReferenceScope(win);
  assert.deepEqual(scope.groups.find((group) => group.collectionID === null).items, [unfiled]);
  assert.deepEqual(await app.rebuildIndexForVisibleItems(win), { total: 4, indexed: 2, skipped: 2, failures: [] });
  assert.ok(files.has(getIndexPath(1)));
  assert.ok(files.has(getIndexPath(1, 20)));
  const all = await store.search(1, "query", 1, scope.groups);
  assert.ok(all.length <= 3);
  assert.equal(files.get(legacy), "Legacy whole-library file must not be parsed or modified");
  assert.ok(!reads.includes(legacy));

  // Simulate removing a paper from a collection without rebuilding its file.
  reads.length = 0;
  const filtered = await store.search(1, "query", 5, [{ collectionID: 11, name: "Child", items: [two] }]);
  assert.ok(filtered.every((result) => result.itemID === 2));
  selected = child;
  app.rerankReferences = async (query, candidates) => candidates;
  reads.length = 0;
  const scopedResults = await app.searchReferences(win, "query");
  assert.ok(scopedResults.length > 0);
  assert.deepEqual(reads, [getIndexPath(1, 11)], "The actual search action must use the selected collection");
  selected = empty;
  reads.length = 0;
  await assert.rejects(app.searchReferences(win, "query"), /没有可检索/);
  assert.deepEqual(reads, []);
  const missing = item(99, [11]);
  await store.search(1, "query", 5, [{ collectionID: 11, name: "Child", items: [two, missing] }]);
  assert.deepEqual(store._missingScopes, ["Child"]);
  files.set(getIndexPath(1, 20), "broken json");
  await assert.rejects(store.load(1, 20), /读取索引失败/);
  assert.equal(files.get(getIndexPath(1, 20)), "broken json", "Read failures must not overwrite a saved file");

  selected = null;
  visible = [one, two];
  const failedStore = new IndexStore(client, {
    async getTextForItem() { throw new Error("Missing PDF attachment"); }
  });
  app.indexStore = failedStore;
  const failedResult = await app.rebuildIndexForVisibleItems(win);
  assert.equal(failedResult.total, 2);
  assert.equal(failedResult.indexed, 0);
  assert.equal(failedResult.skipped, 0);
  assert.equal(failedResult.failures.length, 2, "A paper in two collections must count as only one failed paper");
  assert.match(failedResult.failures[0], /Missing PDF attachment/);
  assert.equal(Object.keys(JSON.parse(files.get(getIndexPath(1, 10))).items).length, 1,
    "A failed rebuild must preserve the previous collection entries");

  visible = [];
  assert.deepEqual(await app.getVisibleRegularItems(win), []);
  win.ZoteroPane.getSortedItems = () => { throw new Error("View unavailable"); };
  await assert.rejects(app.getVisibleRegularItems(win), /读取当前文献视图失败/);
  console.log("Collection isolation, hierarchy, deduplication, cache and legacy preservation tests passed");
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
