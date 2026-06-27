const DEFAULT_SETTINGS = {
  apiProvider: "qwen",
  apiUrl: "",
  apiKey: "",
  extensionEnabled: true,
  language: "en",
  defaultMode: "grammar",
  includePageUrl: false,
  siteAccessMode: "all",
  siteAccessList: "",
  timeoutMs: 30000,
  settingsVersion: 6
};

const RESPONSE_CACHE_LIMIT = 80;
const RESPONSE_CACHE_TTL_MS = 120000;
const QWEN_ENDPOINT_CACHE_KEY = "qwenEndpointId";
const activeInlineControllers = new Map();
const responseCache = new Map();

const AI_PROVIDERS = {
  gemini: {
    label: "Gemini",
    model: "gemini-3.5-flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions"
  },
  qwen: {
    label: "Qwen",
    model: "qwen-plus",
    endpoints: [
      {
        id: "singapore",
        label: "Singapore",
        url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
      },
      {
        id: "us-virginia",
        label: "US Virginia",
        url: "https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions"
      },
      {
        id: "china-beijing",
        label: "China Beijing",
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
      }
    ]
  }
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (items) => {
    chrome.storage.sync.set({
      ...DEFAULT_SETTINGS,
      ...items,
      apiProvider: normalizeApiProvider(items.apiProvider || inferProviderFromKey(items.apiKey)),
      apiUrl: typeof items.apiUrl === "string" ? items.apiUrl : DEFAULT_SETTINGS.apiUrl,
      apiKey: typeof items.apiKey === "string" ? items.apiKey : DEFAULT_SETTINGS.apiKey,
      extensionEnabled:
        typeof items.extensionEnabled === "boolean" ? items.extensionEnabled : DEFAULT_SETTINGS.extensionEnabled,
      includePageUrl:
        typeof items.includePageUrl === "boolean" ? items.includePageUrl : DEFAULT_SETTINGS.includePageUrl,
      siteAccessMode: normalizeSiteAccessMode(items.siteAccessMode),
      siteAccessList: typeof items.siteAccessList === "string" ? items.siteAccessList : DEFAULT_SETTINGS.siteAccessList,
      settingsVersion: DEFAULT_SETTINGS.settingsVersion
    });
  });
  injectContentScriptsIntoOpenTabs();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "shga.cancelInlineCheck") {
    cancelInlineCheck(sender, message.payload || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type !== "shga.check") {
    return false;
  }

  handleCheck(message.payload || {}, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function handleCheck(payload, sender) {
  const settings = await getSettings();
  const apiProvider = normalizeApiProvider(settings.apiProvider || inferProviderFromKey(settings.apiKey));
  const apiUrl = String(settings.apiUrl || "").trim();
  const apiKey = String(settings.apiKey || "").trim();
  const text = String(payload.text || "").trim();
  const mode = payload.mode || settings.defaultMode || "grammar";
  const language = payload.language || settings.language || "en";
  const scope = payload.scope === "inline" ? "inline" : "panel";
  const requestControl = beginRequestControl(scope, sender, payload);

  try {
    if (settings.extensionEnabled === false && payload.context !== "popup-test") {
      throw new Error("Extension is off.");
    }

    if (!apiKey) {
      throw new Error(`Add your ${getProviderLabel(apiProvider)} API key in the extension popup.`);
    }

    if (!text) {
      throw new Error("No text was selected or found in the active editor.");
    }

    const pageUrl = payload.pageUrl || sender?.tab?.url || "";
    if (!isSiteAllowed(settings, pageUrl)) {
      throw new Error("This site is disabled in the extension settings.");
    }

    const cacheKey = getResponseCacheKey({
      provider: apiProvider,
      apiUrl,
      apiKey,
      mode,
      language,
      scope,
      text
    });
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      return cached;
    }

    let result;
    if (apiProvider !== "external") {
      result = await checkWithDirectProvider({
        provider: apiProvider,
        apiKey,
        text,
        mode,
        language,
        pageUrl: settings.includePageUrl ? pageUrl : "",
        timeoutMs: Number(settings.timeoutMs) || 30000,
        scope,
        signal: requestControl.signal
      });
      rememberResponse(cacheKey, result);
      return result;
    }

    if (!apiUrl) {
      throw new Error("Set your External API URL in the extension popup first.");
    }

    const headers = { "Content-Type": "application/json" };

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const body = {
      text,
      mode,
      language,
      pageUrl: settings.includePageUrl ? pageUrl : "",
      context: payload.context || "",
      scope
    };

    const response = await fetchWithTimeout(
      apiUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      },
      Number(settings.timeoutMs) || 30000,
      requestControl.signal
    );
    const rawText = await response.text();
    const data = parseJson(rawText);

    if (!response.ok) {
      const detail = data?.error || data?.message || rawText || response.statusText;
      if (response.status === 401 || response.status === 403) {
        throw new Error("API key is invalid. Open the extension popup and update it.");
      }
      throw new Error(`API ${response.status}: ${detail}`);
    }

    result = normalizeApiResponse(data ?? rawText);
    rememberResponse(cacheKey, result);
    return result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(scope === "inline" ? "Inline request replaced by newer typing." : "API request timed out.");
    }
    throw error;
  } finally {
    requestControl.finish();
  }
}

