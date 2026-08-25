import { EXTENSION_DATABASE } from "./storage-registry";

export function openExtensionDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(EXTENSION_DATABASE.name, EXTENSION_DATABASE.version);

    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(EXTENSION_DATABASE.metadataStore)) {
        database.createObjectStore(EXTENSION_DATABASE.metadataStore, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(EXTENSION_DATABASE.translationStore)) {
        const store = database.createObjectStore(EXTENSION_DATABASE.translationStore, { keyPath: "key" });
        store.createIndex("videoId", "videoId", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      } else if (event.oldVersion < EXTENSION_DATABASE.version) {
        // Development-only schema reset: old records contain a different cache
        // shape and are intentionally not migrated.
        request.transaction?.objectStore(EXTENSION_DATABASE.translationStore).clear();
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open extension database."));
  });
}
