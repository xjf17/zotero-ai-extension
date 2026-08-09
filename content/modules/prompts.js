(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
  const { MATH_OUTPUT_INSTRUCTIONS } = ns;

  const PROMPTS = {
  "pdfExtractionUserText": "请提取这篇 PDF 的正文文本。尽量保留标题、摘要、章节标题、图表说明和关键段落。不要总结，不要编造。",
  "annotationVisionQuestionPrefix": "请根据以上上下文和图片回答：",
  "annotationVisionDefaultQuestion": "请详细解释上图中的图表或公式，包括其含义、关键参数和在论文中的作用。",
  "annotationVisionSystem": "你是学术论文图表和公式解释助手。请根据提供的页面文字上下文和图像，详细解释图表或公式的含义、关键参数和在论文中的作用。回答应准确、完整，基于提供的材料。",
  "paperSummarySystem": "你是严谨的中文学术阅读助手。只能根据用户提供的论文文本总结，不要编造。输出清晰的中文结构化笔记。你的回答务必完整，列出所有要点之后再停止。",
  "paperSummaryLabels": {
    "title": "论文标题: ",
    "creators": "作者: ",
    "source": "文本来源: ",
    "unknown": "未知"
  },
  "paperSummaryInstructions": [
    "请根据这篇文章的类型生成中文论文阅读笔记。如果这篇文章是以介绍方法为主的文章，则你的摘要应该包含:",
    "1. 研究问题及解决的核心方法挑战",
    "2. 核心方法",
    "3. 研究数据/实验设计/评价指标",
    "4. 最终结果及主要应用",
    "5. 可启发后续方法设计的重要观点",
    "6. 局限与可追问问题",
    "对于方法类文章，要对方法部分详细展开，其余部分可适当",
    "如果这篇文章是以研究发现/新知识/新结论/新领域为主的文章，则你的摘要应该主要包含：",
    "1. 研究问题与意义",
    "2. 研究方法",
    "3. 研究数据/实验设计",
    "4. 主要发现",
    "5. 可引用的主要观点",
    "6. 局限与可追问问题",
    "如果你不能判断这个文章的类型，或者判断这个文章不是上述任何一个类型，比如是文献综述类/评述类或者其它类被的文章，你只需要按照文章的主要结构，逐节概括一下主要内容即可", 
    
  ],
  "paperSummaryV2System": "你是严谨的中文学术阅读助手。只能根据用户提供的论文文本总结，不要编造。输出 Markdown，但不要输出开场套话，不要以“这是一份...”开头，不要在最前面输出横线。你的回答务必完整，不要遗漏任何细节。",
  "paperSummaryV2Labels": {
    "title": "论文标题: ",
    "creators": "作者: ",
    "publication": "发表来源: ",
    "date": "日期: ",
    "source": "文本来源: ",
    "summaryRange": "摘要读取范围: ",
    "chunkCount": "摘要实际片段数: ",
    "unknown": "未知"
  },
  "paperSummaryV2Instructions": [
    "请生成中文结构化论文阅读笔记，格式必须严格如下：",
    "",
    "第一部分：先用3个非常简练利落的句子，概括论文的主要贡献，这个贡献可以根据文章的内容，写出其方法、知识、应用等方面的贡献，不同的文章可能贡献的侧重点有所不同。不要超过三段。不要写标题。不要写“这是一份...”。",
    "",
    "第二部分：接着写：",
    "# 论文阅读笔记：{用中文概括的论文标题}",
    "**原标题**: {英文原标题}",
    "**作者**: {作者}",
    "**发表期刊**: {发表来源和年份，如果无法判断就写未知}",
    "",
    "---",
    "",
    "下边需要写出文章的阅读笔记，如果这篇文章是以介绍方法为主的文章，则你的摘要应该包含:",
    "1. 研究问题及解决的核心方法挑战",
    "2. 核心方法",
    "3. 研究数据/实验设计/评价指标",
    "4. 最终结果及主要应用",
    "5. 可启发后续方法设计的重要观点",
    "6. 局限与可追问问题",
    "对于方法类文章，要对方法部分详细展开，其余部分可适当",
    "如果这篇文章是以研究发现/新知识/新结论/新领域为主的文章，则你的摘要应该主要包含：",
    "1. 研究问题与意义",
    "2. 研究方法",
    "3. 研究数据/实验设计",
    "4. 主要发现",
    "5. 可引用的主要观点",
    "6. 局限与可追问问题",
    "如果你不能判断这个文章的类型，或者判断这个文章不是上述任何一个类型，比如是文献综述类/评述类或者其它类被的文章，你只需要按照文章的主要结构，逐节概括一下主要内容即可",
    "",
    "各节内部使用 Markdown 列表和 **粗体关键词**。不要把模型型号写进正文。如需写数学公式，行内使用 $...$，独立公式使用 $$...$$。"
  ],
  "referenceRerankSystem": "你是中文学术检索助手。你会根据用户想法，从候选论文片段中挑选最适合引用的文献。必须只基于候选片段，不要编造。你的回答务必完整，不要遗漏任何细节。",
  "referenceRerankLabels": {
    "query": "用户想法: "
  },
  "referenceRerankInstructions": [
    "请从候选片段中选择最适合引用的 5 条以内结果。返回 JSON 数组，不要包含 Markdown。",
    "每项包含 id, reason, quote。",
    "reason 中如需写数学公式，行内使用 $...$，独立公式使用 $$...$$。",
    "quote 必须是候选 excerpt 中真实存在的典型原文摘录，尽量短而完整。"
  ],
  "noteQASystem": "你是中文论文阅读问答助手。回答必须优先基于 PDF 正文全文、当前笔记和关联论文摘要。证据不足时明确说明，不要编造。你的回答应该尽量完整，不遗漏任何可能与问题相关的细节，输出完整的答案。"
};

  function withMathInstructions(text) {
    return text + MATH_OUTPUT_INSTRUCTIONS;
  }

  function getPdfExtractionPrompt() {
    return PROMPTS.pdfExtractionUserText;
  }

  function buildAnnotationVisionQuestion(question) {
    return question
      ? `${PROMPTS.annotationVisionQuestionPrefix}${question}`
      : PROMPTS.annotationVisionDefaultQuestion;
  }

  function getAnnotationVisionSystemPrompt() {
    return withMathInstructions(PROMPTS.annotationVisionSystem);
  }

  function buildPaperSummaryMessages({ title, creators, source, context }) {
    const labels = PROMPTS.paperSummaryLabels;
    return [
      {
        role: "system",
        content: withMathInstructions(PROMPTS.paperSummarySystem)
      },
      {
        role: "user",
        content: [
          `${labels.title}${title}`,
          `${labels.creators}${creators || labels.unknown}`,
          `${labels.source}${source}`,
          "",
          ...PROMPTS.paperSummaryInstructions,
          "",
          context
        ].join("\n")
      }
    ];
  }

  function buildPaperSummaryV2Messages({
    title,
    creators,
    publication,
    date,
    source,
    summaryRange,
    chunkCount,
    context
  }) {
    const labels = PROMPTS.paperSummaryV2Labels;
    return [
      {
        role: "system",
        content: withMathInstructions(PROMPTS.paperSummaryV2System)
      },
      {
        role: "user",
        content: [
          `${labels.title}${title}`,
          `${labels.creators}${creators || labels.unknown}`,
          `${labels.publication}${publication || labels.unknown}`,
          `${labels.date}${date || labels.unknown}`,
          `${labels.source}${source}`,
          `${labels.summaryRange}${summaryRange}`,
          `${labels.chunkCount}${chunkCount}`,
          "",
          ...PROMPTS.paperSummaryV2Instructions,
          "",
          context
        ].join("\n")
      }
    ];
  }

  function buildReferenceRerankMessages({ query, compact }) {
    const labels = PROMPTS.referenceRerankLabels;
    return [
      {
        role: "system",
        content: PROMPTS.referenceRerankSystem
      },
      {
        role: "user",
        content: [
          `${labels.query}${query}`,
          "",
          ...PROMPTS.referenceRerankInstructions,
          "",
          JSON.stringify(compact, null, 2)
        ].join("\n")
      }
    ];
  }

  function buildNoteQAMessages(combinedContext) {
    return [
      {
        role: "system",
        content: withMathInstructions(PROMPTS.noteQASystem)
      },
      {
        role: "user",
        content: combinedContext
      }
    ];
  }

  Object.assign(ns, {
    PROMPTS,
    getPdfExtractionPrompt,
    buildAnnotationVisionQuestion,
    getAnnotationVisionSystemPrompt,
    buildPaperSummaryMessages,
    buildPaperSummaryV2Messages,
    buildReferenceRerankMessages,
    buildNoteQAMessages
  });

  if (typeof module === "object" && module.exports) {
    module.exports = ns;
  }
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
