// Background translation orchestrator.
//
// It owns the LLM interaction and the per-video cache. Given a video's raw ASR
// caption segments it: (1) builds timing "blocks" (merging fragmented ASR, and
// marking silent blocks), (2) serves any already translated blocks from the
// cache, (3) translates the remaining blocks in token-budgeted batches through
// the provider adapter with per-batch retry, and (4) writes progress back to the
// cache so a later visit resumes instead of re-translating. It never logs the API
// key or the request/response body.

import type { TranslateVideoMessage, TranslateVideoResponse } from "../shared/contracts/messages";
import type { CaptionDisplayMode } from "../shared/contracts/settings";
import { buildSystemPrompt, buildUserPrompt, type VideoPromptContext } from "../shared/translation/prompt";
import { PER_BLOCK_OVERHEAD_TOKENS, PROMPT_OVERHEAD_TOKENS } from "../shared/translation/chunker";
import {
  batchTranslationBlocks,
  buildTranslationBlocks,
  cleanTranslatedCaptionText,
} from "../shared/translation/block-builder";
import { estimateTokens } from "../shared/translation/token-estimator";
import { TranslationResultValidator } from "../shared/translation/result-validator";
import type {
  BlockTranslation,
  TranslatedBlock,
  TranslationBlockInput,
  VideoTranslationCacheEntry,
} from "../shared/translation/translation-types";
import type { ProviderAdapter, ProviderPreset } from "../shared/providers/provider-types";
import { getProviderContextWindow, getProviderMaxOutputTokens } from "../shared/providers/provider-registry";
import { userFacingProviderMessage } from "../shared/providers/provider-messages";
import {
  buildVideoCacheKey,
  type VideoTranslationCache,
} from "../shared/storage/video-translation-cache";
import { shouldTranslateText } from "../shared/locale/translation-needed";
import { t } from "../shared/i18n";

const MAX_TRANSLATION_ATTEMPTS = 2;
const DEFAULT_TEMPERATURE = 0.1;
const MIN_OUTPUT_TOKENS = 512;
const OUTPUT_TOKENS_PER_SOURCE_TOKEN = 2.5;
const OUTPUT_TOKENS_PER_BLOCK = 24;

interface CallResult {
  translations: BlockTranslation[];
  missingIds: string[];
  abortedMessage?: string;
}

interface BlockBatchResult {
  blocks: TranslatedBlock[];
  missingIds: string[];
  abortedMessage?: string;
}

type ProgressWriter = (blocks: readonly TranslatedBlock[]) => Promise<void>;
export type BlockProgressWriter = (block: TranslatedBlock) => void;

function toTranslatedBlock(block: TranslationBlockInput, translatedText: string, targetLanguage: string): TranslatedBlock {
  return {
    id: block.id,
    segmentIds: [...block.segmentIds],
    startMs: block.startMs,
    endMs: block.endMs,
    sourceText: block.sourceText,
    translatedText: cleanTranslatedCaptionText(translatedText, targetLanguage),
  };
}

export interface TranslationRunContext {
  sourceLanguage: string;
  targetLanguage: string;
  displayMode: CaptionDisplayMode;
  adapter: ProviderAdapter;
  apiKey: string;
  model: string;
}

export class VideoTranslationService {
  public constructor(
    private readonly cache: VideoTranslationCache,
    private readonly validator = new TranslationResultValidator(),
    private readonly now: () => number = Date.now,
  ) {}

