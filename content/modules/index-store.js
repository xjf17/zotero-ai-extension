(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
  const {
    DEFAULTS,
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

  function getIndexPath(libraryID) {
    const safeID = String(libraryID || "default").replace(/[^a-z0-9_-]/gi, "_");
    return PathUtils.join(getDataDirectory(), `index-${safeID}.json`);
  }

  async function readJSON(path, fallback) {
    try {
      if (!(await IOUtils.exists(path))) {
        return fallback;
      }
      return JSON.parse(await IOUtils.readUTF8(path));
    }
    catch (err) {
      Zotero.debug(`Zotero AI Assistant: failed reading ${path}: ${err}`);
      return fallback;
    }
  }

  async function writeJSON(path, value) {
    await IOUtils.writeUTF8(path, JSON.stringify(value, null, 2), {
      tmpPath: `${path}.tmp`
    });
  }

  class IndexStore {
    constructor(client, textSource) {
      this.client = client;
      this.textSource = textSource;
      this._modelChangedOnLoad = false;
    }

    async load(libraryID) {
      this._modelChangedOnLoad = false;
      const index = await readJSON(getIndexPath(libraryID), {
        version: 1,
        libraryID,
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

    async save(libraryID, index) {
      index.version = 1;
      index.libraryID = libraryID;
      index.embeddingModel = this.client.embeddingModel;
      await writeJSON(getIndexPath(libraryID), index);
    }

    async clear(libraryID) {
      await this.save(libraryID, {
        version: 1,
        libraryID,
        embeddingModel: this.client.embeddingModel,
        items: {}
      });
    }

    async rebuildItems(items, progressCallback, chunkOptions = {}) {
      const byLibrary = new Map();
      for (const item of items) {
        const libraryID = item.libraryID || "default";
        if (!byLibrary.has(libraryID)) {
          byLibrary.set(libraryID, []);
        }
        byLibrary.get(libraryID).push(item);
      }

      let indexed = 0;
      const failures = [];
      for (const [libraryID, libraryItems] of byLibrary.entries()) {
        const index = await this.load(libraryID);
        for (let i = 0; i < libraryItems.length; i++) {
          const item = libraryItems[i];
          progressCallback?.(`正在索引 ${i + 1}/${libraryItems.length}: ${truncateTitle(getItemTitle(item))}`);
          try {
            await this.indexItem(index, item, chunkOptions);
            indexed++;
          }
          catch (err) {
            failures.push(`${truncateTitle(getItemTitle(item))}: ${err.message || err}`);
            Zotero.debug(`Zotero AI Assistant: index failed for item ${item.id}: ${err}\n${err.stack}`);
          }
        }
        await this.save(libraryID, index);
      }
      return { indexed, failures };
    }

    async indexItem(index, item, chunkOptions = {}) {
      const { text, attachmentID, source } = await this.textSource.getTextForItem(item);
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

      const embeddings = await this.embedChunks(chunks);

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

    async embedChunks(chunks) {
      const batchSize = Math.max(1, DEFAULTS.embedBatchSize || 24);
      const concurrency = Math.max(1, DEFAULTS.embedConcurrentRequests || 1);
      const batches = [];
      for (let start = 0; start < chunks.length; start += batchSize) {
        batches.push({
          index: batches.length,
          texts: chunks.slice(start, start + batchSize)
        });
      }

      const results = new Array(batches.length);
      let next = 0;
      const workers = Array.from(
        { length: Math.min(concurrency, batches.length) },
        async () => {
          while (next < batches.length) {
            const batch = batches[next++];
            results[batch.index] = await this.client.embed(batch.texts);
          }
        }
      );
      await Promise.all(workers);
      return results.flat();
    }

    async ensureItemsIndexed(items, progressCallback) {
      const missing = [];
      const byLibrary = new Map();
      for (const item of items) {
        const libraryID = item.libraryID || "default";
        if (!byLibrary.has(libraryID)) {
          byLibrary.set(libraryID, await this.load(libraryID));
        }
        const index = byLibrary.get(libraryID);
        if (!index.items?.[item.id]) {
          missing.push(item);
        }
      }
      if (!missing.length) {
        return { indexed: 0, failures: [] };
      }
      progressCallback?.(`当前视图有 ${missing.length} 篇文献尚未索引，正在补建...`);
      return this.rebuildItems(missing, progressCallback);
    }

    async search(libraryID, query, topK = DEFAULTS.referenceTopK) {
      const index = await this.load(libraryID);
      const queryEmbedding = (await this.client.embed(query))[0];
      const scored = [];

      for (const itemEntry of Object.values(index.items || {})) {
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
          }
        }
      }

      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topK * 3);
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
