// Block builder: group raw ASR caption segments into translation units.
//
// YouTube's ASR is fragmented into short, often incomplete lines and sometimes
// carries non-verbal markers (music / applause / …). Rather than translate one
// line at a time (which reproduces the fragmentation), we group consecutive
// segments that belong together into a "block" and let the LLM translate the
// block as one coherent line, merging fragments and dropping the non-verbal
// markers. Blocks keep their own timeline range so the result can be shown at the
// right time.
//
// A block is a *readable* subtitle unit, not a whole paragraph: it is bounded by
// the caption width, so long runs of continuous speech are split into several
// short blocks (each shown for its own time range) instead of one wall of text
// that fills the screen. Blocks break at large timeline gaps, when the token
// budget is exceeded, and — once a block is long enough — preferably right after
// a sentence boundary so a line rarely ends mid-sentence.
//
// Blocks whose text contains no spoken content (only markers) are flagged
// `isSilent` and are never sent to the LLM, so no caption is fabricated.

import {
  computeInputTokenBudget,
  PER_BLOCK_OVERHEAD_TOKENS,
} from "./chunker";
import { estimateTokens } from "./token-estimator";
import { cleanCaptionText, containsSpokenContent, splitCaptionSegment } from "./subtitle-segmentation";
import type { TranslationBlockInput, TranslationSourceSegment } from "./translation-types";

const DEFAULT_GAP_MS = 500;
const MAX_BLOCK_DURATION_MS = 6_000;

// A block should fit into a compact two-line subtitle. The token estimate is
// language-aware (CJK ≈ 1 token/char, Latin ≈ 1/4 token/char), so the larger
// budget keeps a natural unfinished sentence together instead of making the
// LLM complete it across two separately timed blocks.
const PREFERRED_BLOCK_SOURCE_TOKENS = 36;
const MAX_BLOCK_SOURCE_TOKENS = 48;

