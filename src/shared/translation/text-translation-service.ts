// Free-text translation orchestrator (comments and selections).
//
// The video caption pipeline is timeline-bound and cached; free text is not. This
// service batches items by token budget, sends each batch through the provider
// adapter using the generic free-text prompt, validates the JSON-Lines reply back
// to stable item ids, and returns the id->text map plus any ids the model failed
// to answer. It never logs the API key or a request/response body.

import { userFacingProviderMessage } from "../providers/provider-messages";
import type { ProviderAdapter } from "../providers/provider-types";
import { getProviderContextWindow, getProviderMaxOutputTokens } from "../providers/provider-registry";
import { PROMPT_OVERHEAD_TOKENS } from "./chunker";
import { computeInputTokenBudget } from "./chunker";
import { TranslationResultValidator } from "./result-validator";
import { buildTextSystemPrompt, buildTextUserPrompt } from "./text-prompt";
import { batchTextItems } from "./text-batch";
import type { TextTranslationItem } from "./translation-types";
import { shouldTranslateText } from "../locale/translation-needed";
import { estimateTokens } from "./token-estimator";
import { MODEL_RESPONSE_RETRY, waitForModelResponseRetry } from "./model-response-retry";

const MAX_OUTPUT_FACTOR = 512;
// Free-text requests are small (a viewport of comments or a selection). Do not
// turn a provider's context window into its requested output size: gateways may
// reject an otherwise valid request when max_tokens is hundreds of thousands.
const MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_TEMPERATURE = 0.2;

type TextBatchRun =
  | { ok: true; translations: { id: string; translatedText: string }[]; missingIds: string[] }
  | { ok: false; errorMessage: string };

export interface TextTranslationContext {
  targetLanguage: string;
  adapter: ProviderAdapter;
  apiKey: string;
  model: string;
  /** Read-only page context, used to disambiguate comment translations. */
  videoTitle?: string;
  /** Limits simultaneous provider calls. */
  maxConcurrentBatches?: number;
  onProgress?: (progress: TextTranslationProgress) => void;
}

export interface TextTranslationProgress {
  completed: number;
  total: number;
  translated: number;
  failed: number;
}

export type TextTranslationRun =
  | { ok: true; translations: Record<string, string>; missingIds: string[]; skippedIds?: string[]; errorMessage?: string }
  | { ok: false; errorMessage: string };

export class TextTranslationService {
  public constructor(private readonly validator = new TranslationResultValidator()) {}

  public async translate(
    items: readonly TextTranslationItem[],
    context: TextTranslationContext,
  ): Promise<TextTranslationRun> {
    const skippedIds = items
      .filter((item) => !shouldTranslateText(item.sourceText, context.targetLanguage))
      .map((item) => item.id);
    const translatableItems = items.filter((item) => !skippedIds.includes(item.id));
    if (translatableItems.length === 0) {
      return { ok: true, translations: {}, missingIds: [], skippedIds };
    }

    const translations: Record<string, string> = {};
    const missingIds: string[] = [];
    const contextWindowTokens = getProviderContextWindow(context.adapter.preset, context.model);
    const maxOutputTokens = this.getMaxOutputTokens(context, contextWindowTokens);
    const batches = batchTextItems(translatableItems, contextWindowTokens, {
      inputContextTokens: context.videoTitle ? estimateTokens(context.videoTitle) : 0,
      maxOutputTokens,
    });

    const batchRuns = await this.translateBatches(batches, context, maxOutputTokens, translatableItems.length);
    for (const { run } of batchRuns) {
      if (!run.ok) {
        return run;
      }
      for (const item of run.translations) {
        translations[item.id] = item.translatedText;
      }
      for (const id of run.missingIds) {
        if (translations[id] === undefined && !missingIds.includes(id)) {
          missingIds.push(id);
        }
      }
    }

    return {
      ok: true,
      translations,
      missingIds,
      ...(skippedIds.length > 0 ? { skippedIds } : {}),
    };
  }

  private async translateBatch(
    batch: readonly TextTranslationItem[],
    context: TextTranslationContext,
    maxOutputTokens: number | undefined,
  ): Promise<TextBatchRun> {
    const remaining = [...batch];
    const translations: { id: string; translatedText: string }[] = [];

    for (let attempt = 0; attempt < MODEL_RESPONSE_RETRY.maxAttempts && remaining.length > 0; attempt += 1) {
      const request = {
        systemPrompt: buildTextSystemPrompt(context.targetLanguage),
        userPrompt: buildTextUserPrompt(remaining, { videoTitle: context.videoTitle }),
      };
      const options = {
        model: context.model,
        apiKey: context.apiKey,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        temperature: DEFAULT_TEMPERATURE,
      };
      const completion = context.adapter.completeStream
        ? await context.adapter.completeStream(request, options, () => undefined)
        : await context.adapter.complete(request, options);

      if (!completion.ok) {
        return { ok: false, errorMessage: userFacingProviderMessage(completion.error.reason) };
      }

      const validated = this.validator.validate(remaining, completion.text);
      const matched = validated.matched.filter((item) => item.translatedText.trim().length > 0);
      const matchedIds = new Set(matched.map((item) => item.id));
      translations.push(...matched);
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        if (matchedIds.has(remaining[index]!.id)) {
          remaining.splice(index, 1);
        }
      }
      if (remaining.length > 0 && attempt < MODEL_RESPONSE_RETRY.maxAttempts - 1) {
        await waitForModelResponseRetry(attempt + 1);
      }
    }

    return { ok: true, translations, missingIds: remaining.map((item) => item.id) };
  }

  private getMaxOutputTokens(context: TextTranslationContext, contextWindowTokens: number): number | undefined {
    const documented = getProviderMaxOutputTokens(context.adapter.preset, context.model);
    return documented === undefined
      ? undefined
      : Math.min(MAX_OUTPUT_TOKENS, documented, Math.max(MAX_OUTPUT_FACTOR, computeInputTokenBudget(contextWindowTokens) + PROMPT_OVERHEAD_TOKENS));
  }

  private async translateBatches(
    batches: readonly TextTranslationItem[][],
    context: TextTranslationContext,
    maxOutputTokens: number | undefined,
    total: number,
  ): Promise<{ batch: readonly TextTranslationItem[]; run: TextBatchRun }[]> {
    const results: { batch: readonly TextTranslationItem[]; run: TextBatchRun }[] = [];
    let completed = 0;
    let translated = 0;
    let failed = 0;
    const workerCount = Math.min(
      batches.length,
      Math.max(1, Math.floor(context.maxConcurrentBatches ?? 1)),
    );
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < batches.length) {
        const index = nextIndex;
        nextIndex += 1;
        const batch = batches[index]!;
        const run = await this.translateBatch(batch, context, maxOutputTokens);
        results[index] = { batch, run };
        completed += batch.length;
        if (run.ok) {
          translated += run.translations.length;
          failed += run.missingIds.length;
        } else {
          failed += batch.length;
        }
        context.onProgress?.({ completed, total, translated, failed });
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

}
