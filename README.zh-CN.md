# Zotero AI Assistant 中文说明

这是一个面向 Zotero 7-9 的 AI 辅助插件。插件通过 OpenRouter 调用聊天模型和 embedding 模型，在 Zotero 右侧功能图标栏常驻三个入口：

- 读取论文
- 查找引用
- 回答笔记问题

插件的核心设计不是把 PDF 直接交给 embedding 模型处理，而是先获得 PDF 文本，再在本地切分文本块，然后按功能需要调用聊天模型或 embedding 模型。

## 一、插件总体结构

### 1. 启动与窗口注入

相关文件：

- `bootstrap.js`
- `content/zotero-ai.js`
- `content/toolbar.css`

输入：

- Zotero 启动插件时传入的插件信息，包括插件 id、版本号和 rootURI。
- Zotero 当前主窗口或 PDF 阅读窗口。

处理逻辑：

1. Zotero 加载插件后执行 `bootstrap.js` 中的生命周期函数。
2. `bootstrap.js` 注册插件 chrome 路径和设置页。
3. `bootstrap.js` 加载 `content/zotero-ai.js`。
4. 插件实例挂载到 `Zotero.ZoteroAI`，方便设置页和搜索面板调用主逻辑。
5. 当 Zotero 主窗口加载或切换界面时，插件扫描右侧 `sidenav` 功能栏。
6. 找到右侧功能栏后，插入三个 AI 图标按钮。
7. MutationObserver 继续监听 Zotero UI 变化。如果右侧栏被 Zotero 重新渲染，插件会再次尝试注入按钮。

输出：

- Zotero 条目页和论文阅读页右侧功能栏中出现三个常驻按钮。
- 右键菜单保留辅助入口。

用户操作：

打开 Zotero 或切换到 PDF 阅读界面后，直接使用右侧三个 AI 按钮即可。

## 二、功能一：读取论文

入口：

- 点击右侧第一个按钮“读取论文”。
- 或在文献条目上使用右键菜单中的 AI 读取论文入口。

用户输入：

- 当前打开的 PDF，或当前选中的 Zotero 文献条目。
- 该文献条目下应有 PDF 附件。
- 设置页中应填写 OpenRouter API Key。
- 设置页中应选择聊天模型和 PDF 模式。

程序输入：

- Zotero 文献 item。
- PDF attachment。
- Zotero 已索引的 PDF 全文或逐页文本。
- 必要时的 OpenRouter PDF parser/OCR fallback 结果。
- 设置项：聊天模型、PDF 模式、摘要最多片段数、摘要排除末尾页数。

处理步骤：

1. `handleReadPaper()` 启动读取论文流程。
2. 插件立即创建 Zotero 原生进度窗口，显示当前正在执行的步骤。
3. 插件优先从当前 PDF reader 反推父文献。如果当前不在 reader 中，则使用 Zotero 当前选中的普通文献条目。
4. 插件查找该文献下最合适的 PDF 附件。
5. 插件优先读取 Zotero 本地索引文本：
   - 先尝试逐页全文。
   - 再尝试整篇全文。
   - 再尝试读取 Zotero fulltext cache。
   - 再尝试 Zotero PDF worker。
   - 必要时请求 Zotero 建立全文索引后再次读取。
6. 如果本地文本不可用，并且设置中的 PDF 模式允许 OpenRouter PDF parser/OCR，则插件读取 PDF 文件并调用 OpenRouter fallback。
7. 如果拿到了逐页文本，插件会按照“摘要排除末尾页数”去掉最后若干页，常用于排除参考文献。
8. 插件把剩余论文文本切成摘要片段。每个片段大约 5000 字符。
9. “摘要最多片段数”控制最多送入多少个片段。设置为 `0` 表示不限制片段数。
10. `summarizePaperV2()` 组合文献元数据、文本来源、页码范围和论文正文片段，调用 OpenRouter 聊天模型。
11. 模型返回 Markdown 格式的中文结构化论文阅读笔记。
12. 插件清理模型输出开头不需要的说明文字。
13. 插件把 Markdown 转换成 Zotero note 可以直接识别的 HTML。
14. 插件在原文献条目下创建一条子笔记。
15. 流程完成后关闭进度窗口。

