(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
  const {
    DEFAULTS,
    pref,
    cosineSimilarity,
    chunkText,
    hashText,
    getItemTitle,
    truncateTitle,
    getCreators
  } = ns;

  function getDataDirectory() {
    const dir = Zotero.getStorageDirectory().clone();
    dir.append("zotero-ai-assistant");
    if (!dir.exists()) {
      dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
    }
    return dir.path;
  }

  function getIndexPath(libraryID, collectionID = null) {
    const safeID = String(libraryID || "default").replace(/[^a-z0-9_-]/gi, "_");
    const scope = collectionID == null ? "unfiled" : `collection-${Number(collectionID)}`;
    if (collectionID != null && (!Number.isSafeInteger(Number(collectionID)) || Number(collectionID) <= 0)) {
      throw new Error("无效的分类 ID。");
    }
    return PathUtils.join(getDataDirectory(), `index-${safeID}-${scope}.json`);
  }

  async function readJSON(path, fallback) {
    try {
      if (!(await IOUtils.exists(path))) {
        return fallback;
      }
      return JSON.parse(await IOUtils.readUTF8(path));
    }
    catch (err) {
      throw new Error(`读取索引失败 ${path}: ${err.message || err}`);
    }
  }

  async function writeJSON(path, value) {
    await IOUtils.writeUTF8(path, JSON.stringify(value), {
      tmpPath: `${path}.tmp`
    });
  }

  class IndexStore {
    constructor(client, textSource) {
      this.client = client;
      this.textSource = textSource;
      this._modelChangedOnLoad = false;
    }

    async load(libraryID, collectionID = null) {
      this._modelChangedOnLoad = false;
      const index = await readJSON(getIndexPath(libraryID, collectionID), {
        version: 2,
        libraryID,
        collectionID,
        embeddingModel: this.client.embeddingModel,
        items: {}
      });
      if (index.embeddingModel !== this.client.embeddingModel) {
        this._modelChangedOnLoad = true;
        index.embeddingModel = this.client.embeddingModel;
        index.items = {};
      }
      return index;
    }

    async save(libraryID, index, collectionID = null) {
      index.version = 2;
      index.libraryID = libraryID;
      index.collectionID = collectionID;
      index.embeddingModel = this.client.embeddingModel;
      await writeJSON(getIndexPath(libraryID, collectionID), index);
    }

    async clear(libraryID, collectionID = null) {
      await this.save(libraryID, {
        version: 1,
        libraryID,
        embeddingModel: this.client.embeddingModel,
        items: {}
      }, collectionID);
    }

    createEmbeddingQueue() {
      const value = Number(pref("embedConcurrentRequests", DEFAULTS.embedConcurrentRequests));
      const concurrency = Number.isSafeInteger(value) && value > 0
        ? value
        : DEFAULTS.embedConcurrentRequests;
      const size = Number(pref("embedBatchSize", DEFAULTS.embedBatchSize));
      let active = 0;
      const waiting = [];
      return {
        concurrency,
        batchSize: Number.isSafeInteger(size) && size > 0 ? size : DEFAULTS.embedBatchSize,
        embed: async (texts) => {
          if (active >= concurrency) {
            await new Promise((resolve) => waiting.push(resolve));
          }
          else {
            active++;
          }
          try {
            return await this.client.embed(texts);
          }
          finally {
            // Hand the occupied slot directly to the next waiting request.
            const next = waiting.shift();
            if (next) {
              next();
            }
            else {
              active--;
            }
          }
        }
      };
    }

    async rebuildItems(items, progressCallback, chunkOptions = {}, collectionID = null) {
      const byLibrary = new Map();
      for (const item of items) {
        const libraryID = item.libraryID || "default";
        if (!byLibrary.has(libraryID)) {
          byLibrary.set(libraryID, []);
        }
        byLibrary.get(libraryID).push(item);
      }

      let indexed = 0;
      let skipped = 0;
      const failures = [];
      const updatedIDs = [];
      const reusedIDs = [];
      const itemFailures = [];
      const embeddingQueue = this.createEmbeddingQueue();
      for (const [libraryID, libraryItems] of byLibrary.entries()) {
        const index = await this.load(libraryID, collectionID);
        let next = 0;
        let completed = 0;
        progressCallback?.(`正在索引 0/${libraryItems.length}，并发 ${embeddingQueue.concurrency}，每批最多 ${embeddingQueue.batchSize} 个片段`);
        const workers = Array.from(
          { length: Math.min(embeddingQueue.concurrency, libraryItems.length) },
          async () => {
            while (next < libraryItems.length) {
              const item = libraryItems[next++];
              try {
                const previous = index.items[item.id];
                const entry = await this.indexItem(index, item, chunkOptions, embeddingQueue);
                if (entry === previous) {
                  skipped++;
                  reusedIDs.push(item.id);
                }
                else {
                  indexed++;
                  updatedIDs.push(item.id);
                }
              }
              catch (err) {
                const message = `文献 ${item.id}「${getItemTitle(item)}」: ${err?.message || String(err)}`;
                failures.push(message);
                itemFailures.push({ itemID: item.id, message });
                Zotero.debug(`Zotero AI Assistant: index failed for item ${item.id}: ${err}\n${err?.stack || ""}`);
              }
              completed++;
              progressCallback?.(`已处理 ${completed}/${libraryItems.length}，新建/更新 ${indexed}，复用 ${skipped}，失败 ${failures.length}: ${truncateTitle(getItemTitle(item))}`);
            }
          }
        );
        await Promise.all(workers);
        await this.save(libraryID, index, collectionID);
      }
      return { indexed, skipped, failures, updatedIDs, reusedIDs, itemFailures };
    }

    async indexItem(index, item, chunkOptions = {}, embeddingQueue) {
      let extracted;
      try {
        extracted = await this.textSource.getTextForItem(item);
      }
      catch (err) {
        throw new Error(`读取 PDF 文本失败: ${err?.message || String(err)}`);
      }
      const { text, attachmentID, source } = extracted;
      const textHash = hashText(text);
      const chunkKey = `${chunkOptions.chunkSize || DEFAULTS.chunkSize}:${chunkOptions.chunkOverlap || DEFAULTS.chunkOverlap}`;
      const existing = index.items[item.id];
      if (
        existing &&
        existing.textHash === textHash &&
        existing.embeddingModel === this.client.embeddingModel &&
        existing.chunkKey === chunkKey &&
        Array.isArray(existing.chunks) &&
        existing.chunks.length
      ) {
        return existing;
      }

      const chunks = chunkText(text, chunkOptions);
      if (!chunks.length) {
        throw new Error(`“${getItemTitle(item)}” 没有足够的文本可索引。`);
      }

      const embeddings = await this.embedChunks(chunks, embeddingQueue);

      index.items[item.id] = {
        itemID: item.id,
        libraryID: item.libraryID,
        attachmentID,
        title: getItemTitle(item),
        creators: getCreators(item),
        year: item.getField?.("year") || item.getField?.("date") || "",
        source,
        textHash,
        chunkKey,
        embeddingModel: this.client.embeddingModel,
        indexedAt: new Date().toISOString(),
        chunks: chunks.map((chunk, idx) => ({
          id: `${item.id}-${idx}`,
          text: chunk,
          embedding: embeddings[idx]
        }))
      };
      return index.items[item.id];
    }

    async embedChunks(chunks, embeddingQueue = this.createEmbeddingQueue()) {
      const batchSize = embeddingQueue.batchSize;
      const batches = [];
      for (let start = 0; start < chunks.length; start += batchSize) {
        batches.push({
          index: batches.length,
          texts: chunks.slice(start, start + batchSize)
        });
      }

      const results = new Array(batches.length);
      let next = 0;
      let failed = false;
      const workers = Array.from(
        { length: Math.min(embeddingQueue.concurrency, batches.length) },
        async () => {
          while (!failed && next < batches.length) {
            const batch = batches[next++];
            try {
              results[batch.index] = await embeddingQueue.embed(batch.texts);
            }
            catch (err) {
              failed = true;
              throw new Error(`Embedding 批次 ${batch.index + 1}/${batches.length}（${batch.texts.length} 个片段）失败: ${err?.message || String(err)}`);
            }
          }
        }
      );
      const settled = await Promise.allSettled(workers);
      const failure = settled.find((result) => result.status === "rejected");
      if (failure) {
        throw failure.reason;
      }
      return results.flat();
    }

    async ensureItemsIndexed(items, progressCallback, collectionID = null) {
      const missing = [];
      const byLibrary = new Map();
      for (const item of items) {
        const libraryID = item.libraryID || "default";
        if (!byLibrary.has(libraryID)) {
          byLibrary.set(libraryID, await this.load(libraryID, collectionID));
        }
        const index = byLibrary.get(libraryID);
        if (!index.items?.[item.id]) {
          missing.push(item);
        }
      }
      if (!missing.length) {
        return { indexed: 0, skipped: 0, failures: [] };
      }
      progressCallback?.(`当前视图有 ${missing.length} 篇文献尚未索引，正在补建...`);
      return this.rebuildItems(missing, progressCallback, {}, collectionID);
    }

    async search(libraryID, query, topK = DEFAULTS.referenceTopK, scopes = []) {
      this._modelChangedOnLoad = false;
      this._missingScopes = [];
      if (!scopes.some((scope) => scope.items.length)) {
        return [];
      }
      const queryEmbedding = (await this.client.embed(query))[0];
      const scored = [];
      const seen = new Set();
      let modelChanged = false;
      for (const scope of scopes) {
        if (!scope.items.length) {
          continue;
        }
        // Keep only one classification index in memory at a time.
        const index = await this.load(libraryID, scope.collectionID);
        modelChanged ||= this._modelChangedOnLoad;
        const allowed = new Set(scope.items.map((item) => String(item.id)));
        if ([...allowed].some((id) => !index.items[id])) {
          this._missingScopes.push(scope.name);
        }
        for (const itemEntry of Object.values(index.items || {})) {
          const key = String(itemEntry.itemID);
          if (!allowed.has(key) || seen.has(key)) {
            continue;
          }
          seen.add(key);
          for (const chunk of itemEntry.chunks || []) {
            const score = cosineSimilarity(queryEmbedding, chunk.embedding);
            if (Number.isFinite(score)) {
              scored.push({
                score,
                itemID: itemEntry.itemID,
                title: itemEntry.title,
                creators: itemEntry.creators,
                year: itemEntry.year,
                text: chunk.text
              });
              scored.sort((a, b) => b.score - a.score);
              if (scored.length > topK * 3) {
                scored.length = topK * 3;
              }
            }
          }
        }
      }
      this._modelChangedOnLoad = modelChanged;
      return scored;
    }
  }

  Object.assign(ns, {
    getDataDirectory,
    getIndexPath,
    readJSON,
    writeJSON,
    IndexStore
  });
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
