// Token-budgeted batching for free-text translation items.
//
// Comments and selections have no timeline, so we only group by token budget
// (each batch stays inside the provider context window) and preserve input order.
// Items are never split — an item either fits in a batch or starts a new one.

import { batchItemsByTokenBudget, computeInputTokenBudget, estimatedTokensForSourceText, PER_BLOCK_OVERHEAD_TOKENS } from "./chunker";
import type { TextTranslationItem } from "./translation-types";

export interface TextBatchOptions {
  /** Tokens consumed by request-level context, such as a video title. */
  inputContextTokens?: number;
  /** Keep estimated translation output below the provider's requested limit. */
  maxOutputTokens?: number;
}

export function batchTextItems(
  items: readonly TextTranslationItem[],
  contextWindowTokens: number,
  options: TextBatchOptions = {},
): TextTranslationItem[][] {
  const inputBudget = Math.max(1, computeInputTokenBudget(contextWindowTokens) - (options.inputContextTokens ?? 0));
  // Translation normally stays near the source-token count with the conservative
  // estimator. Reserve a further 2x margin so a large batch cannot exceed the
  // output cap even when the target language expands substantially.
  const outputBudget = options.maxOutputTokens === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(options.maxOutputTokens / 2));
  const budget = Math.min(inputBudget, outputBudget);
  return batchItemsByTokenBudget(items, budget, (item) => {
    // Context tokens only matter when present; the marked text is always counted.
    return (
      estimatedTokensForSourceText(item.sourceText, PER_BLOCK_OVERHEAD_TOKENS) +
      estimatedTokensForSourceText(item.contextBefore ?? "", 0) +
      estimatedTokensForSourceText(item.contextAfter ?? "", 0)
    );
  });
}