  public async translate(
    request: TranslateVideoMessage,
    context: TranslationRunContext,
    onBlockProgress?: BlockProgressWriter,
  ): Promise<TranslateVideoResponse> {
    if (!shouldTranslateText("", context.targetLanguage, context.sourceLanguage)) {
      return {
        ok: true,
        blocks: [],
        targetLanguage: context.targetLanguage,
        displayMode: context.displayMode,
        fromCache: true,
        missingIds: [],
        skipped: true,
      };
    }

    const inputBlocks = buildTranslationBlocks(
      request.segments,
      getProviderContextWindow(context.adapter.preset, context.model),
      undefined,
      undefined,
      undefined,
      request.sourceLanguage,
    );
    const cacheKey = buildVideoCacheKey({ videoId: request.videoId });

    const existing = await this.cache.get(cacheKey);
    const cacheMatchesRequest = existing !== null &&
      existing.videoId === request.videoId &&
      existing.sourceTrackFingerprint === request.sourceTrackFingerprint &&
      existing.sourceLanguage === request.sourceLanguage &&
      existing.targetLanguage === context.targetLanguage;
    const compatibleCache = cacheMatchesRequest ? existing : null;
    const cachedBlocks = new Map((compatibleCache?.blocks ?? []).map((block) => [block.id, block]));

    const resolved: TranslatedBlock[] = [];
    const pending: TranslationBlockInput[] = [];

    for (const block of inputBlocks) {
      if (block.isSilent) {
        resolved.push(toTranslatedBlock(block, "", context.targetLanguage));
        continue;
      }
      const cachedText = cleanTranslatedCaptionText(cachedBlocks.get(block.id)?.translatedText ?? "", context.targetLanguage);
      if (cachedText) {
        resolved.push(toTranslatedBlock(block, cachedText, context.targetLanguage));
      } else {
        pending.push(block);
      }
    }

    const fromCache = pending.length === 0;
    let missingIds: string[] = [];
    let latestCache: VideoTranslationCacheEntry | null = compatibleCache;
    const persistProgress: ProgressWriter = async (newBlocks) => {
      if (newBlocks.length === 0) {
        return;
      }
      latestCache = await this.writeBlocks(cacheKey, request, context, latestCache, newBlocks);
    };

    if (pending.length > 0) {
      const run = await this.translateBlocks(pending, context, {
        title: request.videoTitle,
      }, persistProgress, onBlockProgress);
      resolved.push(...run.blocks);
      missingIds = pending
        .filter((block) => !run.blocks.some((translated) => translated.id === block.id))
        .map((block) => block.id);
      if (run.abortedMessage) {
        return this.createPartialFailure(
          run.abortedMessage,
          inputBlocks,
          resolved,
          missingIds,
          context,
        );
      }
      if (missingIds.length > 0) {
        return this.createPartialFailure(
          t("translation.missingCaptions", { count: missingIds.length }),
          inputBlocks,
          resolved,
          missingIds,
          context,
        );
      }
    }

    const blocks = this.buildDisplayBlocks(inputBlocks, resolved, context.targetLanguage);
    return {
      ok: true,
      blocks,
      targetLanguage: context.targetLanguage,
      displayMode: context.displayMode,
      fromCache,
      missingIds,
    };
  }

  private buildDisplayBlocks(
    inputBlocks: readonly TranslationBlockInput[],
    resolved: readonly TranslatedBlock[],
    targetLanguage: string,
  ): TranslatedBlock[] {
    const resolvedById = new Map(resolved.map((block) => [block.id, block]));
    return inputBlocks.map((block) => resolvedById.get(block.id) ?? toTranslatedBlock(block, "", targetLanguage));
  }

  private createPartialFailure(
    errorMessage: string,
    inputBlocks: readonly TranslationBlockInput[],
    resolved: readonly TranslatedBlock[],
    missingIds: readonly string[],
    context: TranslationRunContext,
  ): TranslateVideoResponse {
    const blocks = this.buildDisplayBlocks(inputBlocks, resolved, context.targetLanguage);
    const normalizedMissingIds = [...new Set(missingIds)];
    const hasCompletedTranslation = blocks.some((block) => block.translatedText.trim().length > 0);
    return {
      ok: false,
      errorMessage,
      ...(hasCompletedTranslation
        ? {
            partial: {
              blocks,
              targetLanguage: context.targetLanguage,
              displayMode: context.displayMode,
              missingIds: normalizedMissingIds,
            },
          }
        : {}),
    };
  }

