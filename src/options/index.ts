import {
  isListCacheResponse,
  MESSAGE_TYPE,
} from "../shared/contracts/messages";
import {
  DEFAULT_PROVIDER_ID,
  DEFAULT_SUBTITLE_SETTINGS,
  parseCaptionDisplayMode,
  resolveProviderApiKey,
  resolveProviderModel,
  type CaptionDisplayMode,
  type ExtensionSettings,
} from "../shared/contracts/settings";
import { createProviderAdapter, getProviderPreset, listProviderPresets } from "../shared/providers/provider-registry";
import { createChromeSettingsRepository } from "../shared/storage/settings-repository";
import { checkForExtensionUpdate } from "../shared/extension-update";
import { getUiLocale, localizeDocument, t } from "../shared/i18n";

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing options element: ${selector}`);
  }
  return element;
}

function showToast(message: string, tone: "success" | "error" | "info" = "info"): void {
  const container = queryRequired<HTMLElement>("#toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${tone}`;
  toast.textContent = message;
  container.append(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString(getUiLocale());
}

function populateProviders(selectedId: string): void {
  const select = queryRequired<HTMLSelectElement>("#provider-id");
  select.replaceChildren();
  for (const preset of listProviderPresets()) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.displayName;
    if (preset.id === selectedId) {
      option.selected = true;
    }
    select.append(option);
  }
}

function populateModels(models: readonly string[], current: string): string {
  const select = queryRequired<HTMLSelectElement>("#model");
  select.replaceChildren();
  const availableModels = [...new Set(models.map((model) => model.trim()).filter(Boolean))];

  let preferred = current;
  if (!preferred || !availableModels.includes(preferred)) {
    preferred = availableModels[0] ?? "";
  }

  for (const model of availableModels) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    select.append(option);
  }

  if (preferred) {
    select.value = preferred;
  }
  select.disabled = availableModels.length === 0;
  return select.value;
}

async function loadModels(
  providerId: string,
  apiKey: string,
  currentModel = "",
  isCurrent: () => boolean = () => true,
): Promise<string> {
  const modelSelect = queryRequired<HTMLSelectElement>("#model");
  const loadModelsButton = queryRequired<HTMLButtonElement>("#load-models");
  const normalizedApiKey = apiKey.trim();
  const preset = getProviderPreset(providerId);

  if (!preset) {
    if (!isCurrent()) {
      return "";
    }
    modelSelect.replaceChildren();
    modelSelect.disabled = true;
    loadModelsButton.disabled = true;
    setTranslationStatus(t("options.unknownService"), "error");
    return "";
  }

  const hasStaticModels = !preset.modelsPath && Boolean(preset.models?.length);
  if (!normalizedApiKey && !hasStaticModels) {
    if (!isCurrent()) {
      return "";
    }
    modelSelect.replaceChildren();
    modelSelect.disabled = true;
    loadModelsButton.disabled = true;
    setTranslationStatus(t("options.enterApiKey"));
    return "";
  }

  if (!isCurrent()) {
    return "";
  }
  loadModelsButton.disabled = true;
  setTranslationStatus(t("options.findingModels"));

  try {
    const adapter = createProviderAdapter(preset, (input, init) => fetch(input, init));
    const result = await adapter.listModels(normalizedApiKey);
    if (!isCurrent()) {
      return "";
    }
    if (result.ok) {
      const model = populateModels(result.models, currentModel);
      providerDrafts.set(providerId, {
        apiKey: normalizedApiKey,
        model,
        modelLoadedForApiKey: normalizedApiKey,
      });
      setTranslationStatus(model
        ? (normalizedApiKey ? t("options.modelsFound", { count: result.models.length }) : t("options.modelsFoundEnterKey", { count: result.models.length }))
        : t("options.noModels"), model ? "success" : "error");
      loadModelsButton.disabled = !normalizedApiKey;
      return model;
    } else {
      modelSelect.replaceChildren();
      modelSelect.disabled = true;
      setTranslationStatus(result.error.message, "error");
    }
  } catch {
    if (isCurrent()) {
      modelSelect.replaceChildren();
      modelSelect.disabled = true;
      setTranslationStatus(t("options.modelsUnavailable"), "error");
    }
  } finally {
    if (isCurrent()) {
      loadModelsButton.disabled = !normalizedApiKey;
    }
  }
  return "";
}

