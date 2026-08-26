import {
  isSettingsMessageResponse,
  isVideoTranslationStatus,
  MESSAGE_TYPE,
  type SettingsMessageResponse,
  type VideoTranslationStatus,
} from "../shared/contracts/messages";
import { createIcons, Settings } from "../shared/icons";
import { getProviderPreset } from "../shared/providers/provider-registry";
import { resolveProviderApiKey } from "../shared/contracts/settings";
import { checkForExtensionUpdate } from "../shared/extension-update";
import { getUiLocale, localizeDocument, t } from "../shared/i18n";

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing popup element: ${selector}`);
  }

  return element;
}

function updateConfig(response: SettingsMessageResponse): void {
  const detail = queryRequired<HTMLElement>("#config-detail");
  const panel = queryRequired<HTMLElement>("#config-panel");
  const preset = getProviderPreset(response.settings.provider.providerId);
  const name = preset?.displayName ?? response.settings.provider.providerId;
  const model = response.settings.provider.model;

  if (resolveProviderApiKey(response.settings)) {
    detail.textContent = t("popup.connected", { name, model: model ? ` · ${model}` : "" });
    panel.dataset.state = "ready";
  } else {
    detail.textContent = t("popup.notConnected");
    panel.dataset.state = "error";
  }
}

function formatLocaleName(locale: string): string {
  try {
    return new Intl.DisplayNames([getUiLocale()], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

function updateLocale(response: SettingsMessageResponse): void {
  const detail = queryRequired<HTMLElement>("#locale-detail");
  const panel = queryRequired<HTMLElement>("#locale-panel");
  detail.textContent = t("popup.browserLanguage", { language: formatLocaleName(response.resolvedTargetLocale) });
  panel.dataset.state = "ready";
}

function updateVideoTranslationStatus(status: VideoTranslationStatus): void {
  const title = queryRequired<HTMLElement>("#translation-video-title");
  const detail = queryRequired<HTMLElement>("#translation-detail");
  const panel = queryRequired<HTMLElement>("#translation-panel");
  title.textContent = status.videoTitle ?? t("popup.readyToTranslate");

  switch (status.phase) {
    case "idle":
      detail.textContent = t("popup.openYoutubeVideo");
      panel.dataset.state = "idle";
      break;
    case "reading-captions":
      detail.textContent = t("popup.preparingCaptions");
      panel.dataset.state = "loading";
      break;
    case "ready-for-translation":
      detail.textContent = t("popup.captionsReady");
      panel.dataset.state = "success";
      break;
    case "translating":
      detail.textContent = t("popup.translatingCaptions", { count: status.segmentCount ?? 0 });
      panel.dataset.state = "loading";
      break;
    case "translated":
      detail.textContent = status.segmentCount === 0
        ? t("popup.noTranslationNeeded")
        : t("popup.translationComplete", { translated: status.translatedCount ?? 0, total: status.segmentCount ?? 0 });
      panel.dataset.state = "success";
      break;
    case "error":
      detail.textContent = status.errorMessage ?? t("popup.videoUnavailable");
      panel.dataset.state = "error";
      break;
  }
}

async function loadConfig(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.getSettings });
    if (!isSettingsMessageResponse(response)) {
      throw new Error("Invalid settings response.");
    }
    updateConfig(response);
    updateLocale(response);
  } catch {
    // Keep the placeholder state if the service worker is temporarily unavailable.
  }
}

async function loadVideoTranslationStatus(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.getVideoTranslationStatus,
      ...(typeof tabId === "number" ? { tabId } : {}),
    });
    if (!isVideoTranslationStatus(response)) {
      throw new Error("Invalid video translation status.");
    }
    updateVideoTranslationStatus(response);
  } catch {
    updateVideoTranslationStatus({ phase: "error", errorMessage: t("popup.statusUnavailable") });
  }
}

function bindOptionsButton(): void {
  queryRequired<HTMLButtonElement>("#open-options").addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
}

async function loadUpdate(): Promise<void> {
  const result = await checkForExtensionUpdate(chrome.runtime.getManifest().version);
  if (result.state === "available") {
    const panel = queryRequired<HTMLElement>("#update-panel");
    const detail = queryRequired<HTMLElement>("#update-detail");
    const link = queryRequired<HTMLAnchorElement>("#download-update");
    detail.textContent = t("popup.updateDetail", { version: result.update.version });
    link.href = result.update.downloadUrl;
    panel.hidden = false;
  }
}

createIcons({ icons: { Settings } });
localizeDocument(document);
bindOptionsButton();
void loadConfig();
void loadVideoTranslationStatus();
void loadUpdate();
window.setInterval(() => void loadVideoTranslationStatus(), 1000);