const SENTENCE_TERMINATOR = /[.!?。！？…]/u;
const CLAUSE_TERMINATOR = /[,;:，；：、]$/u;
const SPEAKER_MARKER = /^\s*>>\s*/u;
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NO_SPACE_BEFORE = /^[,.:;!?，。！？；：、】【〕〉》”’]/u;
const NO_SPACE_AFTER = /[（【〔〈《“‘]$/u;
const PUNCTUATION_ONLY = /^[\s.,!?;:，。！？；：、…'"“”‘’「」『』]+$/u;

export { cleanCaptionText, cleanTranslatedCaptionText, containsSpokenContent } from "./subtitle-segmentation";

function isStandaloneNonVerbalMarker(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || (!PUNCTUATION_ONLY.test(trimmed) && cleanCaptionText(trimmed).length === 0);
}

function stableBlockId(segmentIds: readonly string[], sourceText: string): string {
  let hash = 2166136261;
  const parts = [...segmentIds, sourceText];
  for (const part of parts) {
    for (const character of part) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    hash = Math.imul(hash, 16777619);
  }
  return `blk-${(hash >>> 0).toString(36)}`;
}

/** True when the accumulated text already ends at a complete sentence. */
function endsAtSentenceBoundary(text: string): boolean {
  const last = text.trim().slice(-1);
  return last.length > 0 && SENTENCE_TERMINATOR.test(last);
}

/** Preserve natural word spacing while not inserting spaces inside CJK text or before punctuation. */
function appendCaptionText(current: string, next: string): string {
  if (!current) {
    return next;
  }
  const previousCharacter = current.trim().slice(-1);
  const nextCharacter = next.trim().slice(0, 1);
  const needsSpace =
    previousCharacter.length > 0 &&
    nextCharacter.length > 0 &&
    !NO_SPACE_BEFORE.test(nextCharacter) &&
    !NO_SPACE_AFTER.test(previousCharacter) &&
    !(CJK_CHARACTER.test(previousCharacter) && CJK_CHARACTER.test(nextCharacter));
  return `${current}${needsSpace ? " " : ""}${next}`;
}

export function buildTranslationBlocks(
  segments: readonly TranslationSourceSegment[],
  contextWindowTokens: number,
  gapMs = DEFAULT_GAP_MS,
  preferredBlockSourceTokens = PREFERRED_BLOCK_SOURCE_TOKENS,
  maxBlockSourceTokens = MAX_BLOCK_SOURCE_TOKENS,
): TranslationBlockInput[] {
  const budget = computeInputTokenBudget(contextWindowTokens);

  const blocks: TranslationBlockInput[] = [];
  let currentRawText = "";
  let currentSegmentIds: string[] = [];
  let currentStartMs = 0;
  let currentEndMs = 0;
  let currentTokens = 0;
  let currentHasSpeech = false;

  const flush = (boundaryStartMs?: number): void => {
    if (currentSegmentIds.length === 0) {
      return;
    }
    const rawSourceText = currentRawText.trim();
    const sourceText = cleanCaptionText(rawSourceText);
    const boundedEndMs =
      boundaryStartMs !== undefined && boundaryStartMs >= currentStartMs
        ? Math.min(currentEndMs, boundaryStartMs)
        : currentEndMs;
    blocks.push({
      id: stableBlockId(currentSegmentIds, rawSourceText),
      segmentIds: [...currentSegmentIds],
      startMs: currentStartMs,
      endMs: Math.max(currentStartMs + 1, boundedEndMs),
      sourceText,
      isSilent: !currentHasSpeech,
    });
    currentRawText = "";
    currentSegmentIds = [];
    currentTokens = 0;
    currentHasSpeech = false;
  };

  const orderedSegments = segments
    .flatMap((segment) => splitCaptionSegment(segment))
    .sort((a, b) => a.startMs - b.startMs || a.durationMs - b.durationMs);
  for (const segment of orderedSegments) {
    const cleanedSegmentText = cleanCaptionText(segment.sourceText);
    const sourceTokens = estimateTokens(cleanedSegmentText);
    const tokens = sourceTokens + PER_BLOCK_OVERHEAD_TOKENS;
    const candidateRawText = appendCaptionText(currentRawText, segment.sourceText);
    const candidateSourceText = cleanCaptionText(candidateRawText);
    const candidateSourceTokens = estimateTokens(candidateSourceText);
    const gap = currentSegmentIds.length > 0 ? segment.startMs - currentEndMs : 0;
    const exceedsBudget = currentSegmentIds.length > 0 && currentTokens + tokens > budget;
    const exceedsGap = currentSegmentIds.length > 0 && gap > gapMs;
    const candidateEndMs = Math.max(currentEndMs, segment.startMs + segment.durationMs);
    const exceedsDuration =
      currentSegmentIds.length > 0 &&
      candidateEndMs - currentStartMs > MAX_BLOCK_DURATION_MS;
    const currentEndsAtClause = CLAUSE_TERMINATOR.test(cleanCaptionText(currentRawText));
    const readableLimit = Math.max(maxBlockSourceTokens, preferredBlockSourceTokens);
    const exceedsReadable =
      currentSegmentIds.length > 0 &&
      candidateSourceTokens > readableLimit &&
      (currentEndsAtClause || candidateSourceTokens > readableLimit + 20);
    const markerOnly = isStandaloneNonVerbalMarker(segment.sourceText);
    const currentHasOnlyMarkers = currentSegmentIds.length > 0 && !currentHasSpeech;
    const speakerBreak = currentSegmentIds.length > 0 && SPEAKER_MARKER.test(segment.sourceText);
    const markerBreak = currentSegmentIds.length > 0 && markerOnly;
    const sentenceBreak =
      currentSegmentIds.length > 0 &&
      currentHasSpeech &&
      endsAtSentenceBoundary(currentRawText) &&
      !markerOnly &&
      !PUNCTUATION_ONLY.test(segment.sourceText.trim());

    if (
      exceedsBudget ||
      exceedsGap ||
      exceedsDuration ||
      exceedsReadable ||
      speakerBreak ||
      markerBreak ||
      currentHasOnlyMarkers ||
      sentenceBreak
    ) {
      flush(segment.startMs);
    }

    if (currentSegmentIds.length === 0) {
      currentStartMs = segment.startMs;
    }
    currentRawText = appendCaptionText(currentRawText, segment.sourceText);
    currentSegmentIds.push(segment.id);
    currentEndMs = Math.max(currentEndMs, segment.startMs + segment.durationMs);
    currentTokens += tokens;
    currentHasSpeech = currentHasSpeech || containsSpokenContent(segment.sourceText);
  }

  flush();
  return blocks;
}

export function batchTranslationBlocks(
  blocks: readonly TranslationBlockInput[],
  contextWindowTokens: number,
): TranslationBlockInput[][] {
  const budget = computeInputTokenBudget(contextWindowTokens);
  const batches: TranslationBlockInput[][] = [];
  let current: TranslationBlockInput[] = [];
  let currentTokens = 0;

  for (const block of blocks) {
    const tokens = estimateTokens(block.sourceText) + PER_BLOCK_OVERHEAD_TOKENS;
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(block);
    currentTokens += tokens;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
