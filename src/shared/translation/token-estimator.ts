// Lightweight token estimator for chunking.
//
// We do not depend on a tokenizer library. This is a conservative heuristic that
// over-estimates on ambiguous input (Latin ~4 chars/token, dense-script ~1 char/token)
// so that a batch never silently exceeds the provider's context window. It is
// unit-tested so a change to the heuristic stays deliberate.

function isDenseScript(codePoint: number): boolean {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x2eff) || // CJK radicals and symbols
    (codePoint >= 0x3000 && codePoint <= 0x30ff) || // Japanese punctuation, hiragana, katakana
    (codePoint >= 0x3400 && codePoint <= 0x9fff) || // CJK unified ideographs
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xff00 && codePoint <= 0xffef) // full-width forms
  );
}

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    tokens += isDenseScript(codePoint) ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}
