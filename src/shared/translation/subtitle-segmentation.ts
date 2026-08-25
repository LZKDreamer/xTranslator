import type { TranslationSourceSegment } from "./translation-types";

const CAPTION_MARKER_WORDS = /^(?:music|song|applause|laugh(?:s|ter)?|laughter|sigh(?:s|ing)?|cry(?:ing)?|breath(?:ing)?|noise|sound effects?|inaudible|indistinct|unintelligible|speaking (?:foreign )?language|cheering|crowd|clapping|door|phone ringing|snorts?|cough(?:s|ing)?|sneez(?:e|ing)|musik|música|musica|musique|tepuk tangan|lonceng|musik bermain|音楽|拍手|笑い|咳払い|咳|鈴|鐘|音效|音乐|掌声|笑声|叹气|哭声|呼吸声|噪音|听不清|无法辨认|음악|박수|웃음|기침|숨소리)(?:\s+(?:playing|plays|sounds?|only|continues|再生中|중))?$/iu;
const CAPTION_MARKER_SYMBOLS = /^(?:[♪♫]+|[-–—_*]+)$/u;
const SPEAKER_PREFIX = /^\s*>>\s*/gmu;
const SENTENCE_BOUNDARY = /[.!?。！？…]+["'”’」』）)\]}]*/gu;
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function isCaptionMarker(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 || CAPTION_MARKER_SYMBOLS.test(normalized) || CAPTION_MARKER_WORDS.test(normalized);
}

/** Remove caption-only annotations without deleting ordinary spoken parentheses. */
export function cleanCaptionText(text: string): string {
  const normalized = text
    .replace(/\r\n?|[\u2028\u2029]/gu, " ")
    .replace(/\u200B|\uFEFF/gu, "")
    .replace(SPEAKER_PREFIX, " ")
    .replace(/♪|♫/gu, " ")
    .replace(/\[([^\]]*)\]/gu, (_match, inner: string) => (isCaptionMarker(inner) ? " " : ` ${inner} `))
    .replace(/\(([^()]*)\)/gu, (_match, inner: string) => (isCaptionMarker(inner) ? " " : ` (${inner}) `))
    .replace(/\{([^{}]*)\}/gu, (_match, inner: string) => {
      const value = inner.trim();
      return value.startsWith("\\") || isCaptionMarker(value) ? " " : ` ${value} `;
    })
    .replace(/\s+/gu, " ")
    .trim();

  // Some JSON3 tracks emit a non-verbal cue without brackets (for example
  // "musik"), so do not send a standalone localized marker to the LLM as speech.
  if (isCaptionMarker(normalized)) {
    return "";
  }

  // A caption containing only punctuation or symbols is not spoken content.
  // Dropping it here prevents standalone "..." / music-note cues from becoming
  // visible blocks while keeping punctuation attached to real speech intact.
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : "";
}

/** True if the caption contains spoken letters or numbers after cleaning. */
export function containsSpokenContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(cleanCaptionText(text));
}

/**
 * Normalize model output for on-screen subtitles. Keep natural punctuation
 * because it carries sentence boundaries, pauses, questions and tone. The
 * model prompt handles decorative caption markers; this function only applies
 * the shared text cleanup and preserves meaningful spaces.
 */
export function cleanTranslatedCaptionText(text: string, _targetLanguage = ""): string {
  return cleanCaptionText(text);
}

function hasSentenceBoundary(text: string, matchEnd: number, matchText: string): boolean {
  if (matchEnd >= text.length) {
    return true;
  }

  // A decimal point or an abbreviation such as "v1.2" is not a sentence end.
  if (matchText.includes(".") && !/[!?。！？…]/u.test(matchText)) {
    const before = text[matchEnd - 1] ?? "";
    const after = text[matchEnd] ?? "";
    if (/\d/u.test(before) && /\d/u.test(after)) {
      return false;
    }
  }

  if (/\s/u.test(text[matchEnd] ?? "")) {
    return true;
  }

  const next = text.slice(matchEnd).trimStart().slice(0, 1);
  return /[!?。！？…]/u.test(matchText) || CJK_CHARACTER.test(next);
}

interface TextPart {
  text: string;
  startOffset: number;
  endOffset: number;
}

