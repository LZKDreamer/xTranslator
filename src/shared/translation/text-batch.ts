// Token-budgeted batching for free-text translation items.
//
// Comments and selections have no timeline, so we only group by token budget
// (each batch stays inside the provider context window) and preserve input order.
// Items are never split — an item either fits in a batch or starts a new one.

import { computeInputTokenBudget, estimatedTokensForSourceText, PER_BLOCK_OVERHEAD_TOKENS } from "./chunker";
import type { TextTranslationItem } from "./translation-types";

const MIN_BATCH_ITEMS = 1;

export function batchTextItems(
  items: readonly TextTranslationItem[],
  contextWindowTokens: number,
): TextTranslationItem[][] {
  const budget = computeInputTokenBudget(contextWindowTokens);
  const batches: TextTranslationItem[][] = [];

  let current: TextTranslationItem[] = [];
  let currentTokens = 0;

  for (const item of items) {
    // Context tokens only matter when present; the marked text is always counted.
    const tokens =
      estimatedTokensForSourceText(item.sourceText, PER_BLOCK_OVERHEAD_TOKENS) +
      estimatedTokensForSourceText(item.contextBefore ?? "", 0) +
      estimatedTokensForSourceText(item.contextAfter ?? "", 0);

    if (current.length >= MIN_BATCH_ITEMS && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(item);
    currentTokens += tokens;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}
