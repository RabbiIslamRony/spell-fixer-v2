const DEFAULT_SETTINGS = {
  apiUrl: "https://self-hosted-grammar-worker.rony-sovware.workers.dev/grammar/check",
  apiKey: "",
  extensionEnabled: true,
  language: "en",
  defaultMode: "grammar",
  includePageUrl: false,
  timeoutMs: 30000,
  settingsVersion: 4
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (items) => {
    const needsCurrentDefaults =
      items.settingsVersion !== DEFAULT_SETTINGS.settingsVersion ||
      !items.apiUrl ||
      !items.apiKey;

    chrome.storage.sync.set({
      ...DEFAULT_SETTINGS,
      ...items,
      ...(needsCurrentDefaults
        ? {
            apiUrl: DEFAULT_SETTINGS.apiUrl,
            apiKey: DEFAULT_SETTINGS.apiKey,
            extensionEnabled: DEFAULT_SETTINGS.extensionEnabled,
            includePageUrl: DEFAULT_SETTINGS.includePageUrl,
            settingsVersion: DEFAULT_SETTINGS.settingsVersion
          }
        : {})
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "shga.check") {
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
  const apiUrl = String(settings.apiUrl || "").trim();
  const text = String(payload.text || "").trim();

  if (settings.extensionEnabled === false && payload.context !== "popup-test") {
    throw new Error("Extension is off.");
  }

  if (!apiUrl) {
    throw new Error("Set your API URL in the extension popup first.");
  }

  if (!text) {
    throw new Error("No text was selected or found in the active editor.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Number(settings.timeoutMs) || 30000);
  const headers = { "Content-Type": "application/json" };

  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  const body = {
    text,
    mode: payload.mode || settings.defaultMode || "grammar",
    language: payload.language || settings.language || "en",
    pageUrl: settings.includePageUrl ? payload.pageUrl || sender?.tab?.url || "" : "",
    context: payload.context || ""
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const rawText = await response.text();
    const data = parseJson(rawText);

    if (!response.ok) {
      const detail = data?.error || data?.message || rawText || response.statusText;
      throw new Error(`API ${response.status}: ${detail}`);
    }

    return normalizeApiResponse(data ?? rawText);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("API request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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
