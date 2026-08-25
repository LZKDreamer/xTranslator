// Shared domain types for the translation pipeline.
//
// The pipeline is: build timing "blocks" from the raw ASR caption segments
// (grouping by natural pauses and token budget, and marking blocks that have no
// spoken content), then ask the LLM to translate each block as a coherent line —
// merging fragmented ASR, dropping non-verbal markers (music/applause/…), and
// filling in nothing for silent blocks. Each block keeps its own timeline range.

import type { TranscriptFragment } from "../youtube/youtube-types";

export interface TranslationSourceSegment {
  id: string;
  sourceText: string;
  startMs: number;
  durationMs: number;
  fragments?: TranscriptFragment[];
}

/** A group of consecutive ASR segments sent to the LLM as one translation unit. */
export interface TranslationBlockInput {
  id: string;
  segmentIds: string[];
  startMs: number;
  endMs: number;
  sourceText: string;
  isSilent: boolean;
}

/** A translated block, ready to display along the timeline. */
export interface TranslatedBlock {
  id: string;
  segmentIds: string[];
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
}

/** A single `{ id, text }` mapping parsed out of a block-level LLM reply. */
export interface BlockTranslation {
  id: string;
  translatedText: string;
}

/**
 * One unit of free text to translate (a comment, a reply, or a page selection).
 * Unlike caption blocks there is no timeline; `contextBefore`/`contextAfter` are
 * only present for selections so the LLM can disambiguate the marked text without
 * echoing the context back in the result.
 */
export interface TextTranslationItem {
  id: string;
  sourceText: string;
  contextBefore?: string;
  contextAfter?: string;
}

/** Validator output: which blocks were matched and which were not. */
export interface ValidatedBlockTranslation {
  matched: BlockTranslation[];
  missingIds: string[];
}

/** The per-video cache record stored in IndexedDB. */
export interface VideoTranslationCacheEntry {
  key: string;
  videoId: string;
  videoTitle: string;
  sourceTrackFingerprint: string;
  sourceLanguage: string;
  targetLanguage: string;
  promptVersion: string;
  blocks: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}