async function loadCacheList(): Promise<void> {
  const listEl = queryRequired<HTMLUListElement>("#cache-list");
  const statsEl = queryRequired<HTMLElement>("#cache-stats");
  const emptyEl = queryRequired<HTMLElement>("#cache-empty");

  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.listCache });
  } catch {
    listEl.replaceChildren();
    statsEl.textContent = "";
    emptyEl.textContent = t("options.historyUnavailable");
    emptyEl.hidden = false;
    return;
  }

  if (!isListCacheResponse(response)) {
    listEl.replaceChildren();
    statsEl.textContent = "";
    emptyEl.textContent = t("options.historyUnavailable");
    emptyEl.hidden = false;
    return;
  }

  listEl.replaceChildren();
  statsEl.textContent = t("options.historyStats", { count: response.entries.length, size: formatBytes(response.totalBytes) });
  emptyEl.hidden = response.entries.length > 0;

  for (const entry of response.entries) {
    const item = document.createElement("li");
    item.className = "cache-item";

    const info = document.createElement("div");
    info.className = "cache-item-info";

    const title = document.createElement("p");
    title.className = "cache-item-title";
    title.textContent = entry.title;

    const meta = document.createElement("p");
    meta.className = "cache-item-meta";
    meta.textContent = t("options.historyEntry", {
      source: entry.sourceLanguage,
      target: entry.targetLanguage,
      count: entry.blockCount,
      date: formatDate(entry.updatedAt),
    });

    info.append(title, meta);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "cache-delete";
    deleteButton.textContent = t("options.delete");
    deleteButton.setAttribute("aria-label", t("options.deleteHistoryEntry", { title: entry.title }));
    deleteButton.addEventListener("click", () => {
      void chrome.runtime
        .sendMessage({ type: MESSAGE_TYPE.clearVideoCache, videoId: entry.videoId })
        .then(() => loadCacheList())
        .catch(() => showToast(t("options.deleteFailed"), "error"));
    });

    item.append(info, deleteButton);
    listEl.append(item);
  }
}

interface ProviderDraft {
  apiKey: string;
  model: string;
  modelLoadedForApiKey: string;
}

let committedSettings: ExtensionSettings | null = null;
let activeProviderId = "";
const providerDrafts = new Map<string, ProviderDraft>();
let pendingSettings: ExtensionSettings | null = null;
let inFlightSettings: ExtensionSettings | null = null;
let pendingTranslationSave = false;
let saveTimer: number | null = null;
let saveInFlight = false;
let modelLoadVersion = 0;

function setTranslationStatus(message: string, state: "info" | "success" | "error" = "info"): void {
  const status = queryRequired<HTMLElement>("#model-status");
  status.textContent = message;
  status.dataset.state = state;
}

async function loadUpdate(): Promise<void> {
  const currentVersion = chrome.runtime.getManifest().version;
  const currentVersionElement = queryRequired<HTMLElement>("#current-version");
  const latestVersionElement = queryRequired<HTMLElement>("#latest-version");
  const statusElement = queryRequired<HTMLElement>("#version-update-status");
  const downloadLink = queryRequired<HTMLAnchorElement>("#options-download-update");
  currentVersionElement.textContent = currentVersion;
  latestVersionElement.textContent = "—";
  statusElement.textContent = t("options.updateChecking");
  statusElement.dataset.state = "info";
  downloadLink.hidden = true;

  const result = await checkForExtensionUpdate(currentVersion);
  switch (result.state) {
    case "available":
      latestVersionElement.textContent = result.update.version;
      statusElement.textContent = t("options.updateAvailable", { version: result.update.version });
      statusElement.dataset.state = "success";
      downloadLink.href = result.update.downloadUrl;
      downloadLink.hidden = false;
      break;
    case "up-to-date":
      latestVersionElement.textContent = currentVersion;
      statusElement.textContent = t("options.updateUpToDate");
      statusElement.dataset.state = "success";
      break;
    case "unavailable":
      statusElement.textContent = t("options.updateUnavailable");
      statusElement.dataset.state = "error";
      break;
  }
}

function getProviderDraft(providerId: string): ProviderDraft {
  const existing = providerDrafts.get(providerId);
  if (existing) {
    return existing;
  }

  const draft = {
    apiKey: committedSettings ? resolveProviderApiKey(committedSettings, providerId) : "",
    model: committedSettings ? resolveProviderModel(committedSettings, providerId) : "",
    modelLoadedForApiKey: "",
  };
  if (draft.apiKey && draft.model) {
    draft.modelLoadedForApiKey = draft.apiKey;
  }
  providerDrafts.set(providerId, draft);
  return draft;
}

function updateLoadModelsButton(): void {
  const button = queryRequired<HTMLButtonElement>("#load-models");
  const apiKey = queryRequired<HTMLInputElement>("#api-key").value.trim();
  button.disabled = !apiKey;
}

