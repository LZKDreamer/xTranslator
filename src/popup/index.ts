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
  const model = response.settings.provider.model || preset?.defaultModel || "";

  if (resolveProviderApiKey(response.settings)) {
    detail.textContent = `已连接 ${name}${model ? ` · ${model}` : ""}`;
    panel.dataset.state = "ready";
  } else {
    detail.textContent = "尚未连接翻译服务，请打开设置完成连接。";
    panel.dataset.state = "error";
  }
}

function formatLocaleName(locale: string): string {
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

function updateLocale(response: SettingsMessageResponse): void {
  const detail = queryRequired<HTMLElement>("#locale-detail");
  const panel = queryRequired<HTMLElement>("#locale-panel");
  detail.textContent = `自动跟随浏览器语言 · ${formatLocaleName(response.resolvedTargetLocale)}`;
  panel.dataset.state = "ready";
}

function updateVideoTranslationStatus(status: VideoTranslationStatus): void {
  const title = queryRequired<HTMLElement>("#translation-video-title");
  const detail = queryRequired<HTMLElement>("#translation-detail");
  const panel = queryRequired<HTMLElement>("#translation-panel");
  title.textContent = status.videoTitle ?? "准备好开始翻译";

  switch (status.phase) {
    case "idle":
      detail.textContent = "打开 YouTube 视频，点击播放器中的 xTranslator 按钮。";
      panel.dataset.state = "idle";
      break;
    case "reading-captions":
      detail.textContent = "正在准备字幕…";
      panel.dataset.state = "loading";
      break;
    case "ready-for-translation":
      detail.textContent = "字幕已准备好，马上开始翻译。";
      panel.dataset.state = "success";
      break;
    case "translating":
      detail.textContent = `正在翻译 ${status.segmentCount ?? 0} 处字幕…`;
      panel.dataset.state = "loading";
      break;
    case "translated":
      detail.textContent = `翻译完成 · ${status.translatedCount ?? 0}/${status.segmentCount ?? 0} 处字幕`;
      panel.dataset.state = "success";
      break;
    case "error":
      detail.textContent = status.errorMessage ?? "这段视频暂时无法翻译，请稍后再试。";
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
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.getVideoTranslationStatus });
    if (!isVideoTranslationStatus(response)) {
      throw new Error("Invalid video translation status.");
    }
    updateVideoTranslationStatus(response);
  } catch {
    updateVideoTranslationStatus({ phase: "error", errorMessage: "视频翻译状态暂时不可用。" });
  }
}

function bindOptionsButton(): void {
  queryRequired<HTMLButtonElement>("#open-options").addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
}

createIcons({ icons: { Settings } });
bindOptionsButton();
void loadConfig();
void loadVideoTranslationStatus();
window.setInterval(() => void loadVideoTranslationStatus(), 1000);