输出：

- 一个新的 Zotero 子笔记。
- 笔记开头包含模型标识，例如 `(gemini-3.6-flash)`。
- 模型标识后直接接一段或数段文章主要贡献概括。
- 后续是结构化中文论文阅读笔记。

常见失败原因：

- 当前没有选中文献，也没有打开可识别的 PDF。
- 文献条目下没有 PDF 附件。
- Zotero 没有索引到 PDF 文本。
- PDF 模式没有启用 OpenRouter fallback。
- OpenRouter API Key 缺失或模型调用失败。

## 三、功能二：查找引用

入口：

- 点击右侧第二个按钮“查找引用”。
- 或使用右键菜单中的 AI 查找引用入口。

用户输入：

- 在弹出的查找引用面板中输入一句想法、论点、研究判断或中文表达。
- 可点击“重建当前视图索引”更新当前 Zotero 视图中文献的向量索引。

程序输入：

- 用户输入的查询句。
- 当前 Zotero 视图中的文献条目。
- 每篇文献的 PDF 文本。
- OpenRouter embedding 模型。
- OpenRouter 聊天模型。
- 本地向量索引文件。

打开面板的步骤：

1. 第二个按钮调用 `openSearchPanel()`。
2. 插件打开 `content/search.xhtml`。
3. `content/search.js` 从窗口参数中取得主插件实例和原 Zotero 窗口。
4. 搜索面板绑定三个操作：查找引用、重建索引、清空。

重建索引的步骤：

1. 用户点击“重建当前视图索引”。
2. 搜索面板调用 `rebuildIndexForVisibleItems()`。
3. 插件读取当前 Zotero 视图中的普通文献条目。
4. 对每篇文献查找 PDF 附件。
5. 对每个 PDF 提取全文。
6. `chunkText()` 按段落和长度把文本切成语义块。
7. 插件批量调用 OpenRouter embedding API。
8. 插件把每个文本块及其 embedding 存入本地索引。
9. 索引保存在 Zotero storage 目录下的 `zotero-ai-assistant/index-<libraryID>.json`。

索引中的主要内容：

- Zotero library id。
- Zotero item id。
- PDF attachment id。
- 文献标题。
- 作者。
- 年份。
- 文本 hash。
- embedding 模型 id。
- 文本块内容。
- 文本块 embedding。

查找引用的步骤：

1. 用户输入一句想法并点击“查找引用”。
2. 搜索面板调用 `searchReferences()`。
3. 插件加载当前 library 的本地向量索引。
4. 如果索引为空，插件会提示是否为当前视图重建索引。
5. 插件对用户查询句调用 embedding 模型，得到 query embedding。
6. 插件计算 query embedding 和本地文本块 embedding 的 cosine similarity。
7. 插件取相似度靠前的候选文本块。
8. `rerankReferences()` 把候选文献信息、相似度和摘录整理后发送给聊天模型。
9. 聊天模型根据用户想法对候选文献重排，并输出推荐理由和典型原文摘录。
10. 如果模型输出的 JSON 无法解析，插件回退到相似度排序结果。
11. 搜索面板渲染最终推荐结果。

输出：

- 搜索面板中显示推荐文献。
- 每条结果包含标题、作者、年份、相似度分数、推荐理由和原文摘录。
- 用户可以复制摘录。
- 结果不会自动写入 Zotero note。

常见失败原因：

- 用户查询为空。
- 当前视图没有可索引的文献。
- 文献没有 PDF 附件或无法提取文本。
- OpenRouter embedding 模型调用失败。
- 本地索引与当前 embedding 模型不一致，需要重建。

## 四、功能三：回答笔记问题

入口：

- 点击右侧第三个按钮“回答笔记问题”。
- 或使用右键菜单中的 AI 回答笔记问题入口。

用户输入：

- 当前正在编辑或选中的 Zotero note。
- note 中需要包含一个尚未回答的问题。

支持的问题写法：

```text
Q: 这篇论文最核心的方法创新是什么？
```

也支持：

```text
Question: 这篇论文适合引用在哪一类论证中？
问题: 作者的实验设计有什么局限？
```

程序输入：

