import {
  isSettingsMessageResponse,
  isVideoCacheStats,
  isVideoTranslationStatus,
  parseExtensionMessage,
  MESSAGE_TYPE,
  type SettingsMessageResponse,
  type TranslateTextMessage,
  type TranslateTextResponse,
  type TranslateVideoMessage,
  type TranslateVideoResponse,
  type VideoTranslationStatus,
} from "../shared/contracts/messages";
import { TextTranslationService } from "../shared/translation/text-translation-service";
import { AUTO_TARGET_LANGUAGE, resolveProviderApiKey } from "../shared/contracts/settings";
import { createBrowserLocaleEnvironment, resolveTargetLocale } from "../shared/locale/resolve-target-locale";
import { createProviderAdapter, getProviderPreset } from "../shared/providers/provider-registry";
import { openExtensionDatabase } from "../shared/storage/extension-database";
import { createChromeSettingsRepository } from "../shared/storage/settings-repository";
import {
  createChromeVideoTranslationRepository,
  type VideoTranslationRepository,
} from "../shared/storage/video-translation-cache";
import { VideoTranslationService } from "./translation-service";

async function getSettingsResponse(): Promise<SettingsMessageResponse> {
  const settings = await createChromeSettingsRepository().loadSettings();
  const resolvedTargetLocale = resolveTargetLocale(AUTO_TARGET_LANGUAGE, createBrowserLocaleEnvironment());
  return { settings, resolvedTargetLocale };
}

interface TimedTranslationStatus {
  status: VideoTranslationStatus;
  updatedAt: number;
}

const videoTranslationStatuses = new Map<string, TimedTranslationStatus>();

function updateVideoTranslationStatus(status: VideoTranslationStatus): void {
  // An idle update without a videoId is a reset (e.g. after settings change).
  if (status.phase === "idle" && status.videoId === undefined) {
    videoTranslationStatuses.clear();
    return;
  }
  if (status.videoId) {
    videoTranslationStatuses.set(status.videoId, { status, updatedAt: Date.now() });
  }
}

function getLatestVideoTranslationStatus(): VideoTranslationStatus {
  let latest: TimedTranslationStatus | null = null;
  for (const entry of videoTranslationStatuses.values()) {
    if (!latest || entry.updatedAt > latest.updatedAt) {
      latest = entry;
    }
  }
  return latest?.status ?? { phase: "idle" };
}

let translationCache: VideoTranslationRepository | null = null;

function getVideoTranslationRepository(): VideoTranslationRepository {
  translationCache ??= createChromeVideoTranslationRepository();
  return translationCache;
}

function createTranslationService(): VideoTranslationService {
  return new VideoTranslationService(getVideoTranslationRepository());
}

async function handleTranslateVideo(message: TranslateVideoMessage): Promise<TranslateVideoResponse> {
  const { settings, resolvedTargetLocale } = await getSettingsResponse();
  const apiKey = resolveProviderApiKey(settings).trim();
  if (!apiKey) {
    return { ok: false, errorMessage: "尚未连接翻译服务，请先完成偏好设置。" };
  }

  const preset = getProviderPreset(settings.provider.providerId);
  if (!preset) {
    return { ok: false, errorMessage: `暂时无法识别翻译服务：${settings.provider.providerId}` };
  }

  const model = settings.provider.model.trim() || preset.defaultModel;
  const adapter = createProviderAdapter(preset, (input, init) => fetch(input, init));

  return createTranslationService().translate(message, {
    sourceLanguage: message.sourceLanguage,
    targetLanguage: resolvedTargetLocale,
    displayMode: settings.subtitles.displayMode,
    adapter,
    apiKey,
    model,
  });
}

async function handleTranslateText(message: TranslateTextMessage): Promise<TranslateTextResponse> {
  const { settings, resolvedTargetLocale } = await getSettingsResponse();
  const apiKey = resolveProviderApiKey(settings).trim();
  if (!apiKey) {
    return { ok: false, errorMessage: "尚未连接翻译服务，请先完成偏好设置。" };
  }

  const preset = getProviderPreset(settings.provider.providerId);
  if (!preset) {
    return { ok: false, errorMessage: `暂时无法识别翻译服务：${settings.provider.providerId}` };
  }

  const model = settings.provider.model.trim() || preset.defaultModel;
  const adapter = createProviderAdapter(preset, (input, init) => fetch(input, init));

  const run = await new TextTranslationService().translate(message.items, {
    targetLanguage: resolvedTargetLocale,
    adapter,
    apiKey,
    model,
    singleItemBatches: message.scope === "comment",
  });

  if (!run.ok) {
    return { ok: false, errorMessage: run.errorMessage };
  }
  return {
    ok: true,
    translations: run.translations,
    missingIds: run.missingIds,
    targetLanguage: resolvedTargetLocale,
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
  };
}

