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
  settingsVersion: 7
};

const fields = {
  apiProvider: document.querySelector("#apiProvider"),
  apiUrl: document.querySelector("#apiUrl"),
  apiKey: document.querySelector("#apiKey"),
  extensionEnabled: document.querySelector("#extensionEnabled"),
  language: document.querySelector("#language"),
  defaultMode: document.querySelector("#defaultMode"),
  includePageUrl: document.querySelector("#includePageUrl"),
  siteAccessMode: document.querySelector("#siteAccessMode"),
  siteAccessList: document.querySelector("#siteAccessList")
};

const statusNode = document.querySelector("#status");
const connectionText = document.querySelector("#connectionText");
const statusDot = document.querySelector(".status-dot");
const setupNotice = document.querySelector("#setupNotice");
const setupButton = document.querySelector("#setupKey");
const advancedPanel = document.querySelector("#advanced");
const apiUrlRow = document.querySelector("#apiUrlRow");
const extensionApi = getExtensionApi();

loadSettings();

document.querySelector("#save").addEventListener("click", saveSettings);
document.querySelector("#test").addEventListener("click", testApi);
document.querySelector("#reset").addEventListener("click", resetSettings);
document.querySelector("#options").addEventListener("click", openOptions);
setupButton.addEventListener("click", openApiSetup);
fields.apiProvider.addEventListener("change", () => {
  updateProviderUi(readForm());
});
fields.extensionEnabled.addEventListener("change", async () => {
  await saveSettings();
  updateStatusCard(readForm());
});

function loadSettings() {
  if (!extensionApi.storage) {
    applySettingsToForm(DEFAULT_SETTINGS);
    updateStatusCard(DEFAULT_SETTINGS);
    setStatus("Open this popup from the Chrome extension toolbar.");
    return;
  }

  extensionApi.storage.get(DEFAULT_SETTINGS, (settings) => {
    recoverSyncedSettings(settings).then((nextSettings) => {
      applySettingsToForm(nextSettings);
      updateStatusCard(nextSettings);
    });
  });
}

async function saveSettings() {
  if (!extensionApi.storage) {
    setStatus("Settings can only be saved inside the installed extension.");
    return Promise.resolve(false);
  }

  const settings = readForm();
  const hasExternalPermission = await ensureExternalApiPermission(settings);
  if (!hasExternalPermission) {
    return false;
  }

  return new Promise((resolve) => {
    extensionApi.storage.set(settings, () => {
      updateStatusCard(settings);
      setStatus("Saved.");
      resolve(true);
    });
  });
}

