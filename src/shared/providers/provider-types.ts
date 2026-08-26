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
  /** Static model list for providers without a model discovery endpoint. */
  models?: readonly string[];
  /** Exact documented limits for known models. Unknown live models have no limit metadata. */
  modelLimits?: Readonly<Record<string, ProviderModelLimits>>;
  /** Provider-specific request fields applied to every completion request. */
  requestBody?: Readonly<Record<string, unknown>>;
  /** Path appended to `baseUrl` for the chat/completions or messages endpoint. */
  requestPath: string;
  /** Optional path appended to `baseUrl` for listing models (GET). */
  modelsPath?: string;
}

export interface ProviderModelLimits {
  contextWindowTokens: number;
  maxOutputTokens: number;
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

export type CompletionTextDeltaHandler = (delta: string) => void;

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
  /** Optional SSE path. The full text is still returned for validation and caching. */
  completeStream?(
    request: CompletionRequest,
    options: CompletionOptions,
    onTextDelta: CompletionTextDeltaHandler,
  ): Promise<CompletionResult>;
  listModels(apiKey: string): Promise<ModelListResult>;
}
