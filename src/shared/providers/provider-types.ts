// Unified LLM provider contract.
//
// Every provider is exposed through a single `ProviderAdapter` that only shims
// the HTTP message format. Prompt construction and result validation live in
// `shared/translation`, so the adapter never decides what to send or how to
// interpret the semantics of the reply — it only converts a structured
// completion request into the provider's wire format and back into plain text.

export type ProviderKind = "openai-compatible" | "anthropic-messages";

export interface ProviderPreset {
  id: string;
  displayName: string;
  kind: ProviderKind;
  baseUrl: string;
  models: readonly string[];
  defaultModel: string;
  contextWindowTokens: number;
  /** Optional provider/model output limit used to cap generated translations. */
  maxOutputTokens?: number;
  /** Path appended to `baseUrl` for the chat/completions or messages endpoint. */
  requestPath: string;
  /** Optional path appended to `baseUrl` for listing models (GET). */
  modelsPath?: string;
  /**
   * Optional allowlist of model IDs applied to the list returned by
   * `listModels`. Used by gateways that expose one discoverable `/models`
   * endpoint but route different model families to different protocols (e.g.
   * OpenCode Zen): only the models this adapter can actually complete are
   * surfaced, so the dropdown never offers a model that would fail.
   */
  modelAllowlist?: readonly string[];
}

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
}

export interface CompletionOptions {
  model: string;
  apiKey: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export type ProviderFailureReason =
  | "auth"
  | "rate-limit"
  | "timeout"
  | "network"
  | "bad-response"
  | "model";

export interface ProviderFailure {
  reason: ProviderFailureReason;
  /** Sanitized message: never includes the API key, request body or response text. */
  message: string;
}

export type CompletionResult =
  | { ok: true; text: string }
  | { ok: false; error: ProviderFailure };

export type ModelListResult =
  | { ok: true; models: string[] }
  | { ok: false; error: ProviderFailure };

export interface ProviderAdapter {
  readonly preset: ProviderPreset;
  complete(request: CompletionRequest, options: CompletionOptions): Promise<CompletionResult>;
  listModels(apiKey: string): Promise<ModelListResult>;
}
