const assert = require("assert");
const {
  markdownToNoteHTML,
  normalizeMathDelimiters,
  normalizeAPIBaseURL
} = require("../content/zotero-ai.js");

const bracketBlock = String.raw`\[
\mathbf p_i \oplus \mathbf p_i^k \oplus (\mathbf p_i-\mathbf p_i^k) \oplus \|\mathbf p_i-\mathbf p_i^k\|
\]`;
assert.strictEqual(
  markdownToNoteHTML(bracketBlock),
  String.raw`<pre class="math">$$\mathbf p_i \oplus \mathbf p_i^k \oplus (\mathbf p_i-\mathbf p_i^k) \oplus \|\mathbf p_i-\mathbf p_i^k\|$$</pre>`
);

const dollarBlock = String.raw`$$
a & b
$$`;
assert.strictEqual(
  markdownToNoteHTML(dollarBlock),
  String.raw`<pre class="math">$$a &amp; b$$</pre>`
);

const inline = String.raw`向量 \(\mathbf p_i\) 与 $x_i^2$。`;
assert.strictEqual(
  markdownToNoteHTML(inline),
  String.raw`<p>向量 <span class="math">$\mathbf p_i$</span> 与 <span class="math">$x_i^2$</span>。</p>`
);

assert.strictEqual(
  markdownToNoteHTML("代码 `$x$` 不应转换。"),
  String.raw`<p>代码 <code>$x$</code> 不应转换。</p>`
);

const table = [
  "| 组件 | 默认配置 |",
  "|---|---|",
  "| 序列化模式 | Z-order、Trans Z-order |",
  "| Patch 交互 | Shift Order + Shuffle Order |"
].join("\n");
const tableHTML = markdownToNoteHTML(table);
assert.ok(tableHTML.includes("<table"));
assert.ok(tableHTML.includes("<th"));
assert.ok(tableHTML.includes("<td"));
assert.ok(tableHTML.includes("序列化模式"));
assert.ok(!tableHTML.includes("<p>| 组件"));

const nestedList = [
  "- **效率瓶颈**:",
  "  - 基于 K 近邻的邻域搜索约占前向传播时间的28%。",
  "  - 点云相对位置编码需要计算成对欧氏距离。",
  "- **研究目标**: 提升整体性能。"
].join("\n");
const nestedListHTML = markdownToNoteHTML(nestedList);
assert.ok(nestedListHTML.includes("<strong>效率瓶颈</strong>:<ul>"));
assert.ok(nestedListHTML.includes("基于 K 近邻"));
assert.ok(nestedListHTML.indexOf("<strong>研究目标</strong>") > nestedListHTML.indexOf("</ul>"));

assert.strictEqual(
  normalizeMathDelimiters(String.raw`行内 \(x_i\)，块级 \[y_i^2\]。`),
  "行内 $x_i$，块级 $$\ny_i^2\n$$。"
);

assert.strictEqual(
  normalizeAPIBaseURL("api.openai.com/v1/chat/completions"),
  "https://api.openai.com/v1"
);
assert.strictEqual(
  normalizeAPIBaseURL("https://openrouter.ai/api/v1/"),
  "https://openrouter.ai/api/v1"
);

console.log("Note formula formatting tests passed");