function captureActiveProviderDraft(): void {
  if (!activeProviderId) {
    return;
  }
  const apiKey = queryRequired<HTMLInputElement>("#api-key").value;
  const model = queryRequired<HTMLSelectElement>("#model").value;
  const existing = getProviderDraft(activeProviderId);
  providerDrafts.set(activeProviderId, {
    apiKey,
    model,
    modelLoadedForApiKey: existing.modelLoadedForApiKey === apiKey ? apiKey : "",
  });
}

function buildGeneralSettings(): ExtensionSettings | null {
  const base = pendingSettings ?? inFlightSettings ?? committedSettings;
  if (!base) {
    return null;
  }
  const displayMode = parseCaptionDisplayMode(queryRequired<HTMLSelectElement>("#caption-mode").value);
  const shortsTranslationEnabled = queryRequired<HTMLInputElement>("#shorts-translation-enabled").checked;
  const translationColor = queryRequired<HTMLInputElement>("#translation-color").value;
  const originalColor = queryRequired<HTMLInputElement>("#original-color").value;
  const translationFontScale = Number(queryRequired<HTMLInputElement>("#translation-font-scale").value);
  const originalFontScale = Number(queryRequired<HTMLInputElement>("#original-font-scale").value);
  if (
    !displayMode
    || !/^#[0-9a-f]{6}$/iu.test(translationColor)
    || !/^#[0-9a-f]{6}$/iu.test(originalColor)
    || !Number.isInteger(translationFontScale) || translationFontScale < 80 || translationFontScale > 160
    || !Number.isInteger(originalFontScale) || originalFontScale < 80 || originalFontScale > 160
  ) {
    return null;
  }
  return {
    ...base,
    subtitles: {
      ...base.subtitles,
      displayMode,
      shortsTranslationEnabled,
      translationColor,
      originalColor,
      translationFontScale,
      originalFontScale,
    },
    selection: {
      enabled: queryRequired<HTMLInputElement>("#selection-enabled").checked,
      includeContext: queryRequired<HTMLInputElement>("#include-context").checked,
    },
  };
}

function scheduleSettingsSave(settings: ExtensionSettings, translationSave = false): void {
  pendingSettings = settings;
  pendingTranslationSave ||= translationSave;
  if (translationSave) {
    setTranslationStatus(t("options.saving"));
  }
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void flushSettingsSave();
  }, 180);
}

async function flushSettingsSave(): Promise<void> {
  if (saveInFlight || !pendingSettings) {
    return;
  }

  const settings = pendingSettings;
  const translationSave = pendingTranslationSave;
  pendingSettings = null;
  inFlightSettings = settings;
  pendingTranslationSave = false;
  saveInFlight = true;
  let saveFailed = false;
  try {
    await createChromeSettingsRepository().saveSettings(settings);
    committedSettings = settings;
    if (translationSave && queryRequired<HTMLSelectElement>("#provider-id").value === settings.provider.providerId) {
      const draft = getProviderDraft(settings.provider.providerId);
      if (
        draft.apiKey.trim() === settings.apiKeys[settings.provider.providerId] &&
        draft.model === settings.provider.model
      ) {
        setTranslationStatus(t("options.saved"), "success");
      }
    }
    if (translationSave) {
      void chrome.runtime
        .sendMessage({ type: MESSAGE_TYPE.updateVideoTranslationStatus, status: { phase: "idle" } })
        .catch(() => undefined);
    }
  } catch {
    saveFailed = true;
    pendingSettings ??= settings;
    pendingTranslationSave ||= translationSave;
    if (translationSave) {
      setTranslationStatus(t("options.saveFailed"), "error");
    } else {
      showToast(t("options.preferencesSaveFailed"), "error");
    }
  } finally {
    inFlightSettings = null;
    saveInFlight = false;
    if (pendingSettings && !saveFailed) {
      void flushSettingsSave();
    }
  }
}

function saveGeneralSettings(): void {
  const settings = buildGeneralSettings();
  if (settings) {
    scheduleSettingsSave(settings);
  }
}

function getTranslationFormValues(): { providerId: string; apiKey: string; model: string } | null {
  const providerId = queryRequired<HTMLSelectElement>("#provider-id").value.trim();
  const apiKey = queryRequired<HTMLInputElement>("#api-key").value.trim();
  const model = queryRequired<HTMLSelectElement>("#model").value.trim();
  const draft = getProviderDraft(providerId);
  if (!providerId || !apiKey || !model || draft.apiKey.trim() !== apiKey || draft.model !== model || draft.modelLoadedForApiKey !== apiKey) {
    return null;
  }
  return { providerId, apiKey, model };
}

