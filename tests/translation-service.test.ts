import { describe, expect, it } from "vitest";
import { VideoTranslationService } from "../src/background/translation-service";
import { buildTranslationBlocks } from "../src/shared/translation/block-builder";
import { getProviderContextWindow, getProviderPreset } from "../src/shared/providers/provider-registry";
import type { CompletionRequest, CompletionResult, ProviderAdapter, ProviderPreset } from "../src/shared/providers/provider-types";
import type { TranslateVideoMessage } from "../src/shared/contracts/messages";
import type { VideoTranslationCache, VideoCacheStats } from "../src/shared/storage/video-translation-cache";
import { buildVideoCacheKey } from "../src/shared/storage/video-translation-cache";
import type { TranslatedBlock, TranslationBlockInput, TranslationSourceSegment, VideoTranslationCacheEntry } from "../src/shared/translation/translation-types";

function makeRequest(segments: TranslationSourceSegment[], videoId = "v1"): TranslateVideoMessage {
  return {
    type: "translate-video",
    runId: "test-run",
    videoId,
    videoTitle: "Demo video",
    sourceTrackFingerprint: "fp",
    sourceLanguage: "en",
    segments,
  };
}

const adjacentSegments: TranslationSourceSegment[] = [
  { id: "yt-aa", sourceText: "hello", startMs: 0, durationMs: 1000 },
  { id: "yt-bb", sourceText: "world", startMs: 1000, durationMs: 1000 },
];

const gappedSegments: TranslationSourceSegment[] = [
  { id: "yt-aa", sourceText: "hello", startMs: 0, durationMs: 1000 },
  { id: "yt-bb", sourceText: "world", startMs: 2000, durationMs: 1000 },
];

function line(id: string, text: string): string {
  return JSON.stringify({ id, text });
}

class MemoryCache implements VideoTranslationCache {
  public readonly entries = new Map<string, VideoTranslationCacheEntry>();

  public async get(key: string): Promise<VideoTranslationCacheEntry | null> {
    return this.entries.get(key) ?? null;
  }
  public async put(entry: VideoTranslationCacheEntry): Promise<void> {
    this.entries.set(entry.key, entry);
  }
  public async list(): Promise<VideoTranslationCacheEntry[]> {
    return Array.from(this.entries.values());
  }
  public async deleteByVideoId(): Promise<void> {
    throw new Error("deleteByVideoId not used by the service");
  }
  public async clearAll(): Promise<void> {
    this.entries.clear();
  }
  public async getStats(): Promise<VideoCacheStats> {
    return { entryCount: this.entries.size, totalBytes: 0 };
  }
}

const preset = getProviderPreset("deepseek")!;

function makeAdapter(
  complete: (req: CompletionRequest, options?: { maxOutputTokens?: number }) => Promise<CompletionResult>,
  adapterPreset: ProviderPreset = preset,
): ProviderAdapter {
  return {
    preset: adapterPreset,
    complete: (req, options) => complete(req, options),
    listModels: async () => ({ ok: true, models: [] as string[] }),
  };
}

function context(adapter: ProviderAdapter, model = "test-model") {
  return {
    sourceLanguage: "en",
    targetLanguage: "zh-Hans",
    displayMode: "bilingual" as const,
    adapter,
    apiKey: "secret",
    model,
  };
}

function cacheKey(videoId = "v1"): string {
  return buildVideoCacheKey({ videoId });
}

function cachedBlock(block: TranslationBlockInput, translatedText: string): TranslatedBlock {
  return {
    id: block.id,
    segmentIds: [...block.segmentIds],
    startMs: block.startMs,
    endMs: block.endMs,
    sourceText: block.sourceText,
    translatedText,
  };
}

function idsFromPrompt(prompt: string): string[] {
  return Array.from(prompt.matchAll(/\[([^\]]+)\]/g)).map((match) => match[1]!);
}