async function checkWithDirectProvider({ provider, apiKey, text, mode, language, pageUrl, timeoutMs, scope, signal }) {
  const prompt = buildAiPrompt({ text, mode, language, pageUrl, scope });
  const result =
    provider === "gemini"
      ? await callGemini({ apiKey, prompt, timeoutMs, signal })
      : await callQwen({ apiKey, prompt, timeoutMs, signal });
  const parsed = parseModelJson(result.text);
  return repairIssueOffsets(normalizeApiResponse(parsed || result.text), text);
}

async function callGemini({ apiKey, prompt, timeoutMs, signal }) {
  const response = await fetchWithTimeout(
    AI_PROVIDERS.gemini.endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        model: AI_PROVIDERS.gemini.model,
        input: prompt
      })
    },
    timeoutMs,
    signal
  );

  const data = await readJsonResponse(response);
  if (!response.ok) {
    throwProviderError("Gemini", response, data);
  }

  return {
    text: extractGeminiText(data)
  };
}

async function callQwen({ apiKey, prompt, timeoutMs, signal }) {
  const errors = [];
  for (const endpoint of await getQwenEndpointOrder()) {
    try {
      const response = await fetchWithTimeout(
        endpoint.url,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: AI_PROVIDERS.qwen.model,
            messages: [
              {
                role: "system",
                content: "You are a precise grammar and rewriting assistant. Return only valid JSON."
              },
              {
                role: "user",
                content: prompt
              }
            ]
          })
        },
        timeoutMs,
        signal
      );

      const data = await readJsonResponse(response);
      if (!response.ok) {
        throwProviderError(endpoint.label, response, data);
      }

      rememberQwenEndpoint(endpoint.id);
      return {
        text: extractQwenText(data),
        endpointId: endpoint.id
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      errors.push(`${endpoint.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Qwen request failed. ${errors.join(" | ")}`);
}

async function fetchWithTimeout(url, options, timeoutMs, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Number(timeoutMs) || 30000);
  const abortFromSignal = () => controller.abort();

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener?.("abort", abortFromSignal, { once: true });
  }

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(signal?.aborted ? "Inline request replaced by newer typing." : "API request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener?.("abort", abortFromSignal);
  }
}

async function readJsonResponse(response) {
  const rawText = await response.text();
  const data = parseJson(rawText);
  return data ?? { message: rawText };
}

