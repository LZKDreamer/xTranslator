// Versioned LLM provider registry.
//
// Base URLs, model lists and context windows are versioned configuration, never
// inline strings. Per the engineering standards, business code must not hardcode
// provider endpoints or model IDs; it resolves a `ProviderPreset` by id from
// here. Additional providers are added by appending to `PROVIDER_PRESETS` — no
// other code changes are required.

import { createAnthropicAdapter } from "./anthropic-messages";
import { createOpenAiAdapter } from "./openai-compatible";
import type { ProviderAdapter, ProviderKind, ProviderPreset } from "./provider-types";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    contextWindowTokens: 65_536,
    requestPath: "/chat/completions",
    modelsPath: "/models",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com",
    models: ["gpt-4o-mini", "gpt-4o"],
    defaultModel: "gpt-4o-mini",
    contextWindowTokens: 128_000,
    requestPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    kind: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
    defaultModel: "claude-3-5-haiku-latest",
    contextWindowTokens: 200_000,
    requestPath: "/v1/messages",
    modelsPath: "/v1/models",
  },
  {
    id: "agnes",
    displayName: "Agnes AI",
    kind: "openai-compatible",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    models: ["agnes-2.5-flash"],
    defaultModel: "agnes-2.5-flash",
    contextWindowTokens: 512_000,
    maxOutputTokens: 65_536,
    requestPath: "/chat/completions",
  },
  {
    id: "opencode",
    displayName: "OpenCode Zen",
    kind: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/v1",
    // OpenCode Zen is a multi-protocol gateway: GPT/Grok/Muse use `/responses`,
    // Claude/Qwen use `/messages`, Gemini uses `/models/{id}` — none of which
    // this adapter speaks. Only the documented `@ai-sdk/openai-compatible`
    // models below use `/chat/completions`, so the plugin filters the live
    // `/models` list down to `modelAllowlist` and never offers a model that
    // would fail the completion call.
    models: [],
    defaultModel: "deepseek-v4-flash",
    contextWindowTokens: 64_000,
    requestPath: "/chat/completions",
    modelsPath: "/models",
    modelAllowlist: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "big-pickle",
      "x-preview-f-free",
      "mimo-v2.5-free",
      "hy3-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
    ],
  },
] as const;

export function getProviderPreset(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function listProviderPresets(): readonly ProviderPreset[] {
  return PROVIDER_PRESETS;
}

export function createProviderAdapter(
  preset: ProviderPreset,
  fetchFn: (input: string, init: RequestInit) => Promise<Response>,
): ProviderAdapter {
  return createAdapterForKind(preset.kind, preset, fetchFn);
}

function createAdapterForKind(
  kind: ProviderKind,
  preset: ProviderPreset,
  fetchFn: (input: string, init: RequestInit) => Promise<Response>,
): ProviderAdapter {
  if (kind === "anthropic-messages") {
    return createAnthropicAdapter(preset, fetchFn);
  }
  return createOpenAiAdapter(preset, fetchFn);
}