async function testApi() {
  if (!extensionApi.runtime) {
    setStatus("Open this popup from the Chrome extension toolbar to test.");
    return;
  }

  const settings = readForm();
  if (!settings.apiKey) {
    openApiSetup();
    setStatus(`Add your ${getProviderLabel(settings.apiProvider)} API key first.`);
    return;
  }

  const saved = await saveSettings();
  if (!saved) {
    return;
  }
  setStatus("Testing...");

  try {
    const response = await sendMessage({
      type: "shga.check",
      payload: {
        text: "This are a short test sentence.",
        mode: "grammar",
        context: "popup-test"
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The API returned an error.");
    }

  setStatus(response.data?.correctedText ? `${getProviderLabel(settings.apiProvider)} test passed.` : "API replied, but no correctedText was returned.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function resetSettings() {
  if (!extensionApi.storage) {
    setStatus("Reset is available only inside the installed extension.");
    return;
  }

  await new Promise((resolve) => {
    extensionApi.storage.set(DEFAULT_SETTINGS, resolve);
  });
  loadSettings();
  setStatus("Defaults restored. Add your provider API key before testing.");
}

function applySettingsToForm(settings) {
  fields.apiProvider.value = normalizeApiProvider(settings.apiProvider || inferProviderFromKey(settings.apiKey));
  fields.apiUrl.value = settings.apiUrl || DEFAULT_SETTINGS.apiUrl;
  fields.apiKey.value = settings.apiKey || DEFAULT_SETTINGS.apiKey;
  fields.extensionEnabled.checked = settings.extensionEnabled !== false;
  fields.language.value = settings.language || "en";
  fields.defaultMode.value = settings.defaultMode || "grammar";
  fields.includePageUrl.checked = Boolean(settings.includePageUrl);
  fields.siteAccessMode.value = normalizeSiteAccessMode(settings.siteAccessMode);
  fields.siteAccessList.value = settings.siteAccessList || "";
  updateProviderUi(readForm());
}

function readForm() {
  return {
    apiProvider: normalizeApiProvider(fields.apiProvider.value),
    apiUrl: fields.apiUrl.value.trim(),
    apiKey: fields.apiKey.value.trim(),
    extensionEnabled: fields.extensionEnabled.checked,
    language: fields.language.value.trim() || "en",
    defaultMode: fields.defaultMode.value,
    includePageUrl: fields.includePageUrl.checked,
    siteAccessMode: normalizeSiteAccessMode(fields.siteAccessMode.value),
    siteAccessList: fields.siteAccessList.value.trim(),
    settingsVersion: DEFAULT_SETTINGS.settingsVersion
  };
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

function updateProviderUi(settings) {
  const provider = normalizeApiProvider(settings.apiProvider);
  apiUrlRow.hidden = provider !== "external";
  fields.apiKey.placeholder =
    provider === "gemini"
      ? "Gemini API key"
      : provider === "qwen"
        ? "Qwen DashScope API key"
        : "External API access token";
}

function updateStatusCard(settings) {
  const enabled = settings.extensionEnabled !== false;
  const hasApiKey = Boolean(String(settings.apiKey || "").trim());
  connectionText.textContent = !enabled ? "Paused" : hasApiKey ? "Connected" : "Setup needed";
  statusDot.dataset.off = String(!enabled);
  statusDot.dataset.warning = String(enabled && !hasApiKey);
  setupNotice.hidden = hasApiKey;
  setStatus(enabled ? (hasApiKey ? "Suggestions are on." : "Add API key to start.") : "Suggestions are off.");
}

function openApiSetup() {
  advancedPanel.open = true;
  fields.apiKey.focus();
}

function openOptions() {
  if (!extensionApi.openOptionsPage) {
    setStatus("Docs open from the installed extension popup.");
    return;
  }

  extensionApi.openOptionsPage();
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    if (!extensionApi.runtime) {
      reject(new Error("Open this popup from the Chrome extension toolbar."));
      return;
    }

    extensionApi.runtime.sendMessage(message, (response) => {
      const error = extensionApi.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(message) {
  statusNode.textContent = message;
}

function getExtensionApi() {
  const runtime = globalThis.chrome?.runtime;
  const storage = globalThis.chrome?.storage?.local;
  const syncStorage = globalThis.chrome?.storage?.sync;
  const permissions = globalThis.chrome?.permissions;

  return {
    runtime: runtime?.sendMessage ? runtime : null,
    storage: storage?.get && storage?.set ? storage : null,
    syncStorage: syncStorage?.get && syncStorage?.remove ? syncStorage : null,
    permissions: permissions?.request ? permissions : null,
    openOptionsPage: runtime?.openOptionsPage ? () => runtime.openOptionsPage() : null
  };
}

function recoverSyncedSettings(localSettings) {
  if (localSettings.apiKey || !extensionApi.syncStorage || !extensionApi.storage) {
    return Promise.resolve(localSettings);
  }

  return new Promise((resolve) => {
    extensionApi.syncStorage.get(DEFAULT_SETTINGS, (syncSettings) => {
      if (!syncSettings.apiKey) {
        resolve(localSettings);
        return;
      }

      const recoveredSettings = {
        ...DEFAULT_SETTINGS,
        ...syncSettings,
        ...localSettings,
        apiKey: syncSettings.apiKey,
        apiProvider: localSettings.apiProvider || syncSettings.apiProvider,
        apiUrl: localSettings.apiUrl || syncSettings.apiUrl,
        settingsVersion: DEFAULT_SETTINGS.settingsVersion
      };

      extensionApi.storage.set(recoveredSettings, () => {
        extensionApi.syncStorage.remove(Object.keys(DEFAULT_SETTINGS));
        setStatus("Recovered old API key to local storage.");
        resolve(recoveredSettings);
      });
    });
  });
}

function ensureExternalApiPermission(settings) {
  if (settings.apiProvider !== "external" || !settings.apiUrl) {
    return Promise.resolve(true);
  }

  const origin = getExternalApiOriginPattern(settings.apiUrl);
  if (!origin) {
    setStatus("External API URL must start with http:// or https://.");
    return Promise.resolve(false);
  }

  if (!extensionApi.permissions) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    extensionApi.permissions.request({ origins: [origin] }, (granted) => {
      if (granted) {
        resolve(true);
        return;
      }

      setStatus("External API host permission was not granted.");
      resolve(false);
    });
  });
}

function getExternalApiOriginPattern(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    return `${url.origin}/*`;
  } catch {
    return "";
  }
}
