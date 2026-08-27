import {
  isSettingsMessageResponse,
  isVideoCacheStats,
  isVideoTranslationStatus,
  parseExtensionMessage,
  MESSAGE_TYPE,
  type SettingsMessageResponse,
  type VideoTranslationCacheResponse,
  type TranslateTextMessage,
  type TranslateTextResponse,
  type TranslateVideoMessage,
  type TranslateVideoResponse,
  type VideoTranslationStatus,
} from "../shared/contracts/messages";
import { TextTranslationService } from "../shared/translation/text-translation-service";
import { AUTO_TARGET_LANGUAGE, resolveProviderApiKey } from "../shared/contracts/settings";
import { createBrowserLocaleEnvironment, resolveTargetLocale } from "../shared/locale/resolve-target-locale";
import { shouldTranslateText } from "../shared/locale/translation-needed";
import { createProviderAdapter, getProviderPreset } from "../shared/providers/provider-registry";
import { openExtensionDatabase } from "../shared/storage/extension-database";
import { createChromeSettingsRepository } from "../shared/storage/settings-repository";
import {
  buildVideoCacheKey,
  createChromeVideoTranslationRepository,
  type VideoTranslationRepository,
} from "../shared/storage/video-translation-cache";
import { VideoTranslationService, type BlockProgressWriter } from "./translation-service";
import { t } from "../shared/i18n";

const COMMENT_BATCH_CONCURRENCY = 3;

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

function updateVideoTranslationStatus(status: VideoTranslationStatus, tabId?: number): void {
  // An idle update without a videoId clears only the sending tab. The options
  // page has no tab id and intentionally clears all stale status records.
  if (status.phase === "idle" && status.videoId === undefined) {
    if (tabId === undefined) {
      videoTranslationStatuses.clear();
    } else {
      videoTranslationStatuses.delete(String(tabId));
    }
    return;
  }
  if (status.videoId && tabId !== undefined) {
    videoTranslationStatuses.set(String(tabId), { status, updatedAt: Date.now() });
  }
}