- 当前 note 的 HTML 内容。
- note 转换后的纯文本。
- note 所属父文献。
- 同一父文献下的其他 child notes。
- 父文献 PDF 的完整正文。
- OpenRouter 聊天模型和 embedding 模型。

识别“最新未回答问题”的逻辑：

1. 插件把 note HTML 转换成纯文本。
2. 插件扫描问题标记和回答标记。
3. 问题标记包括 `Q:`、`Question:`、`问题:`。
4. 回答标记包括 `Answer:`、`回答:`。
5. 插件从 note 末尾向前查找最近的问题标记。
6. 如果这个问题后面已经存在回答标记，插件认为这个问题已经被回答。
7. 如果这个问题后面没有回答标记，插件把它作为当前要回答的问题。
8. 如果最新问题已回答，用户需要在 note 末尾继续写新的 `Q:`。

处理步骤：

1. `handleAnswerNote()` 启动笔记问答流程。
2. 插件立即显示 Zotero 原生进度窗口。
3. 插件优先读取当前 note editor 中正在编辑的 note。
4. 如果无法从 note editor 获取，则读取当前选中的 Zotero note。
5. 插件提取最新未回答问题。
6. 如果 note 有父文献，插件读取同一文献下的其他子笔记，作为论文摘要和已有笔记上下文。
7. 插件尝试读取父文献 PDF 完整正文。
8. 插件不再对功能三调用 embedding，也不再只选最相关的 PDF 片段。
9. `answerLatestQuestion()` 把 PDF 完整正文放在最前面。
10. 插件在 PDF 正文后接当前 note 内容和同一父文献下的关联笔记。
11. 插件把这些内容组合成一条完整 user message，再把最新问题放在最后。
12. 聊天模型返回中文回答。
13. 插件把回答 Markdown 转为 Zotero note HTML。
14. 插件把 `Answer:` 和回答内容追加到原 note 末尾。
15. 流程完成后关闭进度窗口。

输出：

- 当前 note 末尾追加一个 `Answer:` 小节。
- 回答内容是 Zotero note 可直接识别的 HTML 样式。
- 回答会尽量基于 PDF 完整正文、当前 note 和关联笔记。

常见失败原因：

- 当前没有打开或选中 note。
- note 中没有 `Q:`、`Question:` 或 `问题:`。
- 最新问题后面已经有 `Answer:` 或 `回答:`。
- OpenRouter API Key 缺失。
- 聊天模型调用失败。

## 五、设置页说明

相关文件：

- `content/preferences-pane.xhtml`
- `content/preferences-pane.js`
- `content/preferences-pane.css`
- `prefs.js`

设置项都存储在 `extensions.zotero-ai.*` 下。

### OpenRouter API Key

输入：

- 用户填写的 OpenRouter API Key。

用途：

- 聊天模型调用。
- embedding 模型调用。
- OpenRouter PDF parser/OCR fallback。

输出：

- 保存到 Zotero preference 中。

### 聊天模型

输入：

- 下拉选择的模型，或自定义 model id。

用途：

- 论文摘要。
- 引用查找重排。
- 笔记问答。
- PDF parser/OCR fallback。

输出：

- OpenRouter chat completion 请求中的 `model`。

### Embedding 模型

输入：

- 下拉选择的 embedding 模型，或自定义 embedding model id。

用途：

- 第二个功能的本地向量索引。
- 第二个功能的引用检索，以及其他需要语义召回的上下文检索。

输出：

- OpenRouter embeddings 请求中的 `model`。

### PDF 模式

可选值：

- 本地文本优先。
- OpenRouter PDF parser/OCR。

处理逻辑：

- 本地文本优先时，插件只在 Zotero 已索引文本里查找 PDF 文本。
- OpenRouter PDF parser/OCR 模式下，本地文本失败后允许把 PDF 作为 fallback 交给 OpenRouter 解析。

### 摘要最多片段数

含义：

- 只影响第一个功能“读取论文”。
- 控制最多送给聊天模型多少个摘要文本块。
- 每个摘要文本块约 5000 字符。

建议：

- `0` 表示不限制片段数，尽量读取完整可用文本。
- 如果模型上下文或费用压力较大，可以设置为较小数字。

