// Lightweight token estimator for chunking.
//
// We do not depend on a tokenizer library. This is a conservative heuristic that
// over-estimates on ambiguous input (English ~4 chars/token, CJK ~1 char/token)
// so that a batch never silently exceeds the provider's context window. It is
// unit-tested so a change to the heuristic stays deliberate.

const CJK_START = 0x3400;
const CJK_END = 0x9fff;

function isCjk(codePoint: number): boolean {
  return (codePoint >= CJK_START && codePoint <= CJK_END) || (codePoint >= 0x2e80 && codePoint <= 0x2eff);
}

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    tokens += isCjk(codePoint) ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}