function throwProviderError(label, response, data) {
  const detail = data?.error?.message || data?.message || data?.error || response.statusText;
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${label} API key is invalid for this endpoint.`);
  }
  throw new Error(`${label} API ${response.status}: ${detail}`);
}

function buildAiPrompt({ text, mode, language, pageUrl, scope }) {
  const task =
    mode === "rewrite"
      ? "Rewrite the text for clarity while preserving meaning."
      : mode === "shorten"
        ? "Shorten the text while preserving meaning."
        : "Fix grammar, spelling, punctuation, and obvious wording mistakes.";
  const inline = scope === "inline";

  return [
    `Task: ${task}`,
    `Language: ${language || "en"}`,
    pageUrl ? `Page URL context: ${pageUrl}` : "",
    inline
      ? "Inline check: return issue offsets only for the provided input. Do not rewrite the whole text."
      : "",
    "Return only valid JSON with this shape:",
    inline
      ? '{"issues":[{"start":0,"end":4,"original":"text","replacement":"fixed","title":"Grammar","explanation":"short reason","severity":"grammar"}], "suggestions":[]}'
      : '{"correctedText":"...", "issues":[{"start":0,"end":4,"original":"text","replacement":"fixed","title":"Grammar","explanation":"short reason","severity":"grammar"}], "suggestions":[]}',
    inline
      ? "Use zero-based character offsets from the provided input. If offsets are uncertain, return an empty issues array."
      : "Use zero-based character offsets from the original input for issues. If offsets are uncertain, return an empty issues array but still return correctedText.",
    "Original input:",
    text
  ].filter(Boolean).join("\n");
}

function extractGeminiText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const text = collectText(data).join("\n").trim();
  return text || JSON.stringify(data);
}

function extractQwenText(data) {
  const message = data?.choices?.[0]?.message?.content;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }

  if (Array.isArray(message)) {
    const text = message
      .map((item) => (typeof item === "string" ? item : item?.text || item?.content || ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }

  return JSON.stringify(data);
}

function collectText(value, collected = []) {
  if (!value || typeof value !== "object") {
    return collected;
  }

  if (typeof value.text === "string" && value.text.trim()) {
    collected.push(value.text.trim());
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, collected));
    return collected;
  }

  Object.values(value).forEach((item) => collectText(item, collected));
  return collected;
}

function parseModelJson(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const direct = parseJson(unfenced);
  if (direct) {
    return direct;
  }

  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return parseJson(unfenced.slice(start, end + 1));
  }

  return null;
}

function repairIssueOffsets(data, sourceText) {
  if (!Array.isArray(data?.issues) || !sourceText) {
    return data;
  }

  const usedRanges = [];
  const issues = data.issues
    .map((issue) => {
      const original = firstString(issue.original);
      const start = Number(issue.start);
      const end = Number(issue.end);

      if (Number.isInteger(start) && Number.isInteger(end) && sourceText.slice(start, end) === original) {
        usedRanges.push([start, end]);
        return issue;
      }

      if (!original) {
        return issue;
      }

      const found = findUnusedTextRange(sourceText, original, usedRanges);
      if (!found) {
        return issue;
      }

      usedRanges.push(found);
      return {
        ...issue,
        start: found[0],
        end: found[1]
      };
    })
    .filter((issue) => {
      const start = Number(issue.start);
      const end = Number(issue.end);
      return Number.isInteger(start) && Number.isInteger(end) && end > start && end <= sourceText.length;
    });

  return {
    ...data,
    issues
  };
}

function findUnusedTextRange(sourceText, needle, usedRanges) {
  let index = sourceText.indexOf(needle);
  while (index >= 0) {
    const range = [index, index + needle.length];
    const overlaps = usedRanges.some(([start, end]) => range[0] < end && range[1] > start);
    if (!overlaps) {
      return range;
    }
    index = sourceText.indexOf(needle, index + 1);
  }
  return null;
}

function normalizeSiteAccessMode(value) {
  return ["all", "blocklist", "allowlist"].includes(value) ? value : DEFAULT_SETTINGS.siteAccessMode;
}

function normalizeApiProvider(value) {
  return ["qwen", "gemini", "external"].includes(value) ? value : DEFAULT_SETTINGS.apiProvider;
}

function inferProviderFromKey(value) {
  return String(value || "").trim().startsWith("sk-ws-") ? "qwen" : DEFAULT_SETTINGS.apiProvider;
}

function getProviderLabel(provider) {
  return {
    qwen: "Qwen",
    gemini: "Gemini",
    external: "External API"
  }[normalizeApiProvider(provider)];
}

function isSiteAllowed(settings, pageUrl) {
  const mode = normalizeSiteAccessMode(settings.siteAccessMode);
  if (mode === "all") {
    return true;
  }

  const hostname = getHostname(pageUrl);
  if (!hostname) {
    return mode !== "allowlist";
  }

  const entries = parseSiteList(settings.siteAccessList);
  if (!entries.length) {
    return mode !== "allowlist";
  }

  const matched = entries.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
  return mode === "allowlist" ? matched : !matched;
}

function getHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function parseSiteList(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase())
    .filter(Boolean);
}

function beginRequestControl(scope, sender, payload) {
  if (scope !== "inline") {
    return {
      signal: null,
      finish() {}
    };
  }

  const key = getInlineRequestKey(sender);
  const previous = activeInlineControllers.get(key);
  previous?.controller.abort();

  const controller = new AbortController();
  const requestId = Number(payload.requestId) || 0;
  activeInlineControllers.set(key, { controller, requestId });

  return {
    signal: controller.signal,
    finish() {
      const active = activeInlineControllers.get(key);
      if (active?.controller === controller) {
        activeInlineControllers.delete(key);
      }
    }
  };
}

function cancelInlineCheck(sender, payload) {
  const key = getInlineRequestKey(sender);
  const active = activeInlineControllers.get(key);
  if (!active) {
    return;
  }

  const requestId = Number(payload.requestId) || 0;
  if (!requestId || requestId === active.requestId) {
    active.controller.abort();
    activeInlineControllers.delete(key);
  }
}

function getInlineRequestKey(sender) {
  return `${sender?.tab?.id ?? "no-tab"}:${sender?.frameId ?? 0}`;
}

function getResponseCacheKey({ provider, apiUrl, apiKey, mode, language, scope, text }) {
  return [
    provider,
    provider === "external" ? apiUrl : "",
    getApiKeyFingerprint(apiKey),
    mode || "grammar",
    language || "en",
    scope || "panel",
    normalizeCacheText(text)
  ].join("|");
}

function getApiKeyFingerprint(apiKey) {
  const value = String(apiKey || "");
  return `${value.length}:${value.slice(0, 6)}:${value.slice(-4)}`;
}

function normalizeCacheText(text) {
  return String(text || "");
}

function getCachedResponse(key) {
  const item = responseCache.get(key);
  if (!item) {
    return null;
  }

  if (Date.now() - item.createdAt > RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }

  responseCache.delete(key);
  responseCache.set(key, item);
  return cloneData(item.data);
}

function rememberResponse(key, data) {
  responseCache.set(key, {
    createdAt: Date.now(),
    data: cloneData(data)
  });

  while (responseCache.size > RESPONSE_CACHE_LIMIT) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

async function getQwenEndpointOrder() {
  const cachedId = await getLocalValue(QWEN_ENDPOINT_CACHE_KEY);
  const endpoints = AI_PROVIDERS.qwen.endpoints;
  if (!cachedId) {
    return endpoints;
  }

  const preferred = endpoints.find((endpoint) => endpoint.id === cachedId);
  if (!preferred) {
    return endpoints;
  }

  return [preferred, ...endpoints.filter((endpoint) => endpoint.id !== cachedId)];
}

function rememberQwenEndpoint(endpointId) {
  if (!endpointId || !chrome.storage?.local) {
    return;
  }

  chrome.storage.local.set({ [QWEN_ENDPOINT_CACHE_KEY]: endpointId });
}

function getLocalValue(key) {
  return new Promise((resolve) => {
    if (!chrome.storage?.local) {
      resolve("");
      return;
    }

    chrome.storage.local.get({ [key]: "" }, (items) => {
      resolve(items?.[key] || "");
    });
  });
}

function injectContentScriptsIntoOpenTabs() {
  if (!chrome.tabs?.query || !chrome.scripting?.executeScript || !chrome.scripting?.insertCSS) {
    return;
  }

  chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, (tabs = []) => {
    if (chrome.runtime.lastError) {
      return;
    }

    tabs.forEach((tab) => {
      if (!tab.id) {
        return;
      }

      chrome.scripting.insertCSS(
        {
          target: { tabId: tab.id },
          files: ["content.css"]
        },
        () => {
          void chrome.runtime.lastError;
        }
      );

      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          files: ["content.js"]
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    });
  });
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, resolve);
  });
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeApiResponse(data) {
  if (typeof data === "string") {
    return {
      correctedText: data,
      suggestions: []
    };
  }

  const correctedText =
    firstString(data?.correctedText, data?.corrected_text, data?.replacement, data?.text) || "";

  const sourceSuggestions = Array.isArray(data?.suggestions)
    ? data.suggestions
    : Array.isArray(data?.corrections)
      ? data.corrections
      : [];
  const sourceIssues = Array.isArray(data?.issues) ? data.issues : [];

  const suggestions = sourceSuggestions.map((item, index) => ({
    title: firstString(item.title, item.label, item.issue) || `Suggestion ${index + 1}`,
    replacement: firstString(item.replacement, item.correctedText, item.corrected_text, item.text) || "",
    explanation: firstString(item.explanation, item.reason, item.message) || "",
    severity: firstString(item.severity, item.type) || "suggestion"
  }));
  const issues = sourceIssues
    .map((item, index) => ({
      start: Number(item.start),
      end: Number(item.end),
      original: firstString(item.original, item.text, item.issueText) || "",
      replacement:
        firstString(item.replacement, item.correctedText, item.corrected_text, item.suggestion) || "",
      title: firstString(item.title, item.label, item.issue) || `Suggestion ${index + 1}`,
      explanation: firstString(item.explanation, item.reason, item.message) || "",
      severity: firstString(item.severity, item.type) || "grammar"
    }))
    .filter(
      (item) =>
        Number.isInteger(item.start) &&
        Number.isInteger(item.end) &&
        item.end > item.start &&
        item.replacement &&
        item.replacement !== item.original
    )
    .sort((a, b) => a.start - b.start);

  return {
    correctedText,
    suggestions,
    issues,
    raw: data
  };
}

function firstString(...values) {
  const found = values.find((value) => typeof value === "string" && value.trim());
  return found ? found.trim() : "";
}
