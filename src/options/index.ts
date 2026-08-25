import {
  isListCacheResponse,
  MESSAGE_TYPE,
} from "../shared/contracts/messages";
import {
  parseCaptionDisplayMode,
  resolveProviderApiKey,
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

function setModelStatus(message: string, isError: boolean): void {
  const status = queryRequired<HTMLElement>("#model-status");
  status.textContent = message;
  status.dataset.state = isError ? "error" : "success";
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

function populateModels(models: readonly string[], current: string, defaultModel: string): void {
  const select = queryRequired<HTMLSelectElement>("#model");
  select.replaceChildren();

  let preferred = current;
  if (!preferred || !models.includes(preferred)) {
    preferred = models.includes(defaultModel) ? defaultModel : (models[0] ?? "");
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    select.append(option);
  }

  if (preferred) {
    select.value = preferred;
  }
  select.disabled = models.length === 0;
}

async function loadModels(
  providerId: string,
  apiKey: string,
  currentModel = "",
  isCurrent: () => boolean = () => true,
): Promise<string> {
  const modelSelect = queryRequired<HTMLSelectElement>("#model");

  if (!apiKey) {
    if (!isCurrent()) {
      return "";
    }
    modelSelect.replaceChildren();
    modelSelect.disabled = true;
    setModelStatus("填写服务密钥后会加载可用模型。", false);
    return "";
  }

  if (!isCurrent()) {
    return "";
  }
  setModelStatus("正在查找可用模型…", false);
  const preset = getProviderPreset(providerId);
  if (!preset) {
    if (!isCurrent()) {
      return "";
    }
    modelSelect.replaceChildren();
    modelSelect.disabled = true;
    setModelStatus("暂时无法识别该翻译服务。", true);
    return "";
  }

  try {
    const adapter = createProviderAdapter(preset, (input, init) => fetch(input, init));
    const result = await adapter.listModels(apiKey);
    if (!isCurrent()) {
      return "";
    }
    if (result.ok) {
      populateModels(result.models, currentModel, preset.defaultModel);
      setModelStatus(`找到 ${result.models.length} 个可用模型。`, false);
      return modelSelect.value;
    } else {
      modelSelect.replaceChildren();
      modelSelect.disabled = true;
      setModelStatus(result.error.message, true);
    }
  } catch {
    modelSelect.replaceChildren();
    modelSelect.disabled = true;
    setModelStatus("模型列表暂时无法加载，请检查网络或服务密钥。", true);
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

let savedSettings: ExtensionSettings | null = null;
let activeProviderId = "";
let saveChain: Promise<void> = Promise.resolve();
let saveVersion = 0;
let apiKeySaveTimer: number | null = null;
let modelLoadVersion = 0;

function currentFormSettings(): ExtensionSettings | null {
  const providerId = queryRequired<HTMLSelectElement>("#provider-id").value;
  const apiKey = queryRequired<HTMLInputElement>("#api-key").value;
  const modelSelect = queryRequired<HTMLSelectElement>("#model");
  const savedModel = savedSettings?.provider.providerId === providerId ? savedSettings.provider.model : "";
  const fallbackModel = savedModel || getProviderPreset(providerId)?.defaultModel || "";
  const model = modelSelect.value || fallbackModel;
  const displayMode = parseCaptionDisplayMode(queryRequired<HTMLSelectElement>("#caption-mode").value);
  const selectionEnabled = queryRequired<HTMLInputElement>("#selection-enabled").checked;
  const includeContext = queryRequired<HTMLInputElement>("#include-context").checked;
  if (!displayMode || !providerId || !model) {
    return null;
  }
  const apiKeys = { ...(savedSettings?.apiKeys ?? {}), [providerId]: apiKey };
  return {
    provider: { providerId, model },
    apiKeys,
    subtitles: { displayMode },
    selection: { enabled: selectionEnabled, includeContext },
  };
}

async function loadOptions(): Promise<void> {
  const settings = await createChromeSettingsRepository().loadSettings();
  const apiKey = resolveProviderApiKey(settings);
  queryRequired<HTMLInputElement>("#api-key").value = apiKey;
  queryRequired<HTMLSelectElement>("#caption-mode").value = settings.subtitles.displayMode;
  queryRequired<HTMLInputElement>("#selection-enabled").checked = settings.selection.enabled;
  queryRequired<HTMLInputElement>("#include-context").checked = settings.selection.includeContext;
  populateProviders(settings.provider.providerId);
  const resolvedModel = await loadModels(settings.provider.providerId, apiKey, settings.provider.model);
  const resolvedSettings = resolvedModel && resolvedModel !== settings.provider.model
    ? { ...settings, provider: { ...settings.provider, model: resolvedModel } }
    : settings;
  if (resolvedSettings !== settings) {
    await createChromeSettingsRepository().saveSettings(resolvedSettings);
  }
  savedSettings = resolvedSettings;
  activeProviderId = settings.provider.providerId;
  await loadCacheList();
}

function clearApiKeySaveTimer(): void {
  if (apiKeySaveTimer !== null) {
    window.clearTimeout(apiKeySaveTimer);
    apiKeySaveTimer = null;
  }
}

function queueSettingsSave(): void {
  clearApiKeySaveTimer();
  const settings = currentFormSettings();
  if (!settings) {
    showToast("请先完成翻译服务、模型和字幕设置。", "error");
    return;
  }

  const version = ++saveVersion;
  saveChain = saveChain
    .catch(() => undefined)
    .then(async () => {
      await createChromeSettingsRepository().saveSettings(settings);
      if (version !== saveVersion) {
        return;
      }
      savedSettings = settings;
      showToast("偏好设置已保存。", "success");
      // Reset any stale per-video translation status so the popup reflects the new config.
      void chrome.runtime
        .sendMessage({ type: MESSAGE_TYPE.updateVideoTranslationStatus, status: { phase: "idle" } })
        .catch(() => undefined);
    })
    .catch(() => {
      if (version === saveVersion) {
        showToast("保存失败，请稍后再试。", "error");
      }
    });
}

function scheduleApiKeySave(): void {
  clearApiKeySaveTimer();
  apiKeySaveTimer = window.setTimeout(() => {
    apiKeySaveTimer = null;
    queueSettingsSave();
  }, 400);
}

function bindForm(): void {
  const form = queryRequired<HTMLFormElement>("#settings-form");
  const providerSelect = queryRequired<HTMLSelectElement>("#provider-id");
  const apiKeyInput = queryRequired<HTMLInputElement>("#api-key");
  const modelSelect = queryRequired<HTMLSelectElement>("#model");
  const captionModeSelect = queryRequired<HTMLSelectElement>("#caption-mode");
  const selectionEnabledInput = queryRequired<HTMLInputElement>("#selection-enabled");
  const includeContextInput = queryRequired<HTMLInputElement>("#include-context");

  modelSelect.addEventListener("change", queueSettingsSave);
  captionModeSelect.addEventListener("change", queueSettingsSave);
  selectionEnabledInput.addEventListener("change", queueSettingsSave);
  includeContextInput.addEventListener("change", queueSettingsSave);
  apiKeyInput.addEventListener("input", scheduleApiKeySave);

  providerSelect.addEventListener("change", () => {
    const previousProviderId = activeProviderId;
    if (savedSettings && previousProviderId) {
      savedSettings = {
        ...savedSettings,
        apiKeys: { ...savedSettings.apiKeys, [previousProviderId]: apiKeyInput.value },
      };
    }
    activeProviderId = providerSelect.value;
    const providerId = activeProviderId;
    const loadVersion = ++modelLoadVersion;
    // Switching provider restores the key saved for the newly selected provider,
    // or clears the field when none has been configured yet.
    apiKeyInput.value = savedSettings ? resolveProviderApiKey(savedSettings, providerSelect.value) : "";
    // Save the provider immediately. Waiting for the optional model-list request
    // used to leave the old provider active when the user returned to YouTube
    // before that request completed.
    modelSelect.replaceChildren();
    modelSelect.disabled = true;
    queueSettingsSave();
    void loadModels(providerId, apiKeyInput.value, "", () => loadVersion === modelLoadVersion && providerSelect.value === providerId)
      .then(() => {
        if (loadVersion === modelLoadVersion && providerSelect.value === providerId) {
          queueSettingsSave();
        }
      });
  });
  apiKeyInput.addEventListener("change", () => {
    clearApiKeySaveTimer();
    const providerId = providerSelect.value;
    const loadVersion = ++modelLoadVersion;
    void loadModels(providerId, apiKeyInput.value, modelSelect.value, () => loadVersion === modelLoadVersion && providerSelect.value === providerId)
      .then(() => {
        if (loadVersion === modelLoadVersion && providerSelect.value === providerId) {
          queueSettingsSave();
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
    clearApiKeySaveTimer();
    queueSettingsSave();
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
