import type { TextTranslationItem, TranslatedBlock, TranslationSourceSegment } from "../translation/translation-types";
import type { CaptionDisplayMode, ExtensionSettings } from "./settings";
import { parseCaptionDisplayMode } from "./settings";

export const MESSAGE_TYPE = {
  getSettings: "get-settings",
  getVideoTranslationStatus: "get-video-translation-status",
  updateVideoTranslationStatus: "update-video-translation-status",
  translateVideo: "translate-video",
  translateText: "translate-text",
  translateSelectionFromContext: "translate-selection-from-context",
  getCacheStats: "get-cache-stats",
  listCache: "list-cache",
  clearVideoCache: "clear-video-cache",
  clearAllCache: "clear-all-cache",
} as const;

export interface GetSettingsMessage {
  type: typeof MESSAGE_TYPE.getSettings;
}

export type TranslationPhase = "idle" | "reading-captions" | "ready-for-translation" | "translating" | "translated" | "error";

export interface VideoTranslationStatus {
  phase: TranslationPhase;
  videoId?: string;
  videoTitle?: string;
  segmentCount?: number;
  translatedCount?: number;
  errorMessage?: string;
}

export interface GetVideoTranslationStatusMessage {
  type: typeof MESSAGE_TYPE.getVideoTranslationStatus;
}

export interface UpdateVideoTranslationStatusMessage {
  type: typeof MESSAGE_TYPE.updateVideoTranslationStatus;
  status: VideoTranslationStatus;
}

export interface TranslateVideoMessage {
  type: typeof MESSAGE_TYPE.translateVideo;
  videoId: string;
  videoTitle: string;
  videoDescription: string;
  sourceTrackFingerprint: string;
  sourceLanguage: string;
  segments: TranslationSourceSegment[];
}

export type TranslateVideoResponse =
  | {
      ok: true;
      blocks: TranslatedBlock[];
      targetLanguage: string;
      displayMode: CaptionDisplayMode;
      fromCache: boolean;
      missingIds: string[];
    }
  | {
      ok: false;
      errorMessage: string;
      partial?: {
        blocks: TranslatedBlock[];
        targetLanguage: string;
        displayMode: CaptionDisplayMode;
        missingIds: string[];
      };
    };

export type TextTranslationScope = "comment" | "selection";

export interface TranslateTextMessage {
  type: typeof MESSAGE_TYPE.translateText;
  scope: TextTranslationScope;
  items: TextTranslationItem[];
}

export type TranslateTextResponse =
  | {
      ok: true;
      translations: Record<string, string>;
      missingIds: string[];
      targetLanguage: string;
      errorMessage?: string;
    }
  | { ok: false; errorMessage: string };

export interface TranslateSelectionFromContextMessage {
  type: typeof MESSAGE_TYPE.translateSelectionFromContext;
}

export interface VideoCacheEntrySummary {
  title: string;
  videoId: string;
  sourceLanguage: string;
  targetLanguage: string;
  blockCount: number;
  updatedAt: number;
}

export interface VideoCacheStats {
  entryCount: number;
  totalBytes: number;
}

export interface GetCacheStatsMessage {
  type: typeof MESSAGE_TYPE.getCacheStats;
}

export interface ListCacheMessage {
  type: typeof MESSAGE_TYPE.listCache;
}

export interface ListCacheResponse {
  entries: VideoCacheEntrySummary[];
  totalBytes: number;
}

export interface ClearVideoCacheMessage {
  type: typeof MESSAGE_TYPE.clearVideoCache;
  videoId: string;
}

export interface ClearAllCacheMessage {
  type: typeof MESSAGE_TYPE.clearAllCache;
}

export type ExtensionMessage =
  | GetSettingsMessage
  | GetVideoTranslationStatusMessage
  | UpdateVideoTranslationStatusMessage
  | TranslateVideoMessage
  | TranslateTextMessage
  | GetCacheStatsMessage
  | ListCacheMessage
  | ClearVideoCacheMessage
  | ClearAllCacheMessage;

