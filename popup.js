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
  settingsVersion: 8
};

const fields = {
  workerMode: document.querySelector("#workerMode"),
  workerUrl: document.querySelector("#workerUrl"),
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
const workerUrlRow = document.querySelector("#workerUrlRow");
const extensionApi = getExtensionApi();

loadSettings();

document.querySelector("#save").addEventListener("click", saveSettings);
document.querySelector("#test").addEventListener("click", testApi);
document.querySelector("#reset").addEventListener("click", resetSettings);
document.querySelector("#options").addEventListener("click", openOptions);
setupButton.addEventListener("click", openApiSetup);
fields.workerMode.addEventListener("change", () => {
  updateWorkerUi(readForm());
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
      const normalized = normalizeStoredSettings(nextSettings);
      applySettingsToForm(normalized);
      updateStatusCard(normalized);
    });
  });
}

async function saveSettings() {
  if (!extensionApi.storage) {
    setStatus("Settings can only be saved inside the installed extension.");
    return Promise.resolve(false);
  }

  const settings = readForm();
  const hasWorkerPermission = await ensureWorkerPermission(settings);
  if (!hasWorkerPermission) {
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
    setStatus("Add your Worker access token first.");
    return;
  }

  if (settings.workerMode === "custom" && !settings.workerUrl) {
    openApiSetup();
    setStatus("Add your custom Worker URL first.");
    return;
  }

  const saved = await saveSettings();
  if (!saved) {
    return;
  }
  setStatus("Testing Worker...");

  try {
    const response = await sendMessage({
      type: "shga.check",
      payload: {
        text: "This are a short test sentence.",
        mode: "grammar",
        context: "popup-test",
        scope: "panel"
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The Worker returned an error.");
    }

    setStatus(response.data?.correctedText ? "Worker test passed." : "Worker replied, but no correctedText was returned.");
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
  setStatus("Defaults restored. Add your Worker access token before testing.");
}

function applySettingsToForm(settings) {
  const normalized = normalizeStoredSettings(settings);
  fields.workerMode.value = normalized.workerMode;
  fields.workerUrl.value = normalized.workerUrl || HOSTED_WORKER_URL;
  fields.apiKey.value = normalized.apiKey || DEFAULT_SETTINGS.apiKey;
  fields.extensionEnabled.checked = normalized.extensionEnabled !== false;
  fields.language.value = normalized.language || "en";
  fields.defaultMode.value = normalized.defaultMode || "grammar";
  fields.includePageUrl.checked = Boolean(normalized.includePageUrl);
  fields.siteAccessMode.value = normalizeSiteAccessMode(normalized.siteAccessMode);
  fields.siteAccessList.value = normalized.siteAccessList || "";
  updateWorkerUi(readForm());
}

function readForm() {
  const workerMode = normalizeWorkerMode(fields.workerMode.value);
  return {
    workerMode,
    workerUrl: workerMode === "custom" ? normalizeWorkerUrl(fields.workerUrl.value) : HOSTED_WORKER_URL,
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

function normalizeWorkerMode(value) {
  return value === "custom" ? "custom" : DEFAULT_SETTINGS.workerMode;
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

function isLegacyCustomWorker(items) {
  return (
    items.workerMode === "custom" ||
    items.apiProvider === "external" ||
    Boolean(items.apiUrl && normalizeWorkerUrl(items.apiUrl) && normalizeWorkerUrl(items.apiUrl) !== HOSTED_WORKER_URL)
  );
}

function normalizeStoredSettings(items) {
  const customWorker = isLegacyCustomWorker(items || {});
  const workerMode = normalizeWorkerMode(items?.workerMode || (customWorker ? "custom" : "hosted"));
  const workerUrl = workerMode === "custom" ? normalizeWorkerUrl(items?.workerUrl || items?.apiUrl) : HOSTED_WORKER_URL;
  const preserveToken = items?.settingsVersion >= DEFAULT_SETTINGS.settingsVersion || customWorker;

  return {
    ...DEFAULT_SETTINGS,
    workerMode,
    workerUrl,
    apiKey: preserveToken && typeof items?.apiKey === "string" ? items.apiKey : "",
    extensionEnabled:
      typeof items?.extensionEnabled === "boolean" ? items.extensionEnabled : DEFAULT_SETTINGS.extensionEnabled,
    language: typeof items?.language === "string" && items.language.trim() ? items.language.trim() : DEFAULT_SETTINGS.language,
    defaultMode: ["grammar", "rewrite", "shorten"].includes(items?.defaultMode)
      ? items.defaultMode
      : DEFAULT_SETTINGS.defaultMode,
    includePageUrl:
      typeof items?.includePageUrl === "boolean" ? items.includePageUrl : DEFAULT_SETTINGS.includePageUrl,
    siteAccessMode: normalizeSiteAccessMode(items?.siteAccessMode),
    siteAccessList: typeof items?.siteAccessList === "string" ? items.siteAccessList : DEFAULT_SETTINGS.siteAccessList,
    settingsVersion: DEFAULT_SETTINGS.settingsVersion
  };
}

function updateWorkerUi(settings) {
  const mode = normalizeWorkerMode(settings.workerMode);
  workerUrlRow.hidden = mode !== "custom";
  fields.apiKey.placeholder = mode === "custom" ? "Custom Worker access token" : "Hosted Worker access token";
}

function updateStatusCard(settings) {
  const enabled = settings.extensionEnabled !== false;
  const hasToken = Boolean(String(settings.apiKey || "").trim());
  connectionText.textContent = !enabled ? "Paused" : hasToken ? "Connected" : "Setup needed";
  statusDot.dataset.off = String(!enabled);
  statusDot.dataset.warning = String(enabled && !hasToken);
  setupNotice.hidden = hasToken;
  setStatus(enabled ? (hasToken ? "Suggestions are on." : "Add Worker access token to start.") : "Suggestions are off.");
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
  const normalizedLocal = normalizeStoredSettings(localSettings);
  if (normalizedLocal.apiKey || !extensionApi.syncStorage || !extensionApi.storage) {
    return Promise.resolve(normalizedLocal);
  }

  return new Promise((resolve) => {
    extensionApi.syncStorage.get(null, (syncSettings) => {
      const normalizedSync = normalizeStoredSettings(syncSettings || {});
      if (!normalizedSync.apiKey || normalizedSync.workerMode !== "custom") {
        resolve(normalizedLocal);
        return;
      }

      const recoveredSettings = {
        ...normalizedLocal,
        workerMode: "custom",
        workerUrl: normalizedSync.workerUrl,
        apiKey: normalizedSync.apiKey,
        settingsVersion: DEFAULT_SETTINGS.settingsVersion
      };

      extensionApi.storage.set(recoveredSettings, () => {
        extensionApi.syncStorage.remove([
          ...Object.keys(DEFAULT_SETTINGS),
          "apiProvider",
          "apiUrl",
          "qwenEndpointId"
        ]);
        setStatus("Recovered old custom Worker token to local storage.");
        resolve(recoveredSettings);
      });
    });
  });
}

function ensureWorkerPermission(settings) {
  if (settings.workerMode !== "custom") {
    return Promise.resolve(true);
  }

  const origin = getWorkerOriginPattern(settings.workerUrl);
  if (!origin) {
    setStatus("Worker URL must start with http:// or https://.");
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

      setStatus("Custom Worker host permission was not granted.");
      resolve(false);
    });
  });
}

function getWorkerOriginPattern(value) {
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
