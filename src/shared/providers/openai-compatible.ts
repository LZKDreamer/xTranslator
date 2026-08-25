// OpenAI-compatible Chat Completions adapter.
//
// DeepSeek and OpenAI both expose an OpenAI-compatible `/chat/completions`
// endpoint, so one adapter covers them. It only converts the structured
// `CompletionRequest` into the wire format and extracts the assistant `content`
// string; it never interprets the semantics of the reply.

import { getWithRetry, postJsonWithRetry, type HttpFetch } from "./http-client";
import type {
  CompletionOptions,
  CompletionResult,
  ModelListResult,
  ProviderAdapter,
  ProviderPreset,
} from "./provider-types";

const BAD_RESPONSE = { reason: "bad-response", message: "Provider returned a malformed response." } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readContent(response: Response, endpoint: string): Promise<CompletionResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    console.warn("[xTranslator] LLM returned non-JSON completion data", { endpoint });
    return { ok: false, error: { ...BAD_RESPONSE } };
  }

  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    console.warn("[xTranslator] LLM returned a non-Chat-Completions payload", { endpoint });
    return { ok: false, error: { ...BAD_RESPONSE } };
  }

  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    console.warn("[xTranslator] LLM completion has no text message content", { endpoint });
    return { ok: false, error: { ...BAD_RESPONSE } };
  }

  const content = first.message.content.trim();
  return content ? { ok: true, text: content } : { ok: false, error: { ...BAD_RESPONSE } };
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

export function createOpenAiAdapter(preset: ProviderPreset, fetchFn: HttpFetch): ProviderAdapter {
  return {
    preset,
    async complete(request, options: CompletionOptions): Promise<CompletionResult> {
      const url = `${preset.baseUrl}${preset.requestPath}`;
      const body: Record<string, unknown> = {
        model: options.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}),
      };

      const result = await postJsonWithRetry(fetchFn, url, body, {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      return readContent(result.response, url);
    },
    async listModels(apiKey: string): Promise<ModelListResult> {
      if (!preset.modelsPath) {
        return preset.models.length > 0
          ? { ok: true, models: [...preset.models] }
          : { ok: false, error: { ...BAD_RESPONSE } };
      }
      const url = `${preset.baseUrl}${preset.modelsPath}`;
      const result = await getWithRetry(fetchFn, url, {
        authorization: `Bearer ${apiKey}`,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      const listed = await readModelIds(result.response);
      if (!listed.ok || !preset.modelAllowlist) {
        return listed;
      }
      const allowed = new Set(preset.modelAllowlist);
      return { ok: true, models: listed.models.filter((model) => allowed.has(model)) };
    },
  };
}