export interface SettingsMessageResponse {
  settings: ExtensionSettings;
  resolvedTargetLocale: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTranscriptFragment(value: unknown): { text: string; offsetMs?: number } | null {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text) {
    return null;
  }
  if (value.offsetMs !== undefined && (typeof value.offsetMs !== "number" || !Number.isFinite(value.offsetMs) || value.offsetMs < 0)) {
    return null;
  }
  return {
    text: value.text,
    ...(typeof value.offsetMs === "number" ? { offsetMs: value.offsetMs } : {}),
  };
}

function parseTranslationSourceSegment(value: unknown): TranslationSourceSegment | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || !value.id) {
    return null;
  }
  if (typeof value.sourceText !== "string") {
    return null;
  }
  if (typeof value.startMs !== "number" || !Number.isFinite(value.startMs)) {
    return null;
  }
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs)) {
    return null;
  }
  if (value.fragments !== undefined) {
    if (!Array.isArray(value.fragments)) {
      return null;
    }
    const fragments = value.fragments.flatMap((fragment) => {
      const parsed = parseTranscriptFragment(fragment);
      return parsed ? [parsed] : [];
    });
    if (fragments.length !== value.fragments.length) {
      return null;
    }
    return { id: value.id, sourceText: value.sourceText, startMs: value.startMs, durationMs: value.durationMs, fragments };
  }
  return { id: value.id, sourceText: value.sourceText, startMs: value.startMs, durationMs: value.durationMs };
}

function parseTextTranslationItem(value: unknown): TextTranslationItem | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || !value.id) {
    return null;
  }
  if (typeof value.sourceText !== "string") {
    return null;
  }
  if (value.contextBefore !== undefined && typeof value.contextBefore !== "string") {
    return null;
  }
  if (value.contextAfter !== undefined && typeof value.contextAfter !== "string") {
    return null;
  }
  return {
    id: value.id,
    sourceText: value.sourceText,
    ...(typeof value.contextBefore === "string" ? { contextBefore: value.contextBefore } : {}),
    ...(typeof value.contextAfter === "string" ? { contextAfter: value.contextAfter } : {}),
  };
}

function parseTranslatedBlock(value: unknown, allowEmptyTranslation = false): TranslatedBlock | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || !value.id) {
    return null;
  }
  if (!Array.isArray(value.segmentIds) || !value.segmentIds.every((id) => typeof id === "string" && id.length > 0)) {
    return null;
  }
  const segmentIds = value.segmentIds.filter((id): id is string => typeof id === "string");
  if (typeof value.sourceText !== "string") {
    return null;
  }
  if (typeof value.translatedText !== "string") {
    return null;
  }
  if (!allowEmptyTranslation && value.sourceText.trim() && !value.translatedText.trim()) {
    return null;
  }
  if (typeof value.startMs !== "number" || !Number.isFinite(value.startMs)) {
    return null;
  }
  if (typeof value.endMs !== "number" || !Number.isFinite(value.endMs)) {
    return null;
  }
  return {
    id: value.id,
    segmentIds,
    sourceText: value.sourceText,
    translatedText: value.translatedText,
    startMs: value.startMs,
    endMs: value.endMs,
  };
}

