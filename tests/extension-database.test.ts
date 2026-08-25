import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { openExtensionDatabase } from "../src/shared/storage/extension-database";
import { EXTENSION_DATABASE } from "../src/shared/storage/storage-registry";

describe("openExtensionDatabase", () => {
  it("creates the extension metadata and translation stores", async () => {
    const database = await openExtensionDatabase();
    expect(database.objectStoreNames.contains(EXTENSION_DATABASE.metadataStore)).toBe(true);
    expect(database.objectStoreNames.contains(EXTENSION_DATABASE.translationStore)).toBe(true);
    database.close();
  });
});
