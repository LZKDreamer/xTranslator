// Token-budget helpers for the translation pipeline.
//
// Blocks (translation units) are kept whole — never split mid-block — and a batch
// is a contiguous run of blocks whose combined estimated source tokens fit a
// per-batch budget. The budget accounts for the prompt's fixed overhead and
// reserves output room, so the input we ask the model to translate in one request
// stays well within its context window.

import { estimateTokens } from "./token-estimator";

export const PROMPT_OVERHEAD_TOKENS = 600;
export const PER_SEGMENT_OVERHEAD_TOKENS = 12;
export const PER_BLOCK_OVERHEAD_TOKENS = 16;

/** Input-token budget that still leaves room for prompt overhead and the reply. */
export function computeInputTokenBudget(contextWindowTokens: number): number {
  const usable = Math.max(0, contextWindowTokens - PROMPT_OVERHEAD_TOKENS);
  return Math.max(1, Math.floor(usable / 2));
}

export function estimatedTokensForSourceText(text: string, perItemOverhead: number): number {
  return estimateTokens(text) + perItemOverhead;
}