function parseVideoTranslationStatus(value: unknown): VideoTranslationStatus | null {
  if (!isRecord(value) || typeof value.phase !== "string") {
    return null;
  }

  const hasOptionalString = (key: "videoId" | "videoTitle" | "errorMessage"): boolean =>
    value[key] === undefined || typeof value[key] === "string";
  const hasOptionalCount = (key: "segmentCount" | "translatedCount"): boolean =>
    value[key] === undefined || (typeof value[key] === "number" && Number.isSafeInteger(value[key] as number) && (value[key] as number) >= 0);
  if (
    !hasOptionalString("videoId") ||
    !hasOptionalString("videoTitle") ||
    !hasOptionalString("errorMessage") ||
    !hasOptionalCount("segmentCount") ||
    !hasOptionalCount("translatedCount")
  ) {
    return null;
  }

  const phase = value.phase;
  if (phase === "idle" || phase === "reading-captions") {
    return {
      phase,
      ...(typeof value.videoId === "string" ? { videoId: value.videoId } : {}),
      ...(typeof value.videoTitle === "string" ? { videoTitle: value.videoTitle } : {}),
    };
  }
  if (phase === "ready-for-translation" || phase === "translating") {
    return typeof value.videoId === "string" && typeof value.videoTitle === "string" && typeof value.segmentCount === "number"
      ? {
          phase,
          videoId: value.videoId,
          videoTitle: value.videoTitle,
          segmentCount: value.segmentCount,
          ...(typeof value.translatedCount === "number" ? { translatedCount: value.translatedCount } : {}),
        }
      : null;
  }
  if (phase === "translated") {
    return typeof value.videoId === "string" &&
      typeof value.videoTitle === "string" &&
      typeof value.segmentCount === "number" &&
      typeof value.translatedCount === "number"
      ? { phase, videoId: value.videoId, videoTitle: value.videoTitle, segmentCount: value.segmentCount, translatedCount: value.translatedCount }
      : null;
  }
  if (phase === "error") {
    return typeof value.videoId === "string" && typeof value.videoTitle === "string" && typeof value.errorMessage === "string"
      ? { phase, videoId: value.videoId, videoTitle: value.videoTitle, errorMessage: value.errorMessage }
      : null;
  }
  return null;
}

export function parseExtensionMessage(value: unknown): ExtensionMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case MESSAGE_TYPE.getSettings:
      return { type: MESSAGE_TYPE.getSettings };
    case MESSAGE_TYPE.getVideoTranslationStatus:
      return { type: MESSAGE_TYPE.getVideoTranslationStatus };
    case MESSAGE_TYPE.getCacheStats:
      return { type: MESSAGE_TYPE.getCacheStats };
    case MESSAGE_TYPE.listCache:
      return { type: MESSAGE_TYPE.listCache };
    case MESSAGE_TYPE.clearAllCache:
      return { type: MESSAGE_TYPE.clearAllCache };
    case MESSAGE_TYPE.clearVideoCache:
      return typeof value.videoId === "string" && value.videoId.length > 0
        ? { type: MESSAGE_TYPE.clearVideoCache, videoId: value.videoId }
        : null;
    case MESSAGE_TYPE.updateVideoTranslationStatus: {
      const status = parseVideoTranslationStatus(value.status);
      return status ? { type: MESSAGE_TYPE.updateVideoTranslationStatus, status } : null;
    }
    case MESSAGE_TYPE.translateVideo: {
      if (typeof value.videoId !== "string" || !value.videoId) {
        return null;
      }
      if (typeof value.videoTitle !== "string") {
        return null;
      }
      if (typeof value.videoDescription !== "string") {
        return null;
      }
      if (typeof value.sourceTrackFingerprint !== "string" || !value.sourceTrackFingerprint) {
        return null;
      }
      if (typeof value.sourceLanguage !== "string" || !value.sourceLanguage) {
        return null;
      }
      if (!Array.isArray(value.segments)) {
        return null;
      }
      const segments: TranslationSourceSegment[] = [];
      for (const segment of value.segments) {
        const parsed = parseTranslationSourceSegment(segment);
        if (!parsed) {
          return null;
        }
        segments.push(parsed);
      }
      return {
        type: MESSAGE_TYPE.translateVideo,
        videoId: value.videoId,
        videoTitle: value.videoTitle,
        videoDescription: value.videoDescription,
        sourceTrackFingerprint: value.sourceTrackFingerprint,
        sourceLanguage: value.sourceLanguage,
        segments,
      };
    }
    case MESSAGE_TYPE.translateText: {
      if (value.scope !== "comment" && value.scope !== "selection") {
        return null;
      }
      if (!Array.isArray(value.items) || value.items.length === 0) {
        return null;
      }
      const items: TextTranslationItem[] = [];
      for (const item of value.items) {
        const parsed = parseTextTranslationItem(item);
        if (!parsed) {
          return null;
        }
        items.push(parsed);
      }
      return { type: MESSAGE_TYPE.translateText, scope: value.scope, items };
    }
    default:
      return null;
  }
}

