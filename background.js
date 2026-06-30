const HOSTED_WORKER_URL = "https://self-hosted-grammar-worker.rony-sovware.workers.dev/grammar/check";

const DEFAULT_SETTINGS = {
  workerMode: "hosted",
  workerUrl: HOSTED_WORKER_URL,
  apiKey: "",
  extensionEnabled: true,
  language: "en",
  defaultMode: "grammar",
  includePageUrl: false,
  siteAccessMode: "all",
  siteAccessList: "",
  timeoutMs: 30000,
  settingsVersion: 8
};

const RESPONSE_CACHE_LIMIT = 80;
const RESPONSE_CACHE_TTL_MS = 120000;
const activeInlineControllers = new Map();
const responseCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  migrateSettingsToLocalStorage();
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
  const settings = normalizeStoredSettings(await getSettings());
  const workerUrl = getWorkerCheckUrl(settings);
  const workerToken = String(settings.apiKey || "").trim();
  const text = String(payload.text || "").trim();
  const mode = payload.mode || settings.defaultMode || "grammar";
  const language = payload.language || settings.language || "en";
  const scope = payload.scope === "inline" ? "inline" : "panel";
  const requestControl = beginRequestControl(scope, sender, payload);

  try {
    if (settings.extensionEnabled === false && payload.context !== "popup-test") {
      throw new Error("Extension is off.");
    }

    if (!workerToken) {
      throw new Error("Add your Worker access token in the extension popup.");
    }

    if (!workerUrl) {
      throw new Error("Set a valid Worker URL in the extension popup.");
    }

    if (!text) {
      throw new Error("No text was selected or found in the active editor.");
    }

    const pageUrl = payload.pageUrl || sender?.tab?.url || "";
    if (!isSiteAllowed(settings, pageUrl)) {
      throw new Error("This site is disabled in the extension settings.");
    }

    const cacheKey = getResponseCacheKey({
      workerUrl,
      workerToken,
      mode,
      language,
      scope,
      text
    });
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await fetchWithTimeout(
      workerUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${workerToken}`
        },
        body: JSON.stringify({
          text,
          mode,
          language,
          pageUrl: settings.includePageUrl ? pageUrl : "",
          context: payload.context || "",
          scope,
          requestId: Number(payload.requestId) || 0
        })
      },
      Number(settings.timeoutMs) || DEFAULT_SETTINGS.timeoutMs,
      requestControl.signal
    );

    const rawText = await response.text();
    const data = parseJson(rawText);

    if (!response.ok) {
      throwWorkerError(response, data, rawText);
    }

    const result = normalizeApiResponse(data ?? rawText);
    rememberResponse(cacheKey, result);
    return result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(scope === "inline" ? "Inline request replaced by newer typing." : "Worker request timed out.");
    }
    throw error;
  } finally {
    requestControl.finish();
  }
}

function throwWorkerError(response, data, rawText) {
  const detail = data?.error || data?.message || rawText || response.statusText;
  if (response.status === 401 || response.status === 403) {
    throw new Error("Worker access token is invalid, expired, or revoked.");
  }

  if (response.status === 429) {
    throw new Error(detail || "Usage limit reached. Try again later.");
  }

  if (response.status === 413) {
    throw new Error(detail || "This text is too long for the current check mode.");
  }

  throw new Error(`Worker API ${response.status}: ${detail}`);
}

async function fetchWithTimeout(url, options, timeoutMs, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Number(timeoutMs) || DEFAULT_SETTINGS.timeoutMs);
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
      throw new Error(signal?.aborted ? "Inline request replaced by newer typing." : "Worker request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener?.("abort", abortFromSignal);
  }
}

function normalizeSiteAccessMode(value) {
  return ["all", "blocklist", "allowlist"].includes(value) ? value : DEFAULT_SETTINGS.siteAccessMode;
}

function normalizeWorkerMode(value) {
  return value === "custom" ? "custom" : DEFAULT_SETTINGS.workerMode;
}

function getWorkerCheckUrl(settings) {
  const mode = normalizeWorkerMode(settings.workerMode);
  if (mode === "hosted") {
    return HOSTED_WORKER_URL;
  }

  return normalizeWorkerUrl(settings.workerUrl);
}

function normalizeWorkerUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function isHostedWorkerUrl(value) {
  return normalizeWorkerUrl(value) === HOSTED_WORKER_URL;
}

function isLegacyCustomWorker(items) {
  return (
    items.workerMode === "custom" ||
    items.apiProvider === "external" ||
    Boolean(items.apiUrl && normalizeWorkerUrl(items.apiUrl) && !isHostedWorkerUrl(items.apiUrl))
  );
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

function getResponseCacheKey({ workerUrl, workerToken, mode, language, scope, text }) {
  return [
    workerUrl,
    getTokenFingerprint(workerToken),
    mode || "grammar",
    language || "en",
    scope || "panel",
    normalizeCacheText(text)
  ].join("|");
}

function getTokenFingerprint(token) {
  const value = String(token || "");
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

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, resolve);
  });
}

function migrateSettingsToLocalStorage() {
  if (!chrome.storage?.local) {
    return;
  }

  chrome.storage.sync.get(null, (syncItems = {}) => {
    chrome.storage.local.get(null, (localItems = {}) => {
      const mergedItems = {
        ...DEFAULT_SETTINGS,
        ...syncItems,
        ...localItems
      };
      chrome.storage.local.set(normalizeStoredSettings(mergedItems), () => {
        chrome.storage.sync.remove([
          ...Object.keys(DEFAULT_SETTINGS),
          "apiProvider",
          "apiUrl",
          "qwenEndpointId"
        ]);
      });
    });
  });
}

function normalizeStoredSettings(items) {
  const customWorker = isLegacyCustomWorker(items);
  const workerMode = normalizeWorkerMode(items.workerMode || (customWorker ? "custom" : "hosted"));
  const legacyWorkerUrl = normalizeWorkerUrl(items.workerUrl || items.apiUrl);
  const workerUrl = workerMode === "custom" ? legacyWorkerUrl : HOSTED_WORKER_URL;
  const preserveToken = items.settingsVersion >= DEFAULT_SETTINGS.settingsVersion || customWorker;

  return {
    ...DEFAULT_SETTINGS,
    workerMode,
    workerUrl,
    apiKey: preserveToken && typeof items.apiKey === "string" ? items.apiKey : DEFAULT_SETTINGS.apiKey,
    extensionEnabled:
      typeof items.extensionEnabled === "boolean" ? items.extensionEnabled : DEFAULT_SETTINGS.extensionEnabled,
    language: typeof items.language === "string" && items.language.trim() ? items.language.trim() : DEFAULT_SETTINGS.language,
    defaultMode: ["grammar", "rewrite", "shorten"].includes(items.defaultMode)
      ? items.defaultMode
      : DEFAULT_SETTINGS.defaultMode,
    includePageUrl:
      typeof items.includePageUrl === "boolean" ? items.includePageUrl : DEFAULT_SETTINGS.includePageUrl,
    siteAccessMode: normalizeSiteAccessMode(items.siteAccessMode),
    siteAccessList: typeof items.siteAccessList === "string" ? items.siteAccessList : DEFAULT_SETTINGS.siteAccessList,
    timeoutMs: Number(items.timeoutMs) || DEFAULT_SETTINGS.timeoutMs,
    settingsVersion: DEFAULT_SETTINGS.settingsVersion
  };
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
      suggestions: [],
      issues: []
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