  private async writeBlocks(
    cacheKey: string,
    request: TranslateVideoMessage,
    context: TranslationRunContext,
    existing: VideoTranslationCacheEntry | null,
    newBlocks: readonly TranslatedBlock[],
  ): Promise<VideoTranslationCacheEntry> {
    const merged = new Map((existing?.blocks ?? []).map((block) => [block.id, block]));
    for (const block of newBlocks) {
      merged.set(block.id, block);
    }

    const entry: VideoTranslationCacheEntry = {
      key: cacheKey,
      videoId: request.videoId,
      videoTitle: request.videoTitle,
      sourceTrackFingerprint: request.sourceTrackFingerprint,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: context.targetLanguage,
      blocks: [...merged.values()].sort((left, right) => left.startMs - right.startMs),
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };
    await this.cache.put(entry);
    return entry;
  }

  private async translateBlocks(
    blocks: readonly TranslationBlockInput[],
    context: TranslationRunContext,
    promptContext: VideoPromptContext,
    onProgress: ProgressWriter,
    onBlockProgress?: BlockProgressWriter,
  ): Promise<BlockBatchResult> {
    const contextWindow = getProviderContextWindow(context.adapter.preset, context.model);
    const batches = batchTranslationBlocks(blocks, contextWindow);

    const result: TranslatedBlock[] = [];
    const missingIds: string[] = [];

    for (const batch of batches) {
      const maxOutputTokens = this.getMaxOutputTokens(batch, context, promptContext, contextWindow);
      const run = await this.translateBatchWithRetry(batch, context, maxOutputTokens, promptContext, onBlockProgress);
      if (run.abortedMessage) {
        await onProgress(run.blocks);
        return {
          blocks: [...result, ...run.blocks],
          missingIds: [...missingIds, ...run.missingIds],
          abortedMessage: run.abortedMessage,
        };
      }

      result.push(...run.blocks);
      await onProgress(run.blocks);
      if (run.missingIds.length > 0) {
        // A provider may omit one line when a batch is long or its JSONL output
        // is truncated. Retry the missing blocks individually so one malformed
        // line cannot keep an otherwise valid video from translating.
        const missingBlocks = batch.filter((block) => run.missingIds.includes(block.id));
        const recoveryMaxOutputTokens = this.getMaxOutputTokens(missingBlocks, context, promptContext, contextWindow);
        const recovery = await this.translateBatchWithRetry(
          missingBlocks,
          context,
          recoveryMaxOutputTokens,
          promptContext,
          onBlockProgress,
        );
        result.push(...recovery.blocks);
        await onProgress(recovery.blocks);
        missingIds.push(...recovery.missingIds);
        if (recovery.abortedMessage) {
          return {
            blocks: result,
            missingIds: [...missingIds, ...recovery.missingIds],
            abortedMessage: recovery.abortedMessage,
          };
        }
      }
    }

    return { blocks: result, missingIds };
  }

