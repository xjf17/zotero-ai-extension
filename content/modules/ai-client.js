(function (root) {
  const ns = root.ZoteroAIShared = root.ZoteroAIShared || {};
  const {
    DEFAULTS,
    DEFAULT_API_BASE_URL,
    pref,
    normalizeAPIBaseURL,
    isOpenRouterURL,
    getPdfExtractionPrompt,
    buildAnnotationVisionQuestion,
    getAnnotationVisionSystemPrompt
  } = ns;

  class OpenAICompatibleClient {
    getModelSettings(kind = "text") {
      const settings = {
        text: {
          label: "文本模型",
          formatPref: "chatAPIFormat",
          baseURLPref: "chatBaseURL",
          apiKeyPref: "chatApiKey",
          modelPref: "chatModel",
          customModelPref: "customChatModel",
          defaultModel: "deepseek/deepseek-v4-flash-0731"
        },
        multimodal: {
          label: "多模态模型",
          formatPref: "multimodalAPIFormat",
          baseURLPref: "multimodalBaseURL",
          apiKeyPref: "multimodalApiKey",
          modelPref: "multimodalModel",
          customModelPref: "customMultimodalModel",
          defaultModel: "google/gemini-3.6-flash"
        },
        embedding: {
          label: "Embedding 模型",
          formatPref: "embeddingAPIFormat",
          baseURLPref: "embeddingBaseURL",
          apiKeyPref: "embeddingApiKey",
          modelPref: "embeddingModel",
          customModelPref: "customEmbeddingModel",
          defaultModel: "nvidia/nemotron-3-embed-1b:free"
        }
      }[kind] || null;
      if (!settings) {
        throw new Error(`未知的模型类型：${kind}`);
      }

      const configuredModel = String(pref(settings.modelPref, settings.defaultModel)).trim();
      const model = configuredModel === "custom"
        ? String(pref(settings.customModelPref, "")).trim()
        : configuredModel;
      const apiKey = String(
        pref(settings.apiKeyPref, "") || pref("openrouterApiKey", "")
      ).trim();
      return {
        ...settings,
        format: pref(settings.formatPref, "openrouter") === "openai"
          ? "openai"
          : "openrouter",
        baseURL: normalizeAPIBaseURL(pref(settings.baseURLPref, DEFAULT_API_BASE_URL)),
        apiKey,
        model: model || settings.defaultModel
      };
    }

    get apiKey() {
      return this.getModelSettings("text").apiKey;
    }

    get chatModel() {
      return this.getModelSettings("text").model;
    }

    get embeddingModel() {
      return this.getModelSettings("embedding").model;
    }

    get multimodalModel() {
      return this.getModelSettings("multimodal").model;
    }

    ensureConfigured(kind = "text") {
      const config = this.getModelSettings(kind);
      if (!config.baseURL) {
        throw new Error(`请先在 Zotero 设置中填写${config.label} API 地址。`);
      }
      if (!config.model) {
        throw new Error(`请先在 Zotero 设置中填写${config.label}模型名。`);
      }
      return config;
    }

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    isRetryableRequestError(err) {
      const message = String(err?.message || err || "").toLowerCase();
      return message.includes("content-length")
        || message.includes("network")
        || message.includes("fetch")
        || message.includes("timeout")
        || message.includes("timed out")
        || message.includes("aborted")
        || message.includes("connection")
        || message.includes("reset")
        || message.includes("temporar")
        || message.includes("incomplete")
        || message.includes("body");
    }

    isRetryableStatus(status) {
      return status === 408
        || status === 409
        || status === 425
        || status === 429
        || (status >= 500 && status < 600);
    }

    retryDelay(attempt) {
      const base = DEFAULTS.requestRetryBaseDelayMs || 900;
      const jitter = Math.floor(Math.random() * 250);
      return base * Math.pow(2, attempt - 1) + jitter;
    }

    async requestOnce(config, path, body) {
      const timeoutMs = DEFAULTS.requestTimeoutMs;
      const headers = {
        "Content-Type": "application/json"
      };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }
      if (config.format === "openrouter" || isOpenRouterURL(config.baseURL)) {
        headers["HTTP-Referer"] = "https://www.zotero.org";
        headers["X-Title"] = "Zotero AI Assistant";
      }
      const fetchPromise = fetch(`${config.baseURL}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`${config.label} API 请求超时（超过 ${timeoutMs / 1000}s），请检查网络或稍后重试。`));
        }, timeoutMs);
      });
      const response = await Promise.race([fetchPromise, timeoutPromise]);

      let text;
      try {
        text = await response.text();
      }
      catch (err) {
        err.retryable = true;
        throw err;
      }
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      }
      catch (err) {
        payload = { error: { message: text } };
      }

      if (!response.ok) {
        const message = payload?.error?.message || response.statusText || "API request failed";
        const err = new Error(`${config.label} API ${response.status}: ${message}`);
        err.status = response.status;
        throw err;
      }
      return payload;
    }

    async request(kind, path, body) {
      const config = this.ensureConfigured(kind);
      const maxAttempts = Math.max(1, DEFAULTS.requestMaxAttempts || 1);
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await this.requestOnce(config, path, body);
        }
        catch (err) {
          lastError = err;
          const retryable = err?.retryable
            || this.isRetryableStatus(err?.status)
            || this.isRetryableRequestError(err);
          if (!retryable || attempt >= maxAttempts) {
            throw err;
          }
          const delay = this.retryDelay(attempt);
          Zotero.debug(`Zotero AI Assistant: ${config.label} request failed, retrying ${attempt + 1}/${maxAttempts} after ${delay}ms: ${err}`);
          await this.sleep(delay);
        }
      }
      throw lastError;
    }

    async chat(messages, options = {}) {
      const kind = options.modelType || "text";
      const config = this.ensureConfigured(kind);
      const payload = await this.request(kind, "/chat/completions", {
        model: options.model || config.model,
        messages,
        temperature: options.temperature ?? 0.2
      });
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`${config.label} API 没有返回可用回答。`);
      }
      return typeof content === "string"
        ? content
        : content.map((part) => part.text || "").join("\n").trim();
    }

    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts];
      const config = this.ensureConfigured("embedding");
      const payload = await this.request("embedding", "/embeddings", {
        model: config.model,
        input
      });
      const data = payload?.data;
      if (!Array.isArray(data)) {
        throw new Error("Embedding API 返回格式异常。");
      }
      return data
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map((entry) => entry.embedding);
    }

    async parsePdfBase64(base64, prompt) {
      return this.chat([
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                filename: "paper.pdf",
                file_data: `data:application/pdf;base64,${base64}`
              }
            },
            {
              type: "text",
              text: prompt || getPdfExtractionPrompt()
            }
          ]
        }
      ], {
        modelType: "multimodal",
        temperature: 0
      });
    }

    // Explain an image annotation (figure/formula) using a multimodal model.
    // textContext: surrounding page text; question: optional user question from Q: marker.
    async explainWithVision(imageBase64, textContext, question) {
      const userParts = [];
      if (textContext) {
        userParts.push({ type: "text", text: textContext });
      }
      userParts.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${imageBase64}` }
      });
      const questionText = buildAnnotationVisionQuestion(question);
      userParts.push({ type: "text", text: questionText });
      return this.chat([
        {
          role: "system",
          content: getAnnotationVisionSystemPrompt()
        },
        { role: "user", content: userParts }
      ], {
        modelType: "multimodal",
        model: this.multimodalModel,
        temperature: 0.2
      });
    }
  }

  Object.assign(ns, {
    OpenAICompatibleClient
  });
})(typeof process === "object" && process?.versions?.node ? globalThis : this);