async function reportAsyncFailure(sendResponse: (response: unknown) => void, fallback: string): Promise<void> {
  sendResponse({ error: fallback });
}

const CONTEXT_MENU_ID = "xtranslator-translate-selection";

async function ensureContextMenu(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.contextMenus) {
    return;
  }

  let enabled = true;
  try {
    enabled = (await createChromeSettingsRepository().loadSettings()).selection.enabled;
  } catch {
    // Keep the legacy/default behavior if settings are temporarily unavailable.
  }

  chrome.contextMenus.removeAll(() => {
    if (!enabled) {
      return;
    }
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "翻译所选文本",
      contexts: ["selection"],
    });
  });
}

function registerContextMenuListener(): void {
  if (typeof chrome === "undefined" || !chrome.contextMenus || !chrome.tabs) {
    return;
  }
  void ensureContextMenu();
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_ID || tab?.id === undefined) {
      return;
    }
    void chrome.tabs
      .sendMessage(tab.id, { type: MESSAGE_TYPE.translateSelectionFromContext })
      .catch(() => undefined);
  });
  chrome.runtime.onInstalled.addListener(() => ensureContextMenu());
  chrome.storage?.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.settings) {
      void ensureContextMenu();
    }
  });
}

if (typeof chrome !== "undefined") {
  registerContextMenuListener();
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: unknown) => void) => {
    const parsedMessage = parseExtensionMessage(message);
    if (!parsedMessage) {
      sendResponse({ error: "Unsupported xTranslator message." });
      return false;
    }

    switch (parsedMessage.type) {
      case "get-settings":
        void getSettingsResponse()
          .then((response) => {
            if (isSettingsMessageResponse(response)) {
              sendResponse(response);
            }
          })
          .catch(() => sendResponse({ error: "Unable to read xTranslator settings." }));
        return true;
      case "get-video-translation-status":
        sendResponse(getLatestVideoTranslationStatus());
        return false;
      case "update-video-translation-status":
        if (isVideoTranslationStatus(parsedMessage.status)) {
          updateVideoTranslationStatus(parsedMessage.status);
          sendResponse({ ok: true });
        } else {
          sendResponse({ error: "Invalid xTranslator translation status." });
        }
        return false;
      case "translate-video":
        void handleTranslateVideo(parsedMessage)
          .then(sendResponse)
          .catch(() => reportAsyncFailure(sendResponse, "视频翻译失败，请重试。"));
        return true;
      case "translate-text":
        void handleTranslateText(parsedMessage)
          .then(sendResponse)
          .catch(() => reportAsyncFailure(sendResponse, "翻译失败，请重试。"));
        return true;
      case "get-cache-stats":
        void getVideoTranslationRepository()
          .getStats()
          .then((stats) => sendResponse(isVideoCacheStats(stats) ? stats : { ok: true, entryCount: 0, totalBytes: 0 }))
          .catch(() => sendResponse({ ok: true, entryCount: 0, totalBytes: 0 }));
        return true;
      case "list-cache": {
        const repository = getVideoTranslationRepository();
        void Promise.all([repository.list(), repository.getStats()])
          .then(([entries, stats]) => {
            sendResponse({
              entries: entries
                .filter((entry) => typeof entry.blocks === "object" && entry.blocks !== null)
                .map((entry) => ({
                  title: entry.videoTitle || entry.videoId,
                  videoId: entry.videoId,
                  sourceLanguage: entry.sourceLanguage,
                  targetLanguage: entry.targetLanguage,
                  blockCount: Object.keys(entry.blocks).length,
                  updatedAt: entry.updatedAt,
                })),
              totalBytes: stats.totalBytes,
            });
          })
          .catch(() => sendResponse({ entries: [], totalBytes: 0 }));
        return true;
      }
      case "clear-video-cache":
        void getVideoTranslationRepository()
          .deleteByVideoId(parsedMessage.videoId)
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ error: "Unable to clear xTranslator cache." }));
        return true;
      case "clear-all-cache":
        void getVideoTranslationRepository()
          .clearAll()
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ error: "Unable to clear xTranslator cache." }));
        return true;
    }

    return false;
  });

  void openExtensionDatabase().catch(() => undefined);
}