  private getMaxOutputTokens(
    batch: readonly TranslationBlockInput[],
    context: TranslationRunContext,
    promptContext: VideoPromptContext,
    contextWindow: number,
  ): number | undefined {
    const documentedMaxOutputTokens = getProviderMaxOutputTokens(context.adapter.preset, context.model);
    if (documentedMaxOutputTokens === undefined) {
      // The provider's live model catalog does not publish a limit. Omit
      // max_tokens instead of inventing a provider limit.
      return undefined;
    }

    const systemPrompt = buildSystemPrompt(context.sourceLanguage, context.targetLanguage);
    const userPrompt = buildUserPrompt(batch, promptContext);
    const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt) + PROMPT_OVERHEAD_TOKENS;
    const sourceTokens = batch.reduce(
      (total, block) => total + estimateTokens(block.sourceText) + PER_BLOCK_OVERHEAD_TOKENS,
      0,
    );
    const requestedOutputTokens = Math.max(
      MIN_OUTPUT_TOKENS,
      Math.ceil(sourceTokens * OUTPUT_TOKENS_PER_SOURCE_TOKEN + batch.length * OUTPUT_TOKENS_PER_BLOCK),
    );
    const remainingContextTokens = Math.max(1, contextWindow - inputTokens);
    return Math.max(
      1,
      Math.min(requestedOutputTokens, documentedMaxOutputTokens, remainingContextTokens),
    );
  }

  private async translateBatchWithRetry(
    batch: readonly TranslationBlockInput[],
    context: TranslationRunContext,
    maxOutputTokens: number | undefined,
    promptContext: VideoPromptContext,
    onBlockProgress?: BlockProgressWriter,
  ): Promise<BlockBatchResult> {
    const remaining = [...batch];
    const blocksById = new Map<string, TranslationBlockInput>();
    for (const block of remaining) {
      blocksById.set(block.id, block);
    }

    const result: TranslatedBlock[] = [];

    for (let attempt = 0; attempt < MAX_TRANSLATION_ATTEMPTS && remaining.length > 0; attempt += 1) {
      const call = await this.callAdapter(remaining, context, maxOutputTokens, promptContext, onBlockProgress);
      if (call.abortedMessage) {
        return { blocks: result, missingIds: remaining.map((block) => block.id), abortedMessage: call.abortedMessage };
      }

      const matchedById = new Map<string, string>();
      for (const item of call.translations) {
        matchedById.set(item.id, item.translatedText);
      }

      for (const item of call.translations) {
        const block = blocksById.get(item.id);
        if (block) {
          result.push(toTranslatedBlock(block, item.translatedText, context.targetLanguage));
        }
      }

      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        if (matchedById.has(remaining[index]!.id)) {
          remaining.splice(index, 1);
        }
      }
    }

    return { blocks: result, missingIds: remaining.map((block) => block.id) };
  }

  private async callAdapter(
    batch: readonly TranslationBlockInput[],
    context: TranslationRunContext,
    maxOutputTokens: number | undefined,
    promptContext: VideoPromptContext,
    onBlockProgress?: BlockProgressWriter,
  ): Promise<CallResult> {
    const request = {
      systemPrompt: buildSystemPrompt(context.sourceLanguage, context.targetLanguage),
      userPrompt: buildUserPrompt(batch, promptContext),
    };
    const options = {
      model: context.model,
      apiKey: context.apiKey,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      temperature: DEFAULT_TEMPERATURE,
    };
    const streamedIds = new Set<string>();
    let streamBuffer = "";
    const emitLine = (line: string): void => {
      const validated = this.validator.validate(batch, line);
      for (const item of validated.matched) {
        if (streamedIds.has(item.id)) {
          continue;
        }
        const block = batch.find((candidate) => candidate.id === item.id);
        const translatedText = block ? cleanTranslatedCaptionText(item.translatedText, context.targetLanguage) : "";
        if (!block || (!block.isSilent && !translatedText)) {
          continue;
        }
        streamedIds.add(item.id);
        onBlockProgress?.(toTranslatedBlock(block, translatedText, context.targetLanguage));
      }
    };
    const onTextDelta = (delta: string): void => {
      streamBuffer += delta;
      let newlineIndex = streamBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        emitLine(streamBuffer.slice(0, newlineIndex));
        streamBuffer = streamBuffer.slice(newlineIndex + 1);
        newlineIndex = streamBuffer.indexOf("\n");
      }
    };
    const completion = context.adapter.completeStream
      ? await context.adapter.completeStream(request, options, onTextDelta)
      : await context.adapter.complete(request, options);

    if (!completion.ok) {
      return { translations: [], missingIds: [], abortedMessage: userFacingProviderMessage(completion.error.reason) };
    }

    if (streamBuffer.trim()) {
      emitLine(streamBuffer);
    }

    const validated = this.validator.validate(batch, completion.text);
    const blocksById = new Map(batch.map((block) => [block.id, block]));
    const translations = validated.matched.flatMap((item) => {
      const block = blocksById.get(item.id);
      const translatedText = cleanTranslatedCaptionText(item.translatedText, context.targetLanguage);
      // A punctuation-only reply is not a valid translation for spoken text.
      // Leave it missing so the existing per-block recovery request can retry it.
      if (!block || (!block.isSilent && !translatedText)) {
        return [];
      }
      if (!streamedIds.has(item.id)) {
        onBlockProgress?.(toTranslatedBlock(block, translatedText, context.targetLanguage));
      }
      return [{ id: item.id, translatedText }];
    });
    const matchedIds = new Set(translations.map((item) => item.id));
    const missingIds = batch.filter((block) => !matchedIds.has(block.id)).map((block) => block.id);
    return { translations, missingIds };
  }
}
