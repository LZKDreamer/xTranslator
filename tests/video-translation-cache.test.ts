import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildVideoCacheKey,
  VideoTranslationRepository,
} from "../src/shared/storage/video-translation-cache";
import { openExtensionDatabase } from "../src/shared/storage/extension-database";
import { EXTENSION_DATABASE } from "../src/shared/storage/storage-registry";
import type { TranslatedBlock, VideoTranslationCacheEntry } from "../src/shared/translation/translation-types";

function createBlock(id: string, translatedText: string): TranslatedBlock {
  return {
    id,
    segmentIds: [`segment-${id}`],
    startMs: 0,
    endMs: 1000,
    sourceText: `Source ${id}`,
    translatedText,
  };
}

function createEntry(key: string, videoId: string, blocks: TranslatedBlock[] = []): VideoTranslationCacheEntry {
  return {
    key,
    videoId,
    videoTitle: `Title ${videoId}`,
    sourceTrackFingerprint: "fp",
    sourceLanguage: "en",
    targetLanguage: "zh-Hans",
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
    const entry = createEntry("k1", "video-1", [createBlock("blk-aa", "你好")]);
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
    await repo.put(createEntry("a", "video-1", [createBlock("blk-aa", "你好")]));
    await repo.put(createEntry("b", "video-2", [createBlock("blk-bb", "世界")]));
    const stats = await repo.getStats();
    expect(stats.entryCount).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
    await repo.clearAll();
    expect((await repo.getStats()).entryCount).toBe(0);
  });

  it("clears old cache keys and records in every object store", async () => {
    const database = await openExtensionDatabase();
    const seedTransaction = database.transaction(
      [EXTENSION_DATABASE.metadataStore, EXTENSION_DATABASE.translationStore],
      "readwrite",
    );
    seedTransaction.objectStore(EXTENSION_DATABASE.metadataStore).put({ key: "old-metadata", value: true });
    seedTransaction.objectStore(EXTENSION_DATABASE.translationStore).put({
      key: "old-video::old-provider::old-model",
      videoId: "old-video",
      blocks: { oldBlock: "旧译文" },
    });
    await new Promise<void>((resolve, reject) => {
      seedTransaction.oncomplete = () => resolve();
      seedTransaction.onerror = () => reject(seedTransaction.error);
      seedTransaction.onabort = () => reject(seedTransaction.error);
    });

    const repo = new VideoTranslationRepository(openExtensionDatabase);
    await repo.clearAll();

    expect(await repo.get("old-video::old-provider::old-model")).toBeNull();
    expect(await repo.list()).toEqual([]);
    const metadataCheck = database.transaction(EXTENSION_DATABASE.metadataStore, "readonly");
    const metadataCount = await new Promise<number>((resolve, reject) => {
      const request = metadataCheck.objectStore(EXTENSION_DATABASE.metadataStore).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(metadataCount).toBe(0);
    database.close();
  });

  it("lists all entries", async () => {
    const repo = new VideoTranslationRepository(openExtensionDatabase);
    await repo.put(createEntry("a", "video-1", [createBlock("blk-aa", "你好")]));
    await repo.put(createEntry("b", "video-2", [createBlock("blk-bb", "世界")]));
    const entries = await repo.list();
    expect(entries.map((entry) => entry.videoId).sort()).toEqual(["video-1", "video-2"]);
    expect(entries[0]?.videoTitle).toBe("Title video-1");
  });

  it("versions the cache key so older subtitle processing results are not reused", () => {
    expect(buildVideoCacheKey({ videoId: "v1" })).toBe("caption-v2::v1");
  });

  it("does not read a legacy unversioned subtitle cache entry", async () => {
    const repo = new VideoTranslationRepository(openExtensionDatabase);
    await repo.put(createEntry("video-1", "video-1", [createBlock("blk-aa", "旧译文")]));

    expect(await repo.get(buildVideoCacheKey({ videoId: "video-1" }))).toBeNull();
  });
});
