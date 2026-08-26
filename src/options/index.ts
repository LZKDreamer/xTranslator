import {
  isListCacheResponse,
  MESSAGE_TYPE,
} from "../shared/contracts/messages";
import {
  DEFAULT_PROVIDER_ID,
  parseCaptionDisplayMode,
  resolveProviderApiKey,
  resolveProviderModel,
  type CaptionDisplayMode,
  type ExtensionSettings,
} from "../shared/contracts/settings";
import { createProviderAdapter, getProviderPreset, listProviderPresets } from "../shared/providers/provider-registry";
import { createChromeSettingsRepository } from "../shared/storage/settings-repository";

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
  return new Date(value).toLocaleString();
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
    setTranslationStatus("暂时无法识别该翻译服务。", "error");
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
    setTranslationStatus("请填写 API Key 后加载模型。");
    return "";
  }

  if (!isCurrent()) {
    return "";
  }
  loadModelsButton.disabled = true;
  setTranslationStatus("正在查找可用模型…");

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
        ? (normalizedApiKey ? `找到 ${result.models.length} 个可用模型。` : `找到 ${result.models.length} 个模型，请填写 API Key 后保存。`)
        : "没有可用模型。", model ? "success" : "error");
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
      setTranslationStatus("模型列表暂时无法加载，请检查网络或服务密钥。", "error");
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
    emptyEl.textContent = "翻译记录暂时无法加载。";
    emptyEl.hidden = false;
    return;
  }

  if (!isListCacheResponse(response)) {
    listEl.replaceChildren();
    statsEl.textContent = "";
    emptyEl.textContent = "翻译记录暂时无法加载。";
    emptyEl.hidden = false;
    return;
  }

  listEl.replaceChildren();
  statsEl.textContent = `已保存 ${response.entries.length} 条记录 · ${formatBytes(response.totalBytes)}`;
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
    meta.textContent = `${entry.sourceLanguage}→${entry.targetLanguage} · ${entry.blockCount} 段 · ${formatDate(entry.updatedAt)}`;

    info.append(title, meta);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "cache-delete";
    deleteButton.textContent = "删除";
    deleteButton.setAttribute("aria-label", `删除 ${entry.title} 的翻译记录`);
    deleteButton.addEventListener("click", () => {
      void chrome.runtime
        .sendMessage({ type: MESSAGE_TYPE.clearVideoCache, videoId: entry.videoId })
        .then(() => loadCacheList())
        .catch(() => showToast("删除这条记录失败，请稍后再试。", "error"));
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
  if (!displayMode) {
    return null;
  }
  return {
    ...base,
    subtitles: { displayMode },
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
    setTranslationStatus("正在保存配置…");
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
        setTranslationStatus("配置已保存。", "success");
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
      setTranslationStatus("配置保存失败，请稍后重试。", "error");
    } else {
      showToast("偏好设置保存失败，请稍后重试。", "error");
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
    setTranslationStatus("配置已保存。", "success");
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
  const selectionEnabledInput = queryRequired<HTMLInputElement>("#selection-enabled");
  const includeContextInput = queryRequired<HTMLInputElement>("#include-context");

  modelSelect.addEventListener("change", () => {
    const providerId = providerSelect.value;
    const draft = getProviderDraft(providerId);
    providerDrafts.set(providerId, { ...draft, model: modelSelect.value });
    commitTranslationService();
  });
  captionModeSelect.addEventListener("change", saveGeneralSettings);
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
    setTranslationStatus(apiKeyInput.value.trim() ? "API Key 已变化，请点击“加载模型”。" : "请填写 API Key 后加载模型。");
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
    setTranslationStatus(draft.apiKey ? "正在加载已配置模型…" : "请填写 API Key 后加载模型。");
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
      .catch(() => showToast("清空翻译记录失败，请稍后再试。", "error"));
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

async function initialize(): Promise<void> {
  bindForm();
  try {
    await loadOptions();
  } catch {
    showToast("偏好设置暂时无法加载，请刷新重试。", "error");
  }
}

void initialize();
