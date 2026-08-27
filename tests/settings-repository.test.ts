import { describe, expect, it } from "vitest";
import { SettingsRepository, type LocalStorageArea } from "../src/shared/storage/settings-repository";

class MemoryStorageArea implements LocalStorageArea {
  private readonly values: Record<string, unknown> = {};

  public async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: this.values[key] };
  }

  public async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }
}

describe("SettingsRepository", () => {
  it("uses the default provider and subtitle settings when local storage has no valid settings", async () => {
    const repository = new SettingsRepository(new MemoryStorageArea());
    await expect(repository.loadSettings()).resolves.toEqual({
      provider: { providerId: "deepseek", model: "" },
      apiKeys: {},
      providerModels: {},
      subtitles: {
        displayMode: "bilingual",
        shortsTranslationEnabled: false,
        translationColor: "#ffd438",
        originalColor: "#ececf0",
        translationFontScale: 100,
        originalFontScale: 100,
        verticalPosition: null,
      },
      page: { autoTranslateTitle: true },
      selection: { enabled: true, includeContext: false },
    });
  });

  it("stores provider, per-provider api key, subtitle and selection configuration", async () => {
    const repository = new SettingsRepository(new MemoryStorageArea());
    await repository.saveSettings({
      provider: { providerId: "openai", model: "gpt-4o-mini" },
      apiKeys: { openai: "secret" },
      providerModels: { openai: "gpt-4o-mini" },
      subtitles: {
        displayMode: "translation",
        shortsTranslationEnabled: false,
        translationColor: "#1a2b3c",
        originalColor: "#d4e5f6",
        translationFontScale: 120,
        originalFontScale: 90,
        verticalPosition: 0.25,
      },
      page: { autoTranslateTitle: false },
      selection: { enabled: false, includeContext: true },
    });
    await expect(repository.loadSettings()).resolves.toEqual({
      provider: { providerId: "openai", model: "gpt-4o-mini" },
      apiKeys: { openai: "secret" },
      providerModels: { openai: "gpt-4o-mini" },
      subtitles: {
        displayMode: "translation",
        shortsTranslationEnabled: false,
        translationColor: "#1a2b3c",
        originalColor: "#d4e5f6",
        translationFontScale: 120,
        originalFontScale: 90,
        verticalPosition: 0.25,
      },
      page: { autoTranslateTitle: false },
      selection: { enabled: false, includeContext: true },
    });
  });
});
