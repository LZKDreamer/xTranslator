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
import { PROMPT_OVERHEAD_TOKENS } from "../shared/translation/chunker";
import { computeInputTokenBudget } from "../shared/translation/chunker";
import {
  batchTranslationBlocks,
  buildTranslationBlocks,
  cleanTranslatedCaptionText,
} from "../shared/translation/block-builder";
import { TranslationResultValidator } from "../shared/translation/result-validator";
import type {
  BlockTranslation,
  TranslatedBlock,
  TranslationBlockInput,
  VideoTranslationCacheEntry,
} from "../shared/translation/translation-types";
import type { ProviderAdapter, ProviderPreset } from "../shared/providers/provider-types";
import { userFacingProviderMessage } from "../shared/providers/provider-messages";
import {
  buildVideoCacheKey,
  type VideoTranslationCache,
} from "../shared/storage/video-translation-cache";
import { shouldTranslateText } from "../shared/locale/translation-needed";

const MAX_TRANSLATION_ATTEMPTS = 2;
const DEFAULT_TEMPERATURE = 0.1;

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

  public async translate(request: TranslateVideoMessage, context: TranslationRunContext): Promise<TranslateVideoResponse> {
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
      context.adapter.preset.contextWindowTokens,
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
        description: request.videoDescription,
      }, persistProgress);
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
          `${missingIds.length} 段字幕没有获得有效译文，已保存已完成部分，请重试。`,
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
  ): Promise<BlockBatchResult> {
    const contextWindow = context.adapter.preset.contextWindowTokens;
    const batches = batchTranslationBlocks(blocks, contextWindow);
    const requestedOutputTokens = Math.max(512, computeInputTokenBudget(contextWindow) + PROMPT_OVERHEAD_TOKENS);
    const maxOutputTokens = context.adapter.preset.maxOutputTokens === undefined
      ? requestedOutputTokens
      : Math.min(requestedOutputTokens, context.adapter.preset.maxOutputTokens);

    const result: TranslatedBlock[] = [];
    const missingIds: string[] = [];

    for (const batch of batches) {
      const run = await this.translateBatchWithRetry(batch, context, maxOutputTokens, promptContext);
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
        const recovery = await this.translateBatchWithRetry(missingBlocks, context, maxOutputTokens, promptContext);
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

  private async translateBatchWithRetry(
    batch: readonly TranslationBlockInput[],
    context: TranslationRunContext,
    maxOutputTokens: number,
    promptContext: VideoPromptContext,
  ): Promise<BlockBatchResult> {
    const remaining = [...batch];
    const blocksById = new Map<string, TranslationBlockInput>();
    for (const block of remaining) {
      blocksById.set(block.id, block);
    }

    const result: TranslatedBlock[] = [];

    for (let attempt = 0; attempt < MAX_TRANSLATION_ATTEMPTS && remaining.length > 0; attempt += 1) {
      const call = await this.callAdapter(remaining, context, maxOutputTokens, promptContext);
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
    maxOutputTokens: number,
    promptContext: VideoPromptContext,
  ): Promise<CallResult> {
    const completion = await context.adapter.complete(
      {
        systemPrompt: buildSystemPrompt(context.sourceLanguage, context.targetLanguage),
        userPrompt: buildUserPrompt(batch, promptContext),
      },
      {
        model: context.model,
        apiKey: context.apiKey,
        maxOutputTokens,
        temperature: DEFAULT_TEMPERATURE,
      },
    );

    if (!completion.ok) {
      return { translations: [], missingIds: [], abortedMessage: userFacingProviderMessage(completion.error.reason) };
    }

    const validated = this.validator.validate(batch, completion.text);
    const blocksById = new Map(batch.map((block) => [block.id, block]));
    const translations = validated.matched.flatMap((item) => {
      const block = blocksById.get(item.id);
      const translatedText = cleanTranslatedCaptionText(item.translatedText, context.targetLanguage);
      // A punctuation-only reply is not a valid translation for spoken text.
      // Leave it missing so the existing per-block recovery request can retry it.
      if (block && !block.isSilent && !translatedText) {
        return [];
      }
      return [{ id: item.id, translatedText }];
    });
    const matchedIds = new Set(translations.map((item) => item.id));
    const missingIds = batch.filter((block) => !matchedIds.has(block.id)).map((block) => block.id);
    return { translations, missingIds };
  }
}
