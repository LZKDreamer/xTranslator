import { describe, expect, it } from "vitest";
import {
  createProviderAdapter,
  getProviderContextWindow,
  getProviderMaxOutputTokens,
  getProviderPreset,
  listProviderPresets,
  PROVIDER_PRESETS,
  UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
} from "../src/shared/providers/provider-registry";

describe("provider registry", () => {
  it("exposes a DeepSeek preset as OpenAI-compatible with runtime model discovery", () => {
    const deepseek = getProviderPreset("deepseek");
    expect(deepseek).not.toBeNull();
    expect(deepseek?.kind).toBe("openai-compatible");
    expect(deepseek?.baseUrl).toBe("https://api.deepseek.com");
    expect(deepseek?.apiKeyUrl).toBe("https://platform.deepseek.com/api_keys");
    expect(deepseek?.models).toBeUndefined();

    for (const providerId of ["openai", "anthropic"]) {
      const preset = getProviderPreset(providerId);
      expect(preset?.models).toBeUndefined();
    }
  });

  it("exposes an Anthropic Messages preset", () => {
    const anthropic = getProviderPreset("anthropic");
    expect(anthropic?.kind).toBe("anthropic-messages");
    expect(anthropic?.baseUrl).toBe("https://api.anthropic.com");
    expect(anthropic?.apiKeyUrl).toBe("https://platform.claude.com/settings/keys");
  });

  it("discovers models through provider APIs except for the static Agnes catalog", () => {
    expect(getProviderPreset("deepseek")?.modelsPath).toBe("/models");
    expect(getProviderPreset("openai")?.modelsPath).toBe("/v1/models");
    expect(getProviderPreset("anthropic")?.modelsPath).toBe("/v1/models");
    expect(getProviderPreset("agnes")?.modelsPath).toBeUndefined();
  });

  it("exposes Agnes 2.5 Flash through its OpenAI-compatible API", () => {
    const agnes = getProviderPreset("agnes");
    expect(agnes?.displayName).toBe("Agnes AI");
    expect(agnes?.kind).toBe("openai-compatible");
    expect(agnes?.baseUrl).toBe("https://apihub.agnes-ai.com/v1");
    expect(agnes?.apiKeyUrl).toBe("https://platform.agnes-ai.com/settings/apiKeys");
    expect(agnes?.requestPath).toBe("/chat/completions");
    expect(agnes?.models).toEqual(["agnes-2.5-flash"]);
    expect(getProviderContextWindow(agnes!, "agnes-2.5-flash")).toBe(512_000);
    expect(getProviderMaxOutputTokens(agnes!, "agnes-2.5-flash")).toBe(65_536);
  });

  it("resolves documented per-model limits and leaves unknown gateway output limits unset", () => {
    const deepseek = getProviderPreset("deepseek")!;
    expect(getProviderContextWindow(deepseek, "deepseek-v4-flash")).toBe(1_000_000);
    expect(getProviderMaxOutputTokens(deepseek, "deepseek-v4-flash")).toBe(384_000);

    expect(getProviderMaxOutputTokens(deepseek, "new-model-from-provider-api")).toBeUndefined();
    expect(getProviderContextWindow(deepseek, "new-model-from-provider-api")).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS);
  });

  it("uses Agnes's documented model list without an undocumented discovery request", async () => {
    const agnes = getProviderPreset("agnes")!;
    const adapter = createProviderAdapter(agnes, () => Promise.reject(new Error("should not request models")));
    await expect(adapter.listModels("secret")).resolves.toEqual({ ok: true, models: ["agnes-2.5-flash"] });
  });

  it("returns null for unknown provider ids", () => {
    expect(getProviderPreset("not-a-provider")).toBeNull();
  });

  it("creates an adapter that keeps its preset", () => {
    const preset = getProviderPreset("openai");
    const adapter = createProviderAdapter(preset!, () => Promise.reject(new Error("no network")));
    expect(adapter.preset.id).toBe("openai");
    expect(adapter.preset.kind).toBe("openai-compatible");
  });

  it("lists at least the three built-in presets", () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(listProviderPresets().map((preset) => preset.id)).toContain("deepseek");
  });

  it("provides an official API key creation page for every provider", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.apiKeyUrl).toMatch(/^https:\/\//u);
    }
    expect(getProviderPreset("openai")?.apiKeyUrl).toBe("https://platform.openai.com/api-keys");
  });
});