describe("VideoTranslationService", () => {
  it("serves all blocks from cache without calling the provider", async () => {
    const cache = new MemoryCache();
    const blocks = buildTranslationBlocks(adjacentSegments, getProviderContextWindow(preset, "test-model"));
    const key = cacheKey();
    cache.entries.set(key, {
      key,
      videoId: "v1",
      videoTitle: "Demo video",
      sourceTrackFingerprint: "fp",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      blocks: [cachedBlock(blocks[0]!, "CACHED")],
      createdAt: 1,
      updatedAt: 1,
    });

    let calls = 0;
    const adapter = makeAdapter(async () => {
      calls += 1;
      return { ok: true, text: "" };
    });

    const service = new VideoTranslationService(cache);
    const result = await service.translate(makeRequest(adjacentSegments), context(adapter));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromCache).toBe(true);
      expect(result.blocks).toEqual([
        {
          id: blocks[0]!.id,
          segmentIds: ["yt-aa", "yt-bb"],
          startMs: 0,
          endMs: 2000,
          sourceText: "hello world",
          translatedText: "CACHED",
        },
      ]);
    }
    expect(calls).toBe(0);
  });

  it("does not call a provider when Chinese source and target scripts are equivalent", async () => {
    let calls = 0;
    const adapter = makeAdapter(async () => {
      calls += 1;
      return { ok: true, text: "" };
    });

    const result = await new VideoTranslationService(new MemoryCache()).translate(
      { ...makeRequest(adjacentSegments), sourceLanguage: "zh-Hant" },
      { ...context(adapter), sourceLanguage: "zh-Hant", targetLanguage: "zh-Hans" },
    );

    expect(result).toEqual({
      ok: true,
      blocks: [],
      targetLanguage: "zh-Hans",
      displayMode: "bilingual",
      fromCache: true,
      missingIds: [],
      skipped: true,
    });
    expect(calls).toBe(0);
  });

  it("reads the same video cache regardless of the active provider or model", async () => {
    const cache = new MemoryCache();
    const blocks = buildTranslationBlocks(gappedSegments, getProviderContextWindow(preset, "test-model"));
    const key = cacheKey();
    cache.entries.set(key, {
      key,
      videoId: "v1",
      videoTitle: "Demo video",
      sourceTrackFingerprint: "fp",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      blocks: [cachedBlock(blocks[0]!, "Agnes cached")],
      createdAt: 1,
      updatedAt: 1,
    });

    let calls = 0;
    const agnes = getProviderPreset("agnes")!;
    const adapter = makeAdapter(async (req) => {
      calls += 1;
      return { ok: true, text: idsFromPrompt(req.userPrompt).map((id) => line(id, "DeepSeek result")).join("\n") };
    }, agnes);
    const result = await new VideoTranslationService(cache).translate(
      makeRequest(gappedSegments),
      context(adapter, "agnes-2.5-flash"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromCache).toBe(false);
      expect(result.blocks[0]?.translatedText).toBe("Agnes cached");
      expect(result.blocks[1]?.translatedText).toBe("DeepSeek result");
    }
    expect(calls).toBe(1);
  });

  it("does not reuse a cache entry from another caption track", async () => {
    const cache = new MemoryCache();
    const blocks = buildTranslationBlocks(adjacentSegments, getProviderContextWindow(preset, "test-model"));
    const key = cacheKey();
    cache.entries.set(key, {
      key,
      videoId: "v1",
      videoTitle: "Demo video",
      sourceTrackFingerprint: "old-track",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      blocks: [cachedBlock(blocks[0]!, "WRONG TRACK")],
      createdAt: 1,
      updatedAt: 1,
    });

    let calls = 0;
    const adapter = makeAdapter(async (req) => {
      calls += 1;
      return { ok: true, text: idsFromPrompt(req.userPrompt).map((id) => line(id, "FRESH")).join("\n") };
    });

    const result = await new VideoTranslationService(cache).translate(makeRequest(adjacentSegments), context(adapter));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks[0]?.translatedText).toBe("FRESH");
      expect(result.fromCache).toBe(false);
    }
    expect(calls).toBe(1);
    expect(cache.entries.get(key)?.sourceTrackFingerprint).toBe("fp");
  });

  it("translates uncached blocks and writes progress to the cache", async () => {
    const cache = new MemoryCache();
    let receivedPrompt = "";
    const adapter = makeAdapter(async (req) => {
      receivedPrompt = req.userPrompt;
      const ids = idsFromPrompt(req.userPrompt);
      return { ok: true, text: ids.map((id) => line(id, "译文：" + id)).join("\n") };
    });

    const service = new VideoTranslationService(cache);
    const result = await service.translate(makeRequest(adjacentSegments), context(adapter));

    expect(result.ok).toBe(true);
    expect(receivedPrompt).toContain('title "Demo video"');
    expect(receivedPrompt).not.toContain("description");
    if (result.ok) {
      expect(result.fromCache).toBe(false);
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0]!.translatedText).toContain("译文");
      expect(result.missingIds).toEqual([]);
    }
    const entry = cache.entries.get(cacheKey());
    expect(entry?.videoTitle).toBe("Demo video");
    expect(entry?.blocks).toHaveLength(1);
  });

  it("preserves natural punctuation in Chinese subtitle output before caching and display", async () => {
    const cache = new MemoryCache();
    const adapter = makeAdapter(async (req) => {
      const ids = idsFromPrompt(req.userPrompt);
      return { ok: true, text: ids.map((id) => line(id, "你好，世界！")).join("\n") };
    });

    const service = new VideoTranslationService(cache);
    const result = await service.translate(makeRequest(adjacentSegments), context(adapter));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks[0]?.translatedText).toBe("你好，世界！");
    }
  });

  it("retries blocks the provider failed to return", async () => {
    const cache = new MemoryCache();
    let call = 0;
    const adapter = makeAdapter(async (req) => {
      call += 1;
      const ids = idsFromPrompt(req.userPrompt);
      if (call === 1) {
        return { ok: true, text: ids.length > 1 ? line(ids[0]!, "译文A") : "" };
      }
      return { ok: true, text: ids.map((id) => line(id, "译文" + id)).join("\n") };
    });

    const service = new VideoTranslationService(cache);
    const result = await service.translate(makeRequest(gappedSegments), context(adapter));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks).toHaveLength(2);
      expect(result.missingIds).toEqual([]);
    }
    expect(call).toBe(2);
  });

  it("emits validated blocks while a streaming provider response is arriving", async () => {
    const cache = new MemoryCache();
    const adapter: ProviderAdapter = {
      preset,
      complete: async () => ({ ok: false, error: { reason: "bad-response", message: "not used" } }),
      completeStream: async (request, _options, onTextDelta) => {
        const text = idsFromPrompt(request.userPrompt).map((id) => line(id, "流式译文"));
        for (const item of text) {
          onTextDelta(item + "\n");
        }
        return { ok: true, text: text.join("\n") };
      },
      listModels: async () => ({ ok: true, models: [] }),
    };
    const progress: TranslatedBlock[] = [];

    const result = await new VideoTranslationService(cache).translate(
      makeRequest(gappedSegments),
      context(adapter),
      (block) => progress.push(block),
    );

    expect(result.ok).toBe(true);
    expect(progress.map((block) => block.translatedText)).toEqual(["流式译文", "流式译文"]);
  });

  it("retries an empty spoken translation separately instead of displaying source only", async () => {
    const cache = new MemoryCache();
    let call = 0;
    const adapter = makeAdapter(async (req) => {
      call += 1;
      const ids = idsFromPrompt(req.userPrompt);
      if (ids.length > 1) {
        return { ok: true, text: line(ids[0]!, "译文A") + "\n" + line(ids[1]!, "") };
      }
      if (call === 2) {
        return { ok: true, text: line(ids[0]!, "") };
      }
      return { ok: true, text: line(ids[0]!, "译文B") };
    });

    const result = await new VideoTranslationService(cache).translate(makeRequest(gappedSegments), context(adapter));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks.map((block) => block.translatedText)).toEqual(["译文A", "译文B"]);
      expect(result.missingIds).toEqual([]);
    }
    expect(call).toBe(3);
  });

  it("does not report success when a spoken translation remains empty", async () => {
    const cache = new MemoryCache();
    const adapter = makeAdapter(async (req) => {
      return { ok: true, text: idsFromPrompt(req.userPrompt).map((id) => line(id, "")).join("\n") };
    });

    const result = await new VideoTranslationService(cache).translate(makeRequest(adjacentSegments), context(adapter));

    expect(result).toEqual({ ok: false, errorMessage: "1 段字幕没有获得有效译文，已保存已完成部分，请重试。" });
  });

  it("retranslates an empty spoken translation from an older cache entry", async () => {
    const cache = new MemoryCache();
    const blocks = buildTranslationBlocks(gappedSegments, getProviderContextWindow(preset, "test-model"));
    const key = cacheKey();
    cache.entries.set(key, {
      key,
      videoId: "v1",
      videoTitle: "Demo video",
      sourceTrackFingerprint: "fp",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
      blocks: [cachedBlock(blocks[0]!, ""), cachedBlock(blocks[1]!, "CACHED")],
      createdAt: 1,
      updatedAt: 1,
    });

    let calls = 0;
    const adapter = makeAdapter(async (req) => {
      calls += 1;
      return { ok: true, text: idsFromPrompt(req.userPrompt).map((id) => line(id, "重新翻译")).join("\n") };
    });

    const result = await new VideoTranslationService(cache).translate(makeRequest(gappedSegments), context(adapter));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks.map((block) => block.translatedText)).toEqual(["重新翻译", "CACHED"]);
    }
    expect(calls).toBe(1);
  });

  it("maps an out-of-order provider reply back to the original block timeline", async () => {
    const cache = new MemoryCache();
    const adapter = makeAdapter(async (req) => {
      const ids = idsFromPrompt(req.userPrompt).reverse();
      return { ok: true, text: ids.map((id) => line(id, "译文：" + id)).join("\n") };
    });

    const result = await new VideoTranslationService(cache).translate(makeRequest(gappedSegments), context(adapter));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks.map((block) => block.id)).toEqual(
        buildTranslationBlocks(gappedSegments, getProviderContextWindow(preset, "test-model")).map((block) => block.id),
      );
      expect(result.blocks.map((block) => block.segmentIds)).toEqual([["yt-aa"], ["yt-bb"]]);
      expect(result.blocks.map((block) => [block.startMs, block.endMs])).toEqual([[0, 1000], [2000, 3000]]);
      expect(result.blocks.every((block) => block.translatedText.startsWith("译文"))).toBe(true);
    }
  });

  it("surfaces a provider failure as an error response", async () => {
    const cache = new MemoryCache();
    const adapter = makeAdapter(async () => ({
      ok: false,
      error: { reason: "auth", message: "Provider rejected the API key." },
    }));

    const service = new VideoTranslationService(cache);
    const result = await service.translate(makeRequest(adjacentSegments), context(adapter));

    expect(result).toEqual({ ok: false, errorMessage: "服务密钥无效或权限不足，请到偏好设置检查。" });
  });

  it("persists completed batches and returns them for a resumable partial failure", async () => {
    const cache = new MemoryCache();
    const smallBatchPreset: ProviderPreset = {
      ...preset,
      modelLimits: { "test-model": { contextWindowTokens: 620, maxOutputTokens: 384_000 } },
    };
    let calls = 0;
    const adapter = makeAdapter(async (req) => {
      calls += 1;
      if (calls > 1) {
        return { ok: false, error: { reason: "timeout", message: "Provider request timed out." } };
      }
      return { ok: true, text: idsFromPrompt(req.userPrompt).map((id) => line(id, "已完成")).join("\n") };
    }, smallBatchPreset);

    const blocks = buildTranslationBlocks(gappedSegments, getProviderContextWindow(smallBatchPreset, "test-model"));
    expect(blocks).toHaveLength(2);

    const result = await new VideoTranslationService(cache).translate(makeRequest(gappedSegments), context(adapter));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.partial?.missingIds).toEqual([blocks[1]!.id]);
      expect(result.partial?.blocks.map((block) => block.translatedText)).toEqual(["已完成", ""]);
    }
    expect(cache.entries.get(cacheKey())?.blocks).toEqual([
      expect.objectContaining({ id: blocks[0]!.id, translatedText: "已完成" }),
    ]);
  });

  it("caps subtitle output at a provider's documented output limit", async () => {
    const cache = new MemoryCache();
    const agnes = getProviderPreset("agnes")!;
    let requestedOutputTokens = 0;
    const adapter = makeAdapter(async (req, options) => {
      requestedOutputTokens = options?.maxOutputTokens ?? 0;
      const ids = idsFromPrompt(req.userPrompt);
      return { ok: true, text: ids.map((id) => line(id, "译文" + id)).join("\n") };
    }, agnes);

    const result = await new VideoTranslationService(cache).translate(makeRequest(adjacentSegments), {
      ...context(adapter),
      model: "agnes-2.5-flash",
    });

    expect(result.ok).toBe(true);
    expect(requestedOutputTokens).toBe(512);
  });
});