function commitTranslationService(): boolean {
  const values = getTranslationFormValues();
  if (!values || !committedSettings) {
    return false;
  }

  const base = pendingSettings ?? inFlightSettings ?? committedSettings;
  const next: ExtensionSettings = {
    ...base,
    provider: { providerId: values.providerId, model: values.model },
    apiKeys: { ...base.apiKeys, [values.providerId]: values.apiKey },
    providerModels: { ...base.providerModels, [values.providerId]: values.model },
  };
  const currentApiKey = base.apiKeys[values.providerId] ?? "";
  const currentModel = resolveProviderModel(base, values.providerId);
  if (base.provider.providerId === values.providerId && currentApiKey === values.apiKey && currentModel === values.model) {
    setTranslationStatus(t("options.saved"), "success");
    return true;
  }
  scheduleSettingsSave(next, true);
  return true;
}

async function loadOptions(): Promise<void> {
  const settings = await createChromeSettingsRepository().loadSettings();
  const supportedProviderId = getProviderPreset(settings.provider.providerId)
    ? settings.provider.providerId
    : DEFAULT_PROVIDER_ID;
  const providerSettings = supportedProviderId === settings.provider.providerId
    ? settings
    : {
        ...settings,
        provider: { providerId: supportedProviderId, model: "" },
      };
  const apiKey = resolveProviderApiKey(providerSettings);
  committedSettings = providerSettings;
  providerDrafts.clear();
  providerDrafts.set(providerSettings.provider.providerId, {
    apiKey,
    model: resolveProviderModel(providerSettings),
    modelLoadedForApiKey: apiKey && resolveProviderModel(providerSettings) ? apiKey : "",
  });
  queryRequired<HTMLInputElement>("#api-key").value = apiKey;
  queryRequired<HTMLSelectElement>("#caption-mode").value = providerSettings.subtitles.displayMode;
  queryRequired<HTMLInputElement>("#shorts-translation-enabled").checked = providerSettings.subtitles.shortsTranslationEnabled;
  queryRequired<HTMLInputElement>("#translation-color").value = providerSettings.subtitles.translationColor;
  queryRequired<HTMLInputElement>("#original-color").value = providerSettings.subtitles.originalColor;
  queryRequired<HTMLInputElement>("#translation-font-scale").value = String(providerSettings.subtitles.translationFontScale);
  queryRequired<HTMLInputElement>("#original-font-scale").value = String(providerSettings.subtitles.originalFontScale);
  updateSubtitleFontScaleLabels();
  queryRequired<HTMLInputElement>("#selection-enabled").checked = providerSettings.selection.enabled;
  queryRequired<HTMLInputElement>("#include-context").checked = providerSettings.selection.includeContext;
  populateProviders(providerSettings.provider.providerId);
  activeProviderId = providerSettings.provider.providerId;
  const resolvedModel = await loadModels(providerSettings.provider.providerId, apiKey, resolveProviderModel(providerSettings));
  if (resolvedModel && apiKey) {
    commitTranslationService();
  }
  await loadCacheList();
}

