import { describe, expect, it } from "vitest";
import { createProviderAdapter, getProviderPreset } from "../src/shared/providers/provider-registry";
import type { ProviderAdapter } from "../src/shared/providers/provider-types";
import type { HttpFetch } from "../src/shared/providers/http-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Capture {
  url: string;
  init: RequestInit;
}

function capturingAdapter(onRequest?: (capture: Capture) => Response | Promise<Response>): { adapter: ProviderAdapter; calls: Capture[] } {
  const calls: Capture[] = [];
  const fetchFn: HttpFetch = async (url, init) => {
    const capture = { url, init };
    calls.push(capture);
    if (onRequest) {
      return onRequest(capture);
    }
    return jsonResponse({ choices: [{ message: { content: "你好" } }] });
  };
  return { adapter: createProviderAdapter(getProviderPreset("deepseek")!, fetchFn), calls };
}

describe("OpenAI-compatible adapter", () => {
  it("posts to the provider endpoint with a Bearer auth header and OpenAI body", async () => {
    const { adapter, calls } = capturingAdapter();
    const result = await adapter.complete(
      { systemPrompt: "system", userPrompt: "user" },
      { model: "deepseek-chat", apiKey: "secret", maxOutputTokens: 1000, temperature: 0.2 },
    );

    expect(result).toEqual({ ok: true, text: "你好" });
    const captured = calls[0]!;
    expect(captured.url).toBe("https://api.deepseek.com/chat/completions");
    const headers = captured.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(String(captured.init.body)) as { model: string; messages: Array<{ role: string }> };
    expect(body.model).toBe("deepseek-chat");
    expect(body.messages).toHaveLength(2);
    expect(JSON.parse(String(captured.init.body))).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("reads OpenAI-compatible SSE deltas without changing the prompt contract", async () => {
    const chunks = [
      { choices: [{ delta: { content: '{"id":"block-1","text":"你' } }] },
      { choices: [{ delta: { content: '好"}' } }] },
    ];
    const { adapter, calls } = capturingAdapter(() => new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const deltas: string[] = [];
    const result = await adapter.completeStream?.(
      { systemPrompt: "system", userPrompt: "user" },
      { model: "deepseek-v4-flash", apiKey: "secret", maxOutputTokens: 512 },
      (delta) => deltas.push(delta),
    );

    expect(result).toEqual({ ok: true, text: '{"id":"block-1","text":"你好"}' });
    expect(deltas).toEqual(['{"id":"block-1","text":"你', '好"}']);
    const body = JSON.parse(String(calls[0]!.init.body)) as { stream: boolean; messages: unknown[] };
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(2);
  });

  it("maps auth failures to a sanitized auth error", async () => {
    const { adapter } = capturingAdapter(() => jsonResponse({ error: "invalid key" }, 401));
    const result = await adapter.complete({ systemPrompt: "s", userPrompt: "u" }, { model: "m", apiKey: "bad" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("auth");
      expect(result.error.message).not.toContain("bad");
    }
  });

  it("maps a malformed reply to a bad-response error", async () => {
    const { adapter } = capturingAdapter(() => new Response("not json", { status: 200 }));
    const result = await adapter.complete({ systemPrompt: "s", userPrompt: "u" }, { model: "m", apiKey: "k" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("bad-response");
    }
  });

  it("maps rate limits to a rate-limit failure", async () => {
    const { adapter } = capturingAdapter(() => jsonResponse({}, 429));
    const result = await adapter.complete({ systemPrompt: "s", userPrompt: "u" }, { model: "m", apiKey: "k" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("rate-limit");
    }
  });

  it("lists real models from the provider models endpoint", async () => {
    const { adapter, calls } = capturingAdapter(() =>
      jsonResponse({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] }),
    );
    const result = await adapter.listModels("secret");
    expect(result).toEqual({ ok: true, models: ["deepseek-v4-flash", "deepseek-v4-pro"] });
    expect(calls[0]!.url).toBe("https://api.deepseek.com/models");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
  });

});
