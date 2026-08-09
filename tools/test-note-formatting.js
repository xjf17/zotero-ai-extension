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