function getVideoTranslationStatus(tabId?: number): VideoTranslationStatus {
  if (tabId !== undefined) {
    return videoTranslationStatuses.get(String(tabId))?.status ?? { phase: "idle" };
  }

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

async function handleTranslateVideo(message: TranslateVideoMessage, tabId?: number): Promise<TranslateVideoResponse> {
  const { settings, resolvedTargetLocale } = await getSettingsResponse();
  if (!shouldTranslateText("", resolvedTargetLocale, message.sourceLanguage)) {
    return {
      ok: true,
      blocks: [],
      targetLanguage: resolvedTargetLocale,
      displayMode: settings.subtitles.displayMode,
      fromCache: true,
      missingIds: [],
      skipped: true,
    };
  }

  const apiKey = resolveProviderApiKey(settings).trim();
  if (!apiKey) {
    return { ok: false, errorMessage: t("background.notConnected") };
  }

  const preset = getProviderPreset(settings.provider.providerId);
  if (!preset) {
    return { ok: false, errorMessage: t("background.unknownService", { id: settings.provider.providerId }) };
  }

  const model = settings.provider.model.trim();
  if (!model) {
    return { ok: false, errorMessage: t("background.noModel") };
  }
  const adapter = createProviderAdapter(preset, (input, init) => fetch(input, init));

  const onBlockProgress: BlockProgressWriter | undefined = tabId === undefined
    ? undefined
    : (block) => {
        void chrome.tabs.sendMessage(tabId, {
          type: MESSAGE_TYPE.translateVideoProgress,
          runId: message.runId,
          videoId: message.videoId,
          sourceTrackFingerprint: message.sourceTrackFingerprint,
          targetLanguage: resolvedTargetLocale,
          displayMode: settings.subtitles.displayMode,
          block,
        }).catch(() => undefined);
      };

  return createTranslationService().translate(message, {
    sourceLanguage: message.sourceLanguage,
    targetLanguage: resolvedTargetLocale,
    displayMode: settings.subtitles.displayMode,
    adapter,
    apiKey,
    model,
  }, onBlockProgress);
}

async function handleGetVideoTranslationCache(message: { videoId: string }): Promise<VideoTranslationCacheResponse> {
  const { settings, resolvedTargetLocale } = await getSettingsResponse();
  const entry = await getVideoTranslationRepository().get(buildVideoCacheKey({ videoId: message.videoId }));
  if (!entry || entry.blocks.length === 0 || entry.targetLanguage !== resolvedTargetLocale) {
    return { found: false };
  }
  return {
    found: true,
    videoId: entry.videoId,
    videoTitle: entry.videoTitle,
    sourceTrackFingerprint: entry.sourceTrackFingerprint,
    sourceLanguage: entry.sourceLanguage,
    targetLanguage: entry.targetLanguage,
    displayMode: settings.subtitles.displayMode,
    blocks: entry.blocks,
  };
}

async function handleTranslateText(message: TranslateTextMessage): Promise<TranslateTextResponse> {
  const { settings, resolvedTargetLocale } = await getSettingsResponse();
  const skippedIds = message.items
    .filter((item) => !shouldTranslateText(item.sourceText, resolvedTargetLocale))
    .map((item) => item.id);
  if (skippedIds.length === message.items.length) {
    return {
      ok: true,
      translations: {},
      missingIds: [],
      targetLanguage: resolvedTargetLocale,
      skippedIds,
    };
  }

  const apiKey = resolveProviderApiKey(settings).trim();
  if (!apiKey) {
    return { ok: false, errorMessage: t("background.notConnected") };
  }

  const preset = getProviderPreset(settings.provider.providerId);
  if (!preset) {
    return { ok: false, errorMessage: t("background.unknownService", { id: settings.provider.providerId }) };
  }

  const model = settings.provider.model.trim();
  if (!model) {
    return { ok: false, errorMessage: t("background.noModel") };
  }
  const adapter = createProviderAdapter(preset, (input, init) => fetch(input, init));

  const run = await new TextTranslationService().translate(message.items, {
    targetLanguage: resolvedTargetLocale,
    adapter,
    apiKey,
    model,
    ...(message.scope === "comment" && message.videoTitle ? { videoTitle: message.videoTitle } : {}),
    maxConcurrentBatches: message.scope === "comment" ? COMMENT_BATCH_CONCURRENCY : 1,
  });

  if (!run.ok) {
    return { ok: false, errorMessage: run.errorMessage };
  }
  return {
    ok: true,
    translations: run.translations,
    missingIds: run.missingIds,
    targetLanguage: resolvedTargetLocale,
    ...(run.skippedIds && run.skippedIds.length > 0 ? { skippedIds: run.skippedIds } : {}),
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
  };
}

async function reportAsyncFailure(sendResponse: (response: unknown) => void, fallback: string): Promise<void> {
  sendResponse({ error: fallback });
}

const CONTEXT_MENU_ID = "xtranslator-translate-selection";
let contextMenuSync: Promise<void> = Promise.resolve();

function removeAllContextMenus(): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function createSelectionContextMenu(): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: t("background.contextMenu"),
        contexts: ["selection"],
      },
      () => {
        void chrome.runtime.lastError;
        resolve();
      },
    );
  });
}

function ensureContextMenu(): Promise<void> {
  const sync = contextMenuSync.then(async () => {
    if (typeof chrome === "undefined" || !chrome.contextMenus) {
      return;
    }

    let enabled = true;
    try {
      enabled = (await createChromeSettingsRepository().loadSettings()).selection.enabled;
    } catch {
      // Keep the legacy/default behavior if settings are temporarily unavailable.
    }

    await removeAllContextMenus();
    if (enabled) {
      await createSelectionContextMenu();
    }
  });
  contextMenuSync = sync.catch(() => undefined);
  return contextMenuSync;
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
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (response: unknown) => void) => {
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
        sendResponse(getVideoTranslationStatus(parsedMessage.tabId));
        return false;
      case "get-video-translation-cache":
        void handleGetVideoTranslationCache(parsedMessage)
          .then(sendResponse)
          .catch(() => sendResponse({ found: false }));
        return true;
      case "update-video-translation-status":
        if (isVideoTranslationStatus(parsedMessage.status)) {
          updateVideoTranslationStatus(parsedMessage.status, sender.tab?.id);
          sendResponse({ ok: true });
        } else {
          sendResponse({ error: "Invalid xTranslator translation status." });
        }
        return false;
      case "translate-video":
        void handleTranslateVideo(parsedMessage, sender.tab?.id)
          .then(sendResponse)
          .catch(() => reportAsyncFailure(sendResponse, t("background.videoFailed")));
        return true;
      case "translate-text":
        void handleTranslateText(parsedMessage)
          .then(sendResponse)
          .catch(() => reportAsyncFailure(sendResponse, t("background.translationFailed")));
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
                .filter((entry) => Array.isArray(entry.blocks))
                .map((entry) => ({
                  title: entry.videoTitle || entry.videoId,
                  videoId: entry.videoId,
                  sourceLanguage: entry.sourceLanguage,
                  targetLanguage: entry.targetLanguage,
                  blockCount: entry.blocks.length,
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
