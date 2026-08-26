// Versioned LLM provider registry.
//
// Base URLs, model lists and context windows are versioned configuration, never
// inline strings. Per the engineering standards, business code must not hardcode
// provider endpoints or model IDs; it resolves a `ProviderPreset` by id from
// here. Additional providers are added by appending to `PROVIDER_PRESETS` — no
// other code changes are required.

import { createAnthropicAdapter } from "./anthropic-messages";
import { createOpenAiAdapter } from "./openai-compatible";
import type { ProviderAdapter, ProviderKind, ProviderModelLimits, ProviderPreset } from "./provider-types";

/** Local batching guard used when a live model list has no published limits. */
export const UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS = 8_192;

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    modelLimits: {
      "deepseek-v4-flash": { contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 },
      "deepseek-v4-pro": { contextWindowTokens: 1_000_000, maxOutputTokens: 384_000 },
    },
    requestBody: { thinking: { type: "disabled" } },
    requestPath: "/chat/completions",
    modelsPath: "/models",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com",
    modelLimits: {
      "gpt-4o-mini": { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
      "gpt-4o": { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
    },
    requestPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    apiKeyUrl: "https://platform.claude.com/settings/keys",
    kind: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    modelLimits: {
      "claude-haiku-4-5-20251001": { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
      "claude-sonnet-5": { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
    },
    requestPath: "/v1/messages",
    modelsPath: "/v1/models",
  },
  {
    id: "agnes",
    displayName: "Agnes AI",
    apiKeyUrl: "https://platform.agnes-ai.com/settings/apiKeys",
    kind: "openai-compatible",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    models: ["agnes-2.5-flash"],
    modelLimits: {
      "agnes-2.5-flash": { contextWindowTokens: 512_000, maxOutputTokens: 65_536 },
    },
    requestPath: "/chat/completions",
  },
] as const;

export function getProviderPreset(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function listProviderPresets(): readonly ProviderPreset[] {
  return PROVIDER_PRESETS;
}

export function getProviderModelLimits(preset: ProviderPreset, model: string): ProviderModelLimits | null {
  return preset.modelLimits?.[model] ?? null;
}

export function getProviderContextWindow(preset: ProviderPreset, model: string): number {
  return getProviderModelLimits(preset, model)?.contextWindowTokens ?? UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS;
}

export function getProviderMaxOutputTokens(preset: ProviderPreset, model: string): number | undefined {
  return getProviderModelLimits(preset, model)?.maxOutputTokens;
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
