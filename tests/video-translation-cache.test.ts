import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { PROMPT_VERSION } from "../src/shared/translation/prompt";
import {
  buildVideoCacheKey,
  VideoTranslationRepository,
} from "../src/shared/storage/video-translation-cache";
import { openExtensionDatabase } from "../src/shared/storage/extension-database";
import type { VideoTranslationCacheEntry } from "../src/shared/translation/translation-types";

function createEntry(key: string, videoId: string, blocks: Record<string, string> = {}): VideoTranslationCacheEntry {
  return {
    key,
    videoId,
    videoTitle: `Title ${videoId}`,
    sourceTrackFingerprint: "fp",
    sourceLanguage: "en",
    targetLanguage: "zh-Hans",
    promptVersion: PROMPT_VERSION,
    blocks,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("VideoTranslationRepository", () => {
  beforeEach(async () => {
    const repo = new VideoTranslationRepository(openExtensionDatabase);
    await repo.clearAll();
  });

  it("round-trips a cache entry", async () => {
    const repo = new VideoTranslationRepository(openExtensionDatabase);
    const entry = createEntry("k1", "video-1", { "blk-aa": "你好" });
    await repo.put(entry);
    expect(await repo.get("k1")).toEqual(entry);
  });

  it("deletes entries by video id", async () => {
    const repo = new VideoTranslationRepository(openExtensionDatabase);
    await repo.put(createEntry("a", "video-1"));
    await repo.put(createEntry("b", "video-2"));
    await repo.deleteByVideoId("video-1");
    expect(await repo.get("a")).toBeNull();
    expect(await repo.get("b")).not.toBeNull();
  });

  it("clears all entries and reports stats", async () => {
    const repo = new VideoTranslationRepository(openExtensionDatabase);
    await repo.put(createEntry("a", "video-1", { "blk-aa": "你好" }));
    await repo.put(createEntry("b", "video-2", { "blk-bb": "世界" }));
    const stats = await repo.getStats();
    expect(stats.entryCount).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
    await repo.clearAll();
    expect((await repo.getStats()).entryCount).toBe(0);
  });

  it("lists all entries", async () => {
    const repo = new VideoTranslationRepository(openExtensionDatabase);
    await repo.put(createEntry("a", "video-1", { "blk-aa": "你好" }));
    await repo.put(createEntry("b", "video-2", { "blk-bb": "世界" }));
    const entries = await repo.list();
    expect(entries.map((entry) => entry.videoId).sort()).toEqual(["video-1", "video-2"]);
    expect(entries[0]?.videoTitle).toBe("Title video-1");
  });

  it("builds a versioned cache key that includes the prompt and language dimensions", () => {
    const key = buildVideoCacheKey({
      videoId: "v1",
      sourceTrackFingerprint: "fp",
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
    expect(key).toContain("v1");
    expect(key).toContain("fp");
    expect(key).toContain("en");
    expect(key).toContain("zh-Hans");
    expect(key).toContain(PROMPT_VERSION);
  });
});