export function isVideoTranslationStatus(value: unknown): value is VideoTranslationStatus {
  return parseVideoTranslationStatus(value) !== null;
}

export function isTranslateTextResponse(value: unknown): value is TranslateTextResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    if (typeof value.targetLanguage !== "string" || !Array.isArray(value.missingIds)) {
      return false;
    }
    if (!value.missingIds.every((id) => typeof id === "string")) {
      return false;
    }
    return (
      isRecord(value.translations) &&
      Object.entries(value.translations).every(([key, text]) => key.length > 0 && typeof text === "string") &&
      (value.errorMessage === undefined || typeof value.errorMessage === "string")
    );
  }
  return value.ok === false && typeof value.errorMessage === "string";
}

export function isSettingsMessageResponse(value: unknown): value is SettingsMessageResponse {
  if (!isRecord(value) || typeof value.resolvedTargetLocale !== "string") {
    return false;
  }

  const settings = value.settings;
  return (
    isRecord(settings) &&
    isRecord(settings.provider) &&
    typeof settings.provider.providerId === "string" &&
    typeof settings.provider.model === "string" &&
    isRecord(settings.apiKeys) &&
    Object.values(settings.apiKeys).every((key) => typeof key === "string") &&
    isRecord(settings.subtitles) &&
    parseCaptionDisplayMode(settings.subtitles.displayMode) !== null &&
    isRecord(settings.selection) &&
    typeof settings.selection.enabled === "boolean" &&
    typeof settings.selection.includeContext === "boolean"
  );
}

export function isTranslateVideoResponse(value: unknown): value is TranslateVideoResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return (
      typeof value.targetLanguage === "string" &&
      parseCaptionDisplayMode(value.displayMode) !== null &&
      typeof value.fromCache === "boolean" &&
      Array.isArray(value.missingIds) &&
      value.missingIds.every((id) => typeof id === "string") &&
      Array.isArray(value.blocks) &&
      value.blocks.every((entry) => parseTranslatedBlock(entry) !== null)
    );
  }
  if (value.ok !== false || typeof value.errorMessage !== "string") {
    return false;
  }
  if (value.partial === undefined) {
    return true;
  }
  if (!isRecord(value.partial)) {
    return false;
  }
  return (
    typeof value.partial.targetLanguage === "string" &&
    parseCaptionDisplayMode(value.partial.displayMode) !== null &&
    Array.isArray(value.partial.missingIds) &&
    value.partial.missingIds.every((id) => typeof id === "string") &&
    Array.isArray(value.partial.blocks) &&
    value.partial.blocks.every((entry) => parseTranslatedBlock(entry, true) !== null)
  );
}

export function isVideoCacheStats(value: unknown): value is VideoCacheStats {
  return (
    isRecord(value) &&
    typeof value.entryCount === "number" &&
    typeof value.totalBytes === "number"
  );
}

export function isListCacheResponse(value: unknown): value is ListCacheResponse {
  if (!isRecord(value) || typeof value.totalBytes !== "number" || !Array.isArray(value.entries)) {
    return false;
  }
  return value.entries.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.title === "string" &&
      typeof entry.videoId === "string" &&
      typeof entry.sourceLanguage === "string" &&
      typeof entry.targetLanguage === "string" &&
      typeof entry.blockCount === "number" &&
      typeof entry.updatedAt === "number",
  );
}
