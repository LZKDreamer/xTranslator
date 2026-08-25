// Anthropic Messages adapter.
//
// The Anthropic Messages API puts the system prompt in a top-level `system`
// field and returns an array of content blocks. This adapter converts the
// structured `CompletionRequest` to that shape and extracts the concatenated
// text from the reply.

import { getWithRetry, postJsonWithRetry, type HttpFetch } from "./http-client";
import type {
  CompletionOptions,
  CompletionResult,
  ModelListResult,
  ProviderAdapter,
  ProviderPreset,
} from "./provider-types";

const ANTHROPIC_VERSION = "2023-06-01";
const BAD_RESPONSE = { reason: "bad-response", message: "Provider returned a malformed response." } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readTextContent(response: Response, endpoint: string): Promise<CompletionResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    console.warn("[xTranslator] LLM returned non-JSON completion data", { endpoint });
    return { ok: false, error: { ...BAD_RESPONSE } };
  }

  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    console.warn("[xTranslator] LLM returned a non-Messages payload", { endpoint });
    return { ok: false, error: { ...BAD_RESPONSE } };
  }

  const fragments = payload.content.flatMap((block) =>
    isRecord(block) && typeof block.text === "string" ? [block.text] : [],
  );
  const text = fragments.join("").trim();
  return text ? { ok: true, text } : { ok: false, error: { ...BAD_RESPONSE } };
}

async function readModelIds(response: Response): Promise<ModelListResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    return { ok: false, error: { ...BAD_RESPONSE } };
  }

  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return { ok: false, error: { ...BAD_RESPONSE } };
  }

  const models = payload.data
    .map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : null))
    .filter((id): id is string => id !== null && id.length > 0);

  return models.length > 0 ? { ok: true, models } : { ok: false, error: { ...BAD_RESPONSE } };
}

export function createAnthropicAdapter(preset: ProviderPreset, fetchFn: HttpFetch): ProviderAdapter {
  const headers = (apiKey: string): Record<string, string> => ({
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  });

  return {
    preset,
    async complete(request, options: CompletionOptions): Promise<CompletionResult> {
      const url = `${preset.baseUrl}${preset.requestPath}`;
      const body: Record<string, unknown> = {
        model: options.model,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
        ...(options.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      };

      const result = await postJsonWithRetry(fetchFn, url, body, headers(options.apiKey));
      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      return readTextContent(result.response, url);
    },
    async listModels(apiKey: string): Promise<ModelListResult> {
      const url = `${preset.baseUrl}${preset.modelsPath}`;
      const result = await getWithRetry(fetchFn, url, headers(apiKey));
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return readModelIds(result.response);
    },
  };
}