function splitAtSentenceBoundaries(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  SENTENCE_BOUNDARY.lastIndex = 0;

  for (const match of text.matchAll(SENTENCE_BOUNDARY)) {
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;
    if (!hasSentenceBoundary(text, matchEnd, match[0])) {
      continue;
    }

    const part = text.slice(cursor, matchEnd).trim();
    if (part) {
      parts.push({ text: part, startOffset: cursor, endOffset: matchEnd });
    }
    cursor = matchEnd;
  }

  const tail = text.slice(cursor).trim();
  if (tail) {
    parts.push({ text: tail, startOffset: cursor, endOffset: text.length });
  }

  return parts.length > 1 ? parts : [{ text: text.trim(), startOffset: 0, endOffset: text.length }];
}

interface FragmentRange {
  startChar: number;
  endChar: number;
  startOffsetMs: number;
  endOffsetMs: number;
}

function createFragmentRanges(segment: TranslationSourceSegment, rawText: string): FragmentRange[] {
  if (!segment.fragments || segment.fragments.length === 0) {
    return [];
  }

  const ranges: FragmentRange[] = [];
  let charOffset = 0;
  let previousOffsetMs = 0;
  const durationMs = Math.max(1, segment.durationMs);

  for (let index = 0; index < segment.fragments.length; index += 1) {
    const fragment = segment.fragments[index]!;
    if (!fragment.text) {
      continue;
    }

    const startOffsetMs = Math.min(durationMs, Math.max(previousOffsetMs, fragment.offsetMs ?? previousOffsetMs));
    const nextFragment = segment.fragments.slice(index + 1).find((candidate) => candidate.text && candidate.offsetMs !== undefined);
    const endOffsetMs = Math.min(
      durationMs,
      Math.max(startOffsetMs, nextFragment?.offsetMs ?? durationMs),
    );
    const endChar = charOffset + fragment.text.length;
    ranges.push({ startChar: charOffset, endChar, startOffsetMs, endOffsetMs });
    charOffset = endChar;
    previousOffsetMs = startOffsetMs;
  }

  return charOffset === rawText.length ? ranges : [];
}

function timeAtOffset(
  segment: TranslationSourceSegment,
  rawText: string,
  fragmentRanges: readonly FragmentRange[],
  offset: number,
): number {
  const durationMs = Math.max(1, segment.durationMs);
  if (fragmentRanges.length === 0) {
    return segment.startMs + Math.round((durationMs * offset) / Math.max(1, rawText.length));
  }

  const range = fragmentRanges.find((candidate) => offset <= candidate.endChar) ?? fragmentRanges[fragmentRanges.length - 1]!;
  const width = Math.max(1, range.endChar - range.startChar);
  const ratio = Math.min(1, Math.max(0, (offset - range.startChar) / width));
  return segment.startMs + Math.round(range.startOffsetMs + (range.endOffsetMs - range.startOffsetMs) * ratio);
}

/**
 * Split an event that contains multiple sentences before translation-block
 * grouping. Fragment offsets are used when available; otherwise the original
 * event duration is divided according to the sentence text length.
 */
export function splitCaptionSegment(segment: TranslationSourceSegment): TranslationSourceSegment[] {
  const rawText = segment.fragments?.length
    ? segment.fragments.map((fragment) => fragment.text).join("")
    : segment.sourceText;
  const parts = splitAtSentenceBoundaries(rawText);
  if (parts.length <= 1 || segment.durationMs < parts.length) {
    return [segment];
  }

  const fragmentRanges = createFragmentRanges(segment, rawText);
  const segmentEndMs = segment.startMs + segment.durationMs;
  const result: TranslationSourceSegment[] = [];
  let previousEndMs = segment.startMs;

  for (const [index, part] of parts.entries()) {
    const startMs = index === 0
      ? segment.startMs
      : Math.max(previousEndMs, timeAtOffset(segment, rawText, fragmentRanges, part.startOffset));
    const endMs = index === parts.length - 1
      ? segmentEndMs
      : Math.max(startMs + 1, timeAtOffset(segment, rawText, fragmentRanges, part.endOffset));
    if (endMs > segmentEndMs) {
      return [segment];
    }

    result.push({
      id: `${segment.id}:s${index + 1}`,
      sourceText: part.text,
      startMs,
      durationMs: endMs - startMs,
    });
    previousEndMs = endMs;
  }

  return result;
}
