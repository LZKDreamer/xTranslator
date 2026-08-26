import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBTITLE_SETTINGS,
  DEFAULT_SETTINGS,
  normalizeLanguageTag,
  parseApiKeys,
  parseCaptionDisplayMode,
  parseExtensionSettings,
  parseProviderSettings,
  parseSubtitleSettings,
  resolveProviderApiKey,
  resolveProviderModel,
} from "../src/shared/contracts/settings";

describe("provider settings", () => {
  it("parses a complete extension settings object with per-provider api keys", () => {
    expect(
      parseExtensionSettings({
        provider: { providerId: "deepseek", model: "deepseek-chat" },
        apiKeys: { deepseek: "secret" },
        subtitles: { displayMode: "bilingual" },
        selection: { enabled: true, includeContext: false },
      }),
    ).toEqual({
      provider: { providerId: "deepseek", model: "deepseek-chat" },
      apiKeys: { deepseek: "secret" },
      providerModels: { deepseek: "deepseek-chat" },
      subtitles: { ...DEFAULT_SUBTITLE_SETTINGS },
      selection: { enabled: true, includeContext: false },
    });
  });

  it("migrates the legacy single-key settings shape into the per-provider map", () => {
    expect(
      parseExtensionSettings({
        provider: { providerId: "deepseek", apiKey: "  secret  ", model: "deepseek-chat" },
        subtitles: { displayMode: "bilingual" },
        selection: { enabled: true, includeContext: false },
      }),
    ).toEqual({
      provider: { providerId: "deepseek", model: "deepseek-chat" },
      apiKeys: { deepseek: "  secret  " },
      providerModels: { deepseek: "deepseek-chat" },
      subtitles: { ...DEFAULT_SUBTITLE_SETTINGS },
      selection: { enabled: true, includeContext: false },
    });
  });

  it("rejects settings without a complete provider, subtitles or selection block", () => {
    expect(parseExtensionSettings({ provider: { providerId: "deepseek", model: "" } })).toBeNull();
    expect(parseExtensionSettings({ subtitles: { displayMode: "bilingual" } })).toBeNull();
    expect(parseExtensionSettings({ provider: { providerId: "deepseek" }, subtitles: {} })).toBeNull();
    expect(
      parseExtensionSettings({
        provider: { providerId: "deepseek", model: "" },
        apiKeys: {},
        subtitles: { displayMode: "bilingual" },
        selection: { enabled: true, includeContext: "yes" },
      }),
    ).toBeNull();
  });

  it("rejects malformed provider settings", () => {
    expect(parseProviderSettings({ providerId: "", model: "" })).toBeNull();
    expect(parseProviderSettings({ providerId: "deepseek", model: 12 })).toBeNull();
    expect(parseProviderSettings(null)).toBeNull();
  });

  it("normalizes provider id and model", () => {
    expect(parseProviderSettings({ providerId: "  deepseek  ", model: " chat " })).toEqual({
      providerId: "deepseek",
      model: "chat",
    });
  });

  it("parses a per-provider api key map and rejects non-string values", () => {
    expect(parseApiKeys({ deepseek: "secret", openai: "" })).toEqual({ deepseek: "secret", openai: "" });
    expect(parseApiKeys(null)).toBeNull();
    expect(parseApiKeys({ deepseek: 12 })).toBeNull();
  });

  it("resolves the api key for the active provider and falls back to empty", () => {
    const settings = parseExtensionSettings({
      provider: { providerId: "openai", model: "gpt-4o-mini" },
      apiKeys: { deepseek: "deepseek-secret", openai: "openai-secret" },
      providerModels: { deepseek: "deepseek-chat", openai: "gpt-4o-mini" },
      subtitles: { ...DEFAULT_SUBTITLE_SETTINGS },
      selection: { enabled: true, includeContext: false },
    })!;
    expect(resolveProviderApiKey(settings)).toBe("openai-secret");
    expect(resolveProviderApiKey(settings, "deepseek")).toBe("deepseek-secret");
    expect(resolveProviderApiKey(settings, "anthropic")).toBe("");
    expect(resolveProviderModel(settings)).toBe("gpt-4o-mini");
    expect(resolveProviderModel(settings, "deepseek")).toBe("deepseek-chat");
    expect(resolveProviderModel(settings, "anthropic")).toBe("");
  });

  it("exposes a default provider preset without an api key", () => {
    expect(DEFAULT_SETTINGS.provider.providerId).toBe("deepseek");
    expect(DEFAULT_SETTINGS.apiKeys).toEqual({});
    expect(DEFAULT_SETTINGS.providerModels).toEqual({});
    expect(resolveProviderApiKey(DEFAULT_SETTINGS)).toBe("");
  });

  it("defaults selection translation to enabled for legacy settings", () => {
    expect(parseExtensionSettings({
      provider: { providerId: "deepseek", model: "deepseek-chat" },
      apiKeys: {},
      providerModels: {},
      subtitles: { displayMode: "bilingual" },
      selection: { includeContext: false },
    })?.selection.enabled).toBe(true);
  });
});

