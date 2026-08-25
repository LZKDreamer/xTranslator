import { describe, expect, it } from "vitest";
import {
  createProviderAdapter,
  getProviderPreset,
  listProviderPresets,
  PROVIDER_PRESETS,
} from "../src/shared/providers/provider-registry";

describe("provider registry", () => {
  it("exposes a DeepSeek preset as OpenAI-compatible by default", () => {
    const deepseek = getProviderPreset("deepseek");
    expect(deepseek).not.toBeNull();
    expect(deepseek?.kind).toBe("openai-compatible");
    expect(deepseek?.baseUrl).toBe("https://api.deepseek.com");
    expect(deepseek?.defaultModel).toBe("deepseek-chat");
    expect(deepseek?.models).toContain("deepseek-chat");
  });

  it("exposes an Anthropic Messages preset", () => {
    const anthropic = getProviderPreset("anthropic");
    expect(anthropic?.kind).toBe("anthropic-messages");
    expect(anthropic?.baseUrl).toBe("https://api.anthropic.com");
  });

  it("exposes Agnes 2.5 Flash through its OpenAI-compatible API", () => {
    const agnes = getProviderPreset("agnes");
    expect(agnes?.displayName).toBe("Agnes AI");
    expect(agnes?.kind).toBe("openai-compatible");
    expect(agnes?.baseUrl).toBe("https://apihub.agnes-ai.com/v1");
    expect(agnes?.requestPath).toBe("/chat/completions");
    expect(agnes?.defaultModel).toBe("agnes-2.5-flash");
    expect(agnes?.models).toEqual(["agnes-2.5-flash"]);
    expect(agnes?.contextWindowTokens).toBe(512_000);
    expect(agnes?.maxOutputTokens).toBe(65_536);
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

  it("exposes an OpenCode Zen preset limited to OpenAI-compatible models", () => {
    const opencode = getProviderPreset("opencode");
    expect(opencode).not.toBeNull();
    expect(opencode?.kind).toBe("openai-compatible");
    expect(opencode?.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(opencode?.requestPath).toBe("/chat/completions");
    expect(opencode?.modelsPath).toBe("/models");
    expect(opencode?.defaultModel).toBe("deepseek-v4-flash");
    expect(opencode?.modelAllowlist).toContain("deepseek-v4-flash");
    // Models that OpenCode Zen serves through other protocols must not be offered.
    expect(opencode?.modelAllowlist).not.toContain("gpt-5");
  });

  it("lists at least the three built-in presets", () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(listProviderPresets().map((preset) => preset.id)).toContain("deepseek");
  });
});
