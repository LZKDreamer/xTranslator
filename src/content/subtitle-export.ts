import type { YouTubeCaptionTrack, YouTubeVideoSnapshot } from "../shared/youtube/youtube-types";
import type { TranslatedBlock } from "../shared/translation/translation-types";

const DOWNLOAD_GAP_MS = 150;
let downloadQueue = Promise.resolve();

interface SubtitleExportInput {
  snapshot: YouTubeVideoSnapshot;
  track: YouTubeCaptionTrack;
  rawBody?: string;
  blocks: readonly TranslatedBlock[];
  targetLanguage: string;
}

function safeFilePart(value: string, fallback: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "_").slice(0, 80) || fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function downloadJson(text: string, filename: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.hidden = true;
  (document.body ?? document.documentElement).append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
}

export function downloadSubtitleFiles(input: SubtitleExportInput): void {
  const videoId = safeFilePart(input.snapshot.videoId, "video");
  const sourceLanguage = safeFilePart(input.track.languageCode, "und");
  const targetLanguage = safeFilePart(input.targetLanguage, "target");
  const nativeFilename = `${videoId}__native__${sourceLanguage}__json3.json`;
  const translationFilename = `${videoId}__translated__${sourceLanguage}-to-${targetLanguage}.json`;
  const translationPayload = {
    format: "xtranslator-translation-v1",
    exportedAt: new Date().toISOString(),
    videoId: input.snapshot.videoId,
    videoTitle: input.snapshot.title,
    sourceLanguage: input.track.languageCode,
    sourceTrackFingerprint: `${input.track.vssId}\u0000${input.track.languageCode}\u0000${input.track.kind ?? ""}`,
    targetLanguage: input.targetLanguage,
    blocks: input.blocks,
  };

  downloadQueue = downloadQueue
    .then(async () => {
      if (input.rawBody?.trim()) {
        downloadJson(input.rawBody, nativeFilename);
        await wait(DOWNLOAD_GAP_MS);
      }
      downloadJson(JSON.stringify(translationPayload, null, 2), translationFilename);
    })
    .catch(() => undefined);
}