### 摘要排除末尾页数

含义：

- 只影响第一个功能“读取论文”。
- 当 Zotero 能提供逐页文本时，插件会在摘要前排除 PDF 最后若干页。
- 这个设置常用于跳过参考文献页。

建议：

- 想默认读取除了最后两页外的内容，设置为 `2`。
- 想默认全读取，设置为 `0`。

限制：

- 只有在 Zotero 能提供逐页文本时，这个设置才精确按页生效。
- 如果只能拿到整篇纯文本，插件无法可靠判断最后两页的位置。

### 引用结果数量

含义：

- 只影响第二个功能“查找引用”。
- 控制语义召回和最终展示的引用推荐数量。

输出：

- 搜索面板中最多展示对应数量的候选引用结果。

## 六、进度反馈

相关逻辑：

- `createProgressHandle()`

输入：

- 当前 Zotero window。
- 当前操作说明文字。

处理步骤：

1. 插件创建 Zotero 原生 `Zotero.ProgressWindow`。
2. 进度窗口标题显示为 `Zotero AI`。
3. 窗口中显示一行当前操作状态。
4. 每个关键步骤通过 `progress.update()` 更新文字。
5. 操作完成、失败或被中断后，调用 `progress.close()` 关闭窗口。

输出：

- 一个 Zotero 原生进度提示窗口。
- 操作结束后自动关闭。

三个功能都会使用这套进度反馈：

- 读取论文：显示查找文献、提取文本、调用模型、写入笔记等状态。
- 查找引用：显示加载索引、生成查询向量、语义召回、模型重排等状态。
- 回答笔记问题：显示读取 note、提取问题、读取 PDF 全文、调用模型、追加回答等状态。

## 七、本地索引与数据流

本地索引位置：

```text
<Zotero storage>/zotero-ai-assistant/index-<libraryID>.json
```

索引生成输入：

- 当前 Zotero 视图中的文献条目。
- 每篇文献的 PDF 文本。
- embedding 模型 id。

索引生成输出：

- 文献元数据。
- PDF 文本块。
- 每个文本块的 embedding。
- 文本 hash，用于判断文本是否变化。

搜索输入：

- 用户的一句话想法。
- 本地索引。

搜索输出：

- 推荐文献列表。
- 推荐理由。
- 原文摘录。

## 八、发送给 OpenRouter 的内容

会发送：

- 论文摘要时选中的论文文本片段。
- 引用查找时的查询句。
- 引用重排时的候选文献信息和摘录。
- 建立索引时的 PDF 文本块。
- 笔记问答时的 PDF 完整正文、note 上文和关联 note 文本。
- PDF parser/OCR fallback 时的 PDF 内容。

不会自动发送：

- Zotero 整个文献库。
- 没有进入当前操作流程的文献全文。

会写入 Zotero：

- 第一个功能生成的新论文阅读 note。
- 第三个功能追加到当前 note 末尾的回答。

不会自动写入 Zotero：

- 第二个功能的引用查找结果。

## 九、开发与打包

常用命令：

```powershell
npm run validate
npm run build
npm run diagnose
```

输出文件：

```text
dist/zotero-ai-assistant-0.1.19.xpi
```

安装测试步骤：

1. 运行 `npm run build`。
2. 打开 Zotero。
3. 进入 `Tools -> Plugins`。
4. 将 `dist/zotero-ai-assistant-0.1.19.xpi` 拖入插件窗口。
5. 按 Zotero 提示重启。

## 十、当前实现边界

1. OpenRouter embedding API 处理的是文本，不是完整 PDF 的一站式向量化。
2. 插件采用本地 RAG 流程：PDF 文本提取、文本切块、embedding、向量召回、聊天模型重排。
3. 右侧按钮注入依赖 Zotero UI 的 `sidenav` 结构。不同 Zotero 版本 UI 结构可能有差异，所以代码会扫描多个候选位置并监听界面变化。
4. 第二个功能需要先建立索引。索引为空时，搜索面板会提示重建当前视图索引。
5. 第三个功能只回答最新未回答问题。它用 `Q:` 和 `Answer:` 等标记判断问题是否已经回答。
