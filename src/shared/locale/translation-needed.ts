import { normalizeLanguageTag } from "../contracts/settings";

function languageOf(value: string): string | null {
  const normalized = normalizeLanguageTag(value);
  if (!normalized) {
    return null;
  }

  try {
    return new Intl.Locale(normalized).language;
  } catch {
    return null;
  }
}

/**
 * Chinese script variants are intentionally treated as the same target
 * language. The extension should not send Simplified Chinese to a model just
 * because the source track is Traditional Chinese (or vice versa).
 */
export function languagesAreEquivalent(sourceLanguage: string, targetLanguage: string): boolean {
  const source = languageOf(sourceLanguage);
  const target = languageOf(targetLanguage);
  return source !== null && target !== null && source === target;
}

function isLikelyChineseText(value: string): boolean {
  const text = value.trim();
  if (!text || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) {
    return false;
  }

  // Han characters are shared with Japanese, so require at least one Han
  // character and no Japanese/Korean writing system before treating a free-text
  // item as Chinese. URLs, emoji, numbers and Latin words may still appear in a
  // Chinese comment and do not invalidate the signal.
  return /\p{Script=Han}/u.test(text);
}

export function shouldTranslateText(
  sourceText: string,
  targetLanguage: string,
  sourceLanguage?: string,
): boolean {
  if (sourceLanguage && languagesAreEquivalent(sourceLanguage, targetLanguage)) {
    return false;
  }

  // Free-text items such as comments do not carry a reliable source locale. A
  // Chinese target is the one case we can identify safely from the text itself,
  // and both Simplified and Traditional Han text are already readable in that
  // target family.
  return !(languageOf(targetLanguage) === "zh" && isLikelyChineseText(sourceText));
}

