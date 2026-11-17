const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const config = { label: "Embedding", model: "test-model", baseURL: "https://unit.test/v1", format: "openai" };
const context = {
  ZoteroAIShared: {
    DEFAULTS: { requestTimeoutMs: 60000, requestMaxAttempts: 3 },
    isOpenRouterURL: () => false
  },
  setTimeout() {},
  Zotero: { debug() {} }
};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../content/modules/ai-client.js"), "utf8"), context);
const Client = context.ZoteroAIShared.OpenAICompatibleClient;

async function main() {
  const client = new Client();
  client.ensureConfigured = () => config;
  let response = { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] };
  client.request = async () => response;
  assert.equal(JSON.stringify(await client.embed(["first", "second"])), "[[1,2],[3,4]]");
  response = { data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] };
  assert.equal(JSON.stringify(await client.embed(["first", "second"])), "[[1,2],[3,4]]");
  const invalid = [
    [{}, /缺少 data 数组/],
    [{ data: [] }, /发送 2 个片段，收到 0 个向量/],
    [{ data: [{ embedding: [1, 2] }] }, /数量不匹配/],
    [{ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }, /向量索引异常/],
    [{ data: [{ embedding: [] }, { embedding: [] }] }, /向量无效/],
    [{ data: [{ embedding: [1] }, { embedding: [1, 2] }] }, /向量无效/],
    [{ data: [{ embedding: [NaN] }, { embedding: [1] }] }, /向量无效/]
  ];
  for (const [payload, error] of invalid) {
    response = payload;
    await assert.rejects(client.embed(["first", "second"]), error);
  }

  for (const status of [200, 401, 429, 500]) {
    context.fetch = async () => ({
      ok: status === 200, status,
      text: async () => JSON.stringify({ error: { message: "Provider diagnostic reason" } })
    });
    await assert.rejects(client.requestOnce(config, "/embeddings", { input: ["full input"] }),
      new RegExp(`Embedding API ${status}: Provider diagnostic reason`));
  }
  context.fetch = async () => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({ error: { message: "Provider returned error", metadata: { raw: "Batch input limit exceeded" } } })
  });
  await assert.rejects(client.requestOnce(config, "/embeddings", {}), /服务商详情: Batch input limit exceeded/);
  context.fetch = async () => ({
    ok: true, status: 200,
    text: async () => { throw new Error("Content-Length header of network response exceeds response Body."); }
  });
  await assert.rejects(client.requestOnce(config, "/embeddings", {}), /Content-Length/);

  const retryClient = new Client();
  retryClient.ensureConfigured = () => config;
  retryClient.sleep = async () => {};
  let attempts = 0;
  retryClient.requestOnce = async () => {
    attempts++;
    const error = new Error("Provider rate limit diagnostic");
    error.status = 429;
    throw error;
  };
  await assert.rejects(retryClient.request("embedding", "/embeddings", {}), /Provider rate limit diagnostic/);
  assert.equal(attempts, 3);
  console.log("Embedding response validation and provider error tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
