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
    return jsonResponse({ content: [{ type: "text", text: "你好" }] });
  };
  return { adapter: createProviderAdapter(getProviderPreset("anthropic")!, fetchFn), calls };
}

describe("Anthropic Messages adapter", () => {
  it("sends the system prompt in a top-level system field with Anthropic headers", async () => {
    const { adapter, calls } = capturingAdapter();
    const result = await adapter.complete(
      { systemPrompt: "system-prompt", userPrompt: "user-prompt" },
      { model: "claude-3-5-haiku-latest", apiKey: "sk-ant-secret", maxOutputTokens: 500 },
    );

    expect(result).toEqual({ ok: true, text: "你好" });
    const captured = calls[0]!;
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = captured.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(captured.init.body)) as { system: string; messages: unknown[] };
    expect(body.system).toBe("system-prompt");
    expect(body.messages).toHaveLength(1);
  });

  it("concatenates multiple text blocks", async () => {
    const { adapter } = capturingAdapter(() =>
      jsonResponse({ content: [{ type: "text", text: "你" }, { type: "text", text: "好" }] }),
    );
    const result = await adapter.complete({ systemPrompt: "s", userPrompt: "u" }, { model: "m", apiKey: "k" });
    expect(result).toEqual({ ok: true, text: "你好" });
  });

  it("maps rate limits to a rate-limit failure", async () => {
    const { adapter } = capturingAdapter(() => jsonResponse({}, 429));
    const result = await adapter.complete({ systemPrompt: "s", userPrompt: "u" }, { model: "m", apiKey: "k" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("rate-limit");
    }
  });

  it("lists real models with Anthropic headers", async () => {
    const { adapter, calls } = capturingAdapter(() =>
      jsonResponse({ data: [{ id: "claude-3-5-haiku-latest" }] }),
    );
    const result = await adapter.listModels("sk-ant-secret");
    expect(result).toEqual({ ok: true, models: ["claude-3-5-haiku-latest"] });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-secret");
  });
});
