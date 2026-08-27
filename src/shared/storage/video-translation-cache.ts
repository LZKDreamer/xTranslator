// IndexedDB cache for per-video caption translations.
//
// The cache stores complete timed subtitle blocks in one record per video. The
// key is intentionally only the video ID so reopening a video can render the
// saved timeline without contacting the caption endpoint or an LLM.
// It persists parsed text and translations only — never temporary caption URLs,
// API keys, or request bodies.

import type { VideoTranslationCacheEntry } from "../translation/translation-types";
import { openExtensionDatabase } from "./extension-database";
import { EXTENSION_DATABASE } from "./storage-registry";

export type DatabaseOpenFn = () => Promise<IDBDatabase>;

export interface VideoCacheStats {
  entryCount: number;
  totalBytes: number;
}

export interface VideoTranslationCache {
  get(key: string): Promise<VideoTranslationCacheEntry | null>;
  put(entry: VideoTranslationCacheEntry): Promise<void>;
  list(): Promise<VideoTranslationCacheEntry[]>;
  deleteByVideoId(videoId: string): Promise<void>;
  clearAll(): Promise<void>;
  getStats(): Promise<VideoCacheStats>;
}

const utf8Encoder = new TextEncoder();
const VIDEO_TRANSLATION_CACHE_VERSION = "caption-v2";

export function buildVideoCacheKey(params: {
  videoId: string;
}): string {
  return `${VIDEO_TRANSLATION_CACHE_VERSION}::${params.videoId}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function byteLength(value: unknown): number {
  try {
    return utf8Encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

export class VideoTranslationRepository implements VideoTranslationCache {
  private database: Promise<IDBDatabase> | null = null;

  public constructor(private readonly openDatabase: DatabaseOpenFn) {}

  private db(): Promise<IDBDatabase> {
    this.database ??= this.openDatabase();
    return this.database;
  }

  public async get(key: string): Promise<VideoTranslationCacheEntry | null> {
    const database = await this.db();
    const transaction = database.transaction(EXTENSION_DATABASE.translationStore, "readonly");
    const result = await requestToPromise(
      transaction.objectStore(EXTENSION_DATABASE.translationStore).get(key),
    );
    return isRecord(result) && typeof result.videoId === "string"
      ? (result as unknown as VideoTranslationCacheEntry)
      : null;
  }

  public async put(entry: VideoTranslationCacheEntry): Promise<void> {
    const database = await this.db();
    const transaction = database.transaction(EXTENSION_DATABASE.translationStore, "readwrite");
    await requestToPromise(transaction.objectStore(EXTENSION_DATABASE.translationStore).put(entry));
    await transactionDone(transaction);
  }

  public async deleteByVideoId(videoId: string): Promise<void> {
    const database = await this.db();
    const transaction = database.transaction(EXTENSION_DATABASE.translationStore, "readwrite");
    const store = transaction.objectStore(EXTENSION_DATABASE.translationStore);
    const index = store.index("videoId");

    await new Promise<void>((resolve, reject) => {
      const cursorRequest = index.openKeyCursor(IDBKeyRange.only(videoId));
      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursor | null>).result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
          return;
        }
        resolve();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("IndexedDB delete failed."));
    });
    await transactionDone(transaction);
  }

  public async clearAll(): Promise<void> {
    const database = await this.db();
    // Clear every object store so records from an earlier cache shape or a
    // future auxiliary cache cannot survive the settings-page reset.
    const storeNames = Array.from(database.objectStoreNames);
    if (storeNames.length === 0) {
      return;
    }
    const transaction = database.transaction(storeNames, "readwrite");
    for (const storeName of storeNames) {
      transaction.objectStore(storeName).clear();
    }
    await transactionDone(transaction);
  }

  public async getStats(): Promise<VideoCacheStats> {
    const database = await this.db();
    const transaction = database.transaction(EXTENSION_DATABASE.translationStore, "readonly");
    const entries = (await requestToPromise(
      transaction.objectStore(EXTENSION_DATABASE.translationStore).getAll(),
    )) as unknown[];

    let totalBytes = 0;
    for (const entry of entries) {
      totalBytes += byteLength(entry);
    }
    return { entryCount: entries.length, totalBytes };
  }

  public async list(): Promise<VideoTranslationCacheEntry[]> {
    const database = await this.db();
    const transaction = database.transaction(EXTENSION_DATABASE.translationStore, "readonly");
    return (await requestToPromise(
      transaction.objectStore(EXTENSION_DATABASE.translationStore).getAll(),
    )) as VideoTranslationCacheEntry[];
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

export function createChromeVideoTranslationRepository(): VideoTranslationRepository {
  return new VideoTranslationRepository(openExtensionDatabase);
}
