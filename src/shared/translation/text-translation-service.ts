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

const MAX_OUTPUT_FACTOR = 512;
// Free-text requests are small (a viewport of comments or a selection). Do not
// turn a provider's context window into its requested output size: gateways may
// reject an otherwise valid request when max_tokens is hundreds of thousands.
const MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_TEMPERATURE = 0.2;

export interface TextTranslationContext {
  targetLanguage: string;
  adapter: ProviderAdapter;
  apiKey: string;
  model: string;
  /** Keep per-comment responses bound to exactly one source item. */
  singleItemBatches?: boolean;
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

    // A comment's stable DOM id is used to place the response back on screen.
    // Some providers can return a valid id paired with another batch item's
    // text; keep comments to one item per request so that mismatch is impossible.
    const batches = context.singleItemBatches
      ? translatableItems.map((item) => [item])
      : batchTextItems(translatableItems, getProviderContextWindow(context.adapter.preset, context.model));

    const translations: Record<string, string> = {};
    const missingIds: string[] = [];
    const documentedMaxOutputTokens = getProviderMaxOutputTokens(context.adapter.preset, context.model);
    const maxOutputTokens = documentedMaxOutputTokens === undefined
      ? undefined
      : Math.min(
          MAX_OUTPUT_TOKENS,
          documentedMaxOutputTokens,
          Math.max(
            MAX_OUTPUT_FACTOR,
            computeInputTokenBudget(getProviderContextWindow(context.adapter.preset, context.model)) + PROMPT_OVERHEAD_TOKENS,
          ),
        );

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index]!;
      const run = await this.translateBatch(batch, context, maxOutputTokens);
      if (!run.ok) {
        if (!context.singleItemBatches) {
          return run;
        }
        const unprocessedIds = batches.slice(index).flatMap((pendingBatch) => pendingBatch.map((item) => item.id));
        return {
          ok: true,
          translations,
          missingIds: [...new Set([...missingIds, ...unprocessedIds])],
          ...(skippedIds.length > 0 ? { skippedIds } : {}),
          errorMessage: run.errorMessage,
        };
      }
      for (const item of run.translations) {
        translations[item.id] = item.translatedText;
      }
      for (const id of run.missingIds) {
        if (translations[id] === undefined) {
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
  ): Promise<
    | { ok: true; translations: { id: string; translatedText: string }[]; missingIds: string[] }
    | { ok: false; errorMessage: string }
  > {
    const request = {
      systemPrompt: buildTextSystemPrompt(context.targetLanguage),
      userPrompt: buildTextUserPrompt(batch),
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

    const validated = this.validator.validate(batch, completion.text);
    if (!context.singleItemBatches) {
      return { ok: true, translations: validated.matched, missingIds: validated.missingIds };
    }

    const translations = validated.matched.filter((item) => item.translatedText.trim().length > 0);
    const matchedIds = new Set(translations.map((item) => item.id));
    const missingIds = [
      ...new Set([
        ...validated.missingIds,
        ...batch.filter((item) => !matchedIds.has(item.id)).map((item) => item.id),
      ]),
    ];
    return { ok: true, translations, missingIds };
  }
}
