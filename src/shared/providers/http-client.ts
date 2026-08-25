// Minimal HTTP client for provider calls.
//
// This module owns the retry/timeout budget and maps HTTP/network failures to
// sanitized `ProviderFailure`s. It never logs the API key or the request/response
// body, and error messages are provider-aggregate strings, never the raw payload.

import type { ProviderFailure, ProviderFailureReason } from "./provider-types";

export type HttpFetch = (input: string, init: RequestInit) => Promise<Response>;

export const HTTP_RETRY = { maxAttempts: 3, baseDelayMs: 800, timeoutMs: 120_000 } as const;

export type HttpResult =
  | { ok: true; response: Response }
  | { ok: false; error: ProviderFailure };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetryHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function mapHttpStatusCode(status: number): ProviderFailure {
  if (status === 401 || status === 403) {
    return { reason: "auth", message: "Provider rejected the API key." };
  }
  if (status === 429) {
    return { reason: "rate-limit", message: "Provider rate limit reached; try again shortly." };
  }
  if (status === 404) {
    return { reason: "model", message: "The selected model was not found for this provider." };
  }
  if (status >= 500) {
    return { reason: "bad-response", message: "Provider returned a server error." };
  }
  return { reason: "bad-response", message: "Provider returned an unexpected response." };
}

function logProviderHttpFailure(url: string, status: number, attempt: number): void {
  // Deliberately log only the origin/status/attempt. Request bodies and API keys
  // must never reach the service-worker console.
  let origin = "unknown";
  try {
    origin = new URL(url).origin;
  } catch {
    // Keep the diagnostic safe even for a malformed configured URL.
  }
  console.warn("[xTranslator] LLM HTTP request failed", { origin, status, attempt });
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function mapNetworkError(error: unknown): ProviderFailure {
  if (isAbortError(error)) {
    return { reason: "timeout", message: "Provider request timed out." };
  }
  return { reason: "network", message: "Provider request failed over the network." };
}

function mapFailureReason(reason: ProviderFailureReason): boolean {
  return reason === "timeout" || reason === "network";
}

async function sendWithRetry(
  fetchFn: HttpFetch,
  url: string,
  init: Omit<RequestInit, "signal">,
  retry: typeof HTTP_RETRY,
): Promise<HttpResult> {
  let lastFailure: ProviderFailure | null = null;

  for (let attempt = 0; attempt < retry.maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(retry.baseDelayMs * 2 ** (attempt - 1));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), retry.timeoutMs);
    try {
      const response = await fetchFn(url, { ...init, signal: controller.signal });

      if (response.ok) {
        return { ok: true, response };
      }

      logProviderHttpFailure(url, response.status, attempt + 1);
      const failure = mapHttpStatusCode(response.status);
      if (shouldRetryHttpStatus(response.status) && attempt < retry.maxAttempts - 1) {
        lastFailure = failure;
        continue;
      }
      return { ok: false, error: failure };
    } catch (error) {
      const failure = mapNetworkError(error);
      console.warn("[xTranslator] LLM request failed before a response", { reason: failure.reason, attempt: attempt + 1 });
      if (mapFailureReason(failure.reason) && attempt < retry.maxAttempts - 1) {
        lastFailure = failure;
        continue;
      }
      return { ok: false, error: failure };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, error: lastFailure ?? { reason: "network", message: "Provider request failed." } };
}

export async function postJsonWithRetry(
  fetchFn: HttpFetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  retry: typeof HTTP_RETRY = HTTP_RETRY,
): Promise<HttpResult> {
  return sendWithRetry(fetchFn, url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, retry);
}

export async function getWithRetry(
  fetchFn: HttpFetch,
  url: string,
  headers: Record<string, string>,
  retry: typeof HTTP_RETRY = HTTP_RETRY,
): Promise<HttpResult> {
  return sendWithRetry(fetchFn, url, { method: "GET", headers }, retry);
}

export function createSanitizedProviderFailure(reason: ProviderFailureReason, message: string): ProviderFailure {
  return { reason, message };
}