describe("subtitle settings", () => {
  it("defaults to bilingual display", () => {
    expect(DEFAULT_SETTINGS.subtitles).toEqual({
      displayMode: "bilingual",
      shortsTranslationEnabled: false,
      translationColor: "#ffd438",
      originalColor: "#ececf0",
      translationFontScale: 100,
      originalFontScale: 100,
      verticalPosition: null,
    });
  });

  it("accepts original, translation and bilingual modes only", () => {
    expect(parseCaptionDisplayMode("original")).toBe("original");
    expect(parseCaptionDisplayMode("bilingual")).toBe("bilingual");
    expect(parseCaptionDisplayMode("off")).toBeNull();
    expect(parseCaptionDisplayMode("x")).toBeNull();
  });

  it("migrates existing subtitle settings to the default appearance", () => {
    expect(parseSubtitleSettings({ displayMode: "translation" })).toEqual({
      displayMode: "translation",
      shortsTranslationEnabled: false,
      translationColor: "#ffd438",
      originalColor: "#ececf0",
      translationFontScale: 100,
      originalFontScale: 100,
      verticalPosition: null,
    });
  });

  it("parses subtitle appearance and a custom vertical position", () => {
    expect(parseSubtitleSettings({
      displayMode: "translation",
      shortsTranslationEnabled: true,
      translationColor: "#123456",
      originalColor: "#abcdef",
      translationFontScale: 120,
      originalFontScale: 90,
      verticalPosition: 0.25,
    })).toEqual({
      displayMode: "translation",
      shortsTranslationEnabled: true,
      translationColor: "#123456",
      originalColor: "#abcdef",
      translationFontScale: 120,
      originalFontScale: 90,
      verticalPosition: 0.25,
    });
  });

  it("rejects invalid subtitle appearance values", () => {
    expect(parseSubtitleSettings({ displayMode: "nope" })).toBeNull();
    expect(parseSubtitleSettings({ displayMode: "translation", translationColor: "blue" })).toBeNull();
    expect(parseSubtitleSettings({ displayMode: "translation", translationFontScale: 170 })).toBeNull();
    expect(parseSubtitleSettings({ displayMode: "translation", verticalPosition: 2 })).toBeNull();
    expect(parseSubtitleSettings({ displayMode: "translation", shortsTranslationEnabled: "yes" })).toBeNull();
    expect(parseSubtitleSettings(null)).toBeNull();
  });
});

describe("language normalization", () => {
  it("normalizes simplified and traditional Chinese", () => {
    expect(normalizeLanguageTag("zh-CN")).toBe("zh-Hans");
    expect(normalizeLanguageTag("zh-TW")).toBe("zh-Hant");
    expect(normalizeLanguageTag("fr-ca")).toBe("fr-CA");
  });
});
