export interface YouTubeCaptionTrack {
  baseUrl: string;
  vssId: string;
  languageCode: string;
  kind?: string;
  isTranslatable?: boolean;
  name: string;
}

export interface YouTubeVideoSnapshot {
  videoId: string;
  title: string;
  author: string;
  lengthSeconds: number;
  shortDescription: string;
  captionTracks: YouTubeCaptionTrack[];
  translationLanguages: Array<{ languageCode: string; name: string }>;
}

export interface TranscriptFragment {
  text: string;
  offsetMs?: number;
}

export interface TranscriptSegment {
  id: string;
  startMs: number;
  durationMs: number;
  sourceText: string;
  fragments?: TranscriptFragment[];
}

export type CaptionLoadFailureReason = "http" | "network" | "unsupported-format";

export type CaptionLoadResult =
  | { status: "ready"; segments: TranscriptSegment[] }
  | { status: "error"; reason: CaptionLoadFailureReason; canRetry: true };

/**
 * A comment that YouTube has actually rendered. Per the page contract this is
 * observed from the DOM — never fetched through a continuation API. A missing
 * `commentId` or `sourceText` means the node is skipped (the adapter logs a
 * non-sensitive diagnostic code rather than guessing).
 */
export interface RenderedComment {
  commentId: string;
  parentCommentId?: string;
  authorName: string;
  sourceText: string;
  replyCount?: number;
  isReply: boolean;
}