function bindForm(): void {
  const form = queryRequired<HTMLFormElement>("#settings-form");
  const providerSelect = queryRequired<HTMLSelectElement>("#provider-id");
  const apiKeyInput = queryRequired<HTMLInputElement>("#api-key");
  const modelSelect = queryRequired<HTMLSelectElement>("#model");
  const loadModelsButton = queryRequired<HTMLButtonElement>("#load-models");
  const captionModeSelect = queryRequired<HTMLSelectElement>("#caption-mode");
  const shortsTranslationEnabledInput = queryRequired<HTMLInputElement>("#shorts-translation-enabled");
  const translationColorInput = queryRequired<HTMLInputElement>("#translation-color");
  const originalColorInput = queryRequired<HTMLInputElement>("#original-color");
  const translationFontScaleInput = queryRequired<HTMLInputElement>("#translation-font-scale");
  const originalFontScaleInput = queryRequired<HTMLInputElement>("#original-font-scale");
  const selectionEnabledInput = queryRequired<HTMLInputElement>("#selection-enabled");
  const includeContextInput = queryRequired<HTMLInputElement>("#include-context");

  modelSelect.addEventListener("change", () => {
    const providerId = providerSelect.value;
    const draft = getProviderDraft(providerId);
    providerDrafts.set(providerId, { ...draft, model: modelSelect.value });
    commitTranslationService();
  });
  captionModeSelect.addEventListener("change", saveGeneralSettings);
  shortsTranslationEnabledInput.addEventListener("change", saveGeneralSettings);
  translationColorInput.addEventListener("input", saveGeneralSettings);
  originalColorInput.addEventListener("input", saveGeneralSettings);
  translationFontScaleInput.addEventListener("input", () => {
    updateSubtitleFontScaleLabels();
    saveGeneralSettings();
  });
  originalFontScaleInput.addEventListener("input", () => {
    updateSubtitleFontScaleLabels();
    saveGeneralSettings();
  });
  selectionEnabledInput.addEventListener("change", saveGeneralSettings);
  includeContextInput.addEventListener("change", saveGeneralSettings);
  apiKeyInput.addEventListener("input", () => {
    const providerId = providerSelect.value;
    providerDrafts.set(providerId, {
      apiKey: apiKeyInput.value,
      model: "",
      modelLoadedForApiKey: "",
    });
    modelSelect.replaceChildren();
    modelSelect.disabled = true;
    setTranslationStatus(apiKeyInput.value.trim() ? t("options.apiKeyChanged") : t("options.enterApiKey"));
    updateLoadModelsButton();
  });

  providerSelect.addEventListener("change", () => {
    captureActiveProviderDraft();
    activeProviderId = providerSelect.value;
    const providerId = activeProviderId;
    const loadVersion = ++modelLoadVersion;
    const draft = getProviderDraft(providerId);
    apiKeyInput.value = draft.apiKey;
    modelSelect.replaceChildren();
    modelSelect.disabled = true;
    updateLoadModelsButton();
    setTranslationStatus(draft.apiKey ? t("options.loadingConfiguredModels") : t("options.enterApiKey"));
    if (draft.apiKey && draft.model && draft.modelLoadedForApiKey === draft.apiKey) {
      void commitTranslationService();
    }
    void loadModels(providerId, draft.apiKey, draft.model, () => loadVersion === modelLoadVersion && providerSelect.value === providerId)
      .then(() => {
        if (loadVersion === modelLoadVersion && providerSelect.value === providerId) {
          commitTranslationService();
        }
      });
  });

  loadModelsButton.addEventListener("click", () => {
    const providerId = providerSelect.value;
    const loadVersion = ++modelLoadVersion;
    void loadModels(providerId, apiKeyInput.value, "", () => loadVersion === modelLoadVersion && providerSelect.value === providerId)
      .then(() => {
        if (loadVersion === modelLoadVersion && providerSelect.value === providerId) {
          commitTranslationService();
        }
      });
  });

  queryRequired<HTMLButtonElement>("#refresh-cache").addEventListener("click", () => {
    void loadCacheList();
  });
  queryRequired<HTMLButtonElement>("#clear-all-cache").addEventListener("click", () => {
    void chrome.runtime
      .sendMessage({ type: MESSAGE_TYPE.clearAllCache })
      .then(() => loadCacheList())
      .catch(() => showToast(t("options.clearFailed"), "error"));
  });
  queryRequired<HTMLButtonElement>("#reset-subtitle-style").addEventListener("click", () => {
    translationColorInput.value = DEFAULT_SUBTITLE_SETTINGS.translationColor;
    originalColorInput.value = DEFAULT_SUBTITLE_SETTINGS.originalColor;
    translationFontScaleInput.value = String(DEFAULT_SUBTITLE_SETTINGS.translationFontScale);
    originalFontScaleInput.value = String(DEFAULT_SUBTITLE_SETTINGS.originalFontScale);
    updateSubtitleFontScaleLabels();
    const base = pendingSettings ?? inFlightSettings ?? committedSettings;
    const displayMode = parseCaptionDisplayMode(captionModeSelect.value);
    if (base && displayMode) {
      scheduleSettingsSave({
        ...base,
        subtitles: {
          ...DEFAULT_SUBTITLE_SETTINGS,
          displayMode,
        },
      });
      showToast(t("options.captionStyleRestored"), "success");
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (apiKeyInput.value.trim() && !modelSelect.value) {
      loadModelsButton.click();
      return;
    }
    commitTranslationService();
  });
}

function updateSubtitleFontScaleLabels(): void {
  const translationScale = queryRequired<HTMLInputElement>("#translation-font-scale").value;
  const originalScale = queryRequired<HTMLInputElement>("#original-font-scale").value;
  queryRequired<HTMLOutputElement>("#translation-font-scale-value").value = `${translationScale}%`;
  queryRequired<HTMLOutputElement>("#original-font-scale-value").value = `${originalScale}%`;
}

async function initialize(): Promise<void> {
  bindForm();
  void loadUpdate();
  try {
    await loadOptions();
  } catch {
    showToast(t("options.loadFailed"), "error");
  }
}

localizeDocument(document);
void initialize();
