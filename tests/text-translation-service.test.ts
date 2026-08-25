import { describe, expect, it } from "vitest";
import { TextTranslationService } from "../src/shared/translation/text-translation-service";
import { getProviderPreset } from "../src/shared/providers/provider-registry";
import type { CompletionOptions, CompletionRequest, CompletionResult, ProviderAdapter } from "../src/shared/providers/provider-types";
import type { TextTranslationItem } from "../src/shared/translation/translation-types";

const preset = getProviderPreset("deepseek")!;

function makeAdapter(complete: (req: CompletionRequest) => Promise<CompletionResult>): ProviderAdapter {
  return {
    preset,
    complete,
    listModels: async () => ({ ok: true, models: [] as string[] }),
  };
}

function makeAdapterWithOptions(
  complete: (req: CompletionRequest, options: CompletionOptions) => Promise<CompletionResult>,
): ProviderAdapter {
  return {
    preset: getProviderPreset("agnes")!,
    complete,
    listModels: async () => ({ ok: true, models: [] as string[] }),
  };
}

function context(adapter: ProviderAdapter) {
  return { targetLanguage: "zh-Hans", adapter, apiKey: "secret", model: "deepseek-chat" };
}

function idsFromPrompt(prompt: string): string[] {
  return Array.from(prompt.matchAll(/\[([^\]]+)\]/g)).map((match) => match[1]!);
}

function line(id: string, text: string): string {
  return JSON.stringify({ id, text });
}

describe("TextTranslationService", () => {
  it("translates all items and returns the id->text map", async () => {
    const adapter = makeAdapter(async (req) => {
      const ids = idsFromPrompt(req.userPrompt);
      return { ok: true, text: ids.map((id) => line(id, "译：" + id)).join("\n") };
    });
    const run = await new TextTranslationService().translate(
      [
        { id: "c1", sourceText: "hello" },
        { id: "c2", sourceText: "world" },
      ],
      context(adapter),
    );
    expect(run).toEqual({ ok: true, translations: { c1: "译：c1", c2: "译：c2" }, missingIds: [] });
  });

  it("reports ids the model failed to answer", async () => {
    const adapter = makeAdapter(async (req) => {
      const ids = idsFromPrompt(req.userPrompt);
      return { ok: true, text: line(ids[0]!, "译") };
    });
    const run = await new TextTranslationService().translate(
      [
        { id: "c1", sourceText: "hello" },
        { id: "c2", sourceText: "world" },
      ],
      context(adapter),
    );
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.translations).toEqual({ c1: "译" });
      expect(run.missingIds).toEqual(["c2"]);
    }
  });

  it("surfaces a provider failure as an error response", async () => {
    const adapter = makeAdapter(async () => ({ ok: false, error: { reason: "auth", message: "rejected" } }));
    const run = await new TextTranslationService().translate([{ id: "c1", sourceText: "hi" }], context(adapter));
    expect(run).toEqual({ ok: false, errorMessage: "服务密钥无效或权限不足，请到偏好设置检查。" });
  });

  it("keeps completed comments when a later comment request fails", async () => {
    let calls = 0;
    const adapter = makeAdapter(async (req) => {
      calls += 1;
      if (calls === 2) {
        return { ok: false, error: { reason: "timeout", message: "timed out" } };
      }
      const id = idsFromPrompt(req.userPrompt)[0]!;
      return { ok: true, text: line(id, "译：" + id) };
    });

    const run = await new TextTranslationService().translate(
      [
        { id: "c1", sourceText: "first" },
        { id: "c2", sourceText: "second" },
        { id: "c3", sourceText: "third" },
      ],
      { ...context(adapter), singleItemBatches: true },
    );

    expect(run).toEqual({
      ok: true,
      translations: { c1: "译：c1" },
      missingIds: ["c2", "c3"],
      errorMessage: "翻译请求超时，请重试。",
    });
  });

  it("treats an empty comment translation as missing", async () => {
    const adapter = makeAdapter(async (req) => {
      const id = idsFromPrompt(req.userPrompt)[0]!;
      return { ok: true, text: line(id, "   ") };
    });

    const run = await new TextTranslationService().translate(
      [{ id: "c1", sourceText: "hello" }],
      { ...context(adapter), singleItemBatches: true },
    );

    expect(run).toEqual({ ok: true, translations: {}, missingIds: ["c1"] });
  });

  it("concatenates results across batches", async () => {
    let calls = 0;
    const adapter = makeAdapter(async (req) => {
      calls += 1;
      const ids = idsFromPrompt(req.userPrompt);
      return { ok: true, text: ids.map((id) => line(id, "译" + id)).join("\n") };
    });
    const items: TextTranslationItem[] = Array.from({ length: 4 }, (_, index) => ({
      id: `c${index}`,
      sourceText: `item ${index}`,
    }));
    const run = await new TextTranslationService().translate(items, context(adapter));
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(Object.keys(run.translations)).toHaveLength(4);
      expect(run.missingIds).toEqual([]);
    }
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("uses one request per comment to keep text bound to its comment id", async () => {
    const prompts: string[] = [];
    const adapter = makeAdapter(async (req) => {
      prompts.push(req.userPrompt);
      const id = idsFromPrompt(req.userPrompt)[0]!;
      return { ok: true, text: line(id, `译：${id}`) };
    });

    const run = await new TextTranslationService().translate(
      [
        { id: "c1", sourceText: "first" },
        { id: "c2", sourceText: "second" },
      ],
      { ...context(adapter), singleItemBatches: true },
    );

    expect(prompts).toHaveLength(2);
    expect(run).toEqual({ ok: true, translations: { c1: "译：c1", c2: "译：c2" }, missingIds: [] });
  });

  it("caps the output request for large-context providers", async () => {
    let receivedOptions: CompletionOptions | undefined;
    const adapter = makeAdapterWithOptions(async (req, options) => {
      receivedOptions = options;
      const ids = idsFromPrompt(req.userPrompt);
      return { ok: true, text: line(ids[0]!, "译") };
    });

    await new TextTranslationService().translate(
      [{ id: "c1", sourceText: "hello" }],
      { targetLanguage: "zh-Hans", adapter, apiKey: "secret", model: "agnes-2.5-flash" },
    );

    expect(receivedOptions?.maxOutputTokens).toBe(4_096);
  });
});
