import { describe, expect, it } from "vitest";
import {
  isListCacheResponse,
  isSettingsMessageResponse,
  isTranslateTextResponse,
  isTranslateVideoResponse,
  isVideoCacheStats,
  isVideoTranslationCacheResponse,
  isVideoTranslationStatus,
  MESSAGE_TYPE,
  parseExtensionMessage,
} from "../src/shared/contracts/messages";

describe("extension messages", () => {
  it("accepts only known messages", () => {
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.getSettings })).toEqual({
      type: MESSAGE_TYPE.getSettings,
    });
    expect(parseExtensionMessage({ type: "translate" })).toBeNull();
    expect(parseExtensionMessage(null)).toBeNull();
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.getVideoTranslationStatus, tabId: 12 })).toEqual({
      type: MESSAGE_TYPE.getVideoTranslationStatus,
      tabId: 12,
    });
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.getVideoTranslationStatus, tabId: -1 })).toBeNull();
  });

  it("accepts only complete video translation status updates", () => {
    expect(
      parseExtensionMessage({
        type: MESSAGE_TYPE.updateVideoTranslationStatus,
        status: { phase: "ready-for-translation", videoId: "video-id", videoTitle: "Video", segmentCount: 12 },
      }),
    ).not.toBeNull();
    expect(
      parseExtensionMessage({ type: MESSAGE_TYPE.updateVideoTranslationStatus, status: { phase: "error" } }),
    ).toBeNull();
    expect(isVideoTranslationStatus({ phase: "reading-captions", videoId: "video-id" })).toBe(true);
    expect(isVideoTranslationStatus({ phase: "ready-for-translation", segmentCount: -1 })).toBe(false);
  });

  it("rejects malformed settings responses", () => {
    expect(
      isSettingsMessageResponse({
        settings: {
          provider: { providerId: "deepseek", model: "" },
          apiKeys: {},
          providerModels: {},
          subtitles: { displayMode: "bilingual" },
          selection: { enabled: true, includeContext: false },
        },
        resolvedTargetLocale: "zh-Hans",
      }),
    ).toBe(true);
    expect(
      isSettingsMessageResponse({
        settings: {
          provider: { providerId: "deepseek", model: "" },
          apiKeys: {},
          subtitles: { displayMode: "bilingual" },
          selection: { enabled: true, includeContext: false },
        },
        resolvedTargetLocale: "zh-Hans",
      }),
    ).toBe(false);
    expect(isSettingsMessageResponse({ settings: { targetLanguage: 1 }, resolvedTargetLocale: "en" })).toBe(
      false,
    );
    expect(
      isSettingsMessageResponse({
        settings: {
          provider: { providerId: "deepseek", model: "" },
          apiKeys: {},
          subtitles: { displayMode: "bilingual" },
        },
        resolvedTargetLocale: "zh-Hans",
      }),
    ).toBe(false);
  });

  it("accepts a valid translate-video message and rejects malformed ones", () => {
    const valid = {
      type: MESSAGE_TYPE.translateVideo,
      runId: "test-run",
      videoId: "a-b-c",
      videoTitle: "Demo",
      sourceTrackFingerprint: "fp",
      sourceLanguage: "en",
      segments: [{ id: "yt-abc", sourceText: "hello", startMs: 0, durationMs: 1000 }],
    };
    expect(parseExtensionMessage(valid)).toEqual(valid);
    expect(parseExtensionMessage({ ...valid, videoTitle: 1 })).toBeNull();
    expect(parseExtensionMessage({ ...valid, segments: [{ id: "yt-abc", sourceText: "x" }] })).toBeNull();
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.translateVideo })).toBeNull();
  });

  it("accepts a valid translate response and rejects incomplete ones", () => {
    expect(
      isTranslateVideoResponse({
        ok: true,
        blocks: [{ id: "blk-aa", segmentIds: ["yt-abc"], translatedText: "你好", sourceText: "hello", startMs: 0, endMs: 1000 }],
        targetLanguage: "zh-Hans",
        displayMode: "bilingual",
        fromCache: false,
        missingIds: [],
      }),
    ).toBe(true);
    expect(isTranslateVideoResponse({ ok: false, errorMessage: "no key" })).toBe(true);
    expect(
      isTranslateVideoResponse({
        ok: false,
        errorMessage: "timeout",
        partial: {
          blocks: [{ id: "blk-aa", segmentIds: ["yt-abc"], translatedText: "", sourceText: "hello", startMs: 0, endMs: 1000 }],
          targetLanguage: "zh-Hans",
          displayMode: "bilingual",
          missingIds: ["blk-aa"],
        },
      }),
    ).toBe(true);
    expect(isTranslateVideoResponse({ ok: true, blocks: [] })).toBe(false);
    expect(
      isTranslateVideoResponse({
        ok: true,
        blocks: [],
        targetLanguage: "zh-Hans",
        displayMode: "bilingual",
        fromCache: true,
        missingIds: [],
        skipped: true,
      }),
    ).toBe(true);
  });

  it("accepts cache stats, list and clear messages", () => {
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.getVideoTranslationCache, videoId: "a-b" })).toEqual({
      type: MESSAGE_TYPE.getVideoTranslationCache,
      videoId: "a-b",
    });
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.getVideoTranslationCache })).toBeNull();
    expect(isVideoTranslationCacheResponse({ found: false })).toBe(true);
    expect(
      isVideoTranslationCacheResponse({
        found: true,
        videoId: "v",
        videoTitle: "Demo",
        sourceTrackFingerprint: "fp",
        sourceLanguage: "en",
        targetLanguage: "zh-Hans",
        displayMode: "bilingual",
        blocks: [{ id: "blk-aa", segmentIds: ["yt-abc"], translatedText: "你好", sourceText: "hello", startMs: 0, endMs: 1000 }],
      }),
    ).toBe(true);
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.getCacheStats })).toEqual({ type: MESSAGE_TYPE.getCacheStats });
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.listCache })).toEqual({ type: MESSAGE_TYPE.listCache });
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.clearVideoCache, videoId: "a-b" })).toEqual({
      type: MESSAGE_TYPE.clearVideoCache,
      videoId: "a-b",
    });
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.clearVideoCache })).toBeNull();
    expect(isVideoCacheStats({ entryCount: 1, totalBytes: 10 })).toBe(true);
  });

  it("accepts a list-cache response", () => {
    expect(
      isListCacheResponse({
        entries: [{ title: "Demo", videoId: "v", sourceLanguage: "en", targetLanguage: "zh-Hans", blockCount: 3, updatedAt: 1 }],
        totalBytes: 2,
      }),
    ).toBe(true);
    expect(isListCacheResponse({ entries: [{ videoId: 1 }], totalBytes: 2 })).toBe(false);
  });

  it("accepts a valid translate-text message and rejects malformed ones", () => {
    const valid = {
      type: MESSAGE_TYPE.translateText,
      scope: "comment",
      videoTitle: "Demo video",
      items: [
        { id: "c1", sourceText: "hello" },
        { id: "c2", sourceText: "world", contextBefore: "x", contextAfter: "y" },
      ],
    };
    expect(parseExtensionMessage(valid)).toEqual(valid);
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.translateText, scope: "bad", items: [{ id: "c1", sourceText: "x" }] })).toBeNull();
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.translateText, scope: "selection", items: [] })).toBeNull();
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.translateText, scope: "selection", items: [{ id: "c1" }] })).toBeNull();
    expect(parseExtensionMessage({ type: MESSAGE_TYPE.translateText, scope: "selection", items: [{ id: "c1", sourceText: 1 }] })).toBeNull();
  });

  it("accepts a valid translate-text response and rejects incomplete ones", () => {
    expect(
      isTranslateTextResponse({ ok: true, translations: { c1: "你好" }, missingIds: [], targetLanguage: "zh-Hans" }),
    ).toBe(true);
    expect(isTranslateTextResponse({ ok: false, errorMessage: "no key" })).toBe(true);
    expect(
      isTranslateTextResponse({
        ok: true,
        translations: {},
        missingIds: [],
        skippedIds: ["c1"],
        targetLanguage: "zh-Hans",
      }),
    ).toBe(true);
    expect(isTranslateTextResponse({ ok: true, translations: { c1: 1 }, missingIds: [], targetLanguage: "zh-Hans" })).toBe(false);
    expect(isTranslateTextResponse({ ok: true, translations: { c1: "你好" }, targetLanguage: "zh-Hans" })).toBe(false);
  });
});
