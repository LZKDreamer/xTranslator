import { YouTubeTranscriptParser, createCaptionTrackFingerprint } from "./transcript-parser";
import type { CaptionLoadResult, YouTubeCaptionTrack } from "./youtube-types";

export interface CaptionResponse {
  ok: boolean;
  text(): Promise<string>;
}

export type CaptionFetcher = (url: string) => Promise<CaptionResponse>;

export class YouTubeTranscriptLoader {
  public constructor(
    private readonly fetchCaption: CaptionFetcher,
    private readonly parser = new YouTubeTranscriptParser(),
  ) {}

  public async load(track: YouTubeCaptionTrack): Promise<CaptionLoadResult> {
    let response: CaptionResponse;
    try {
      response = await this.fetchCaption(track.baseUrl);
    } catch {
      return { status: "error", reason: "network", canRetry: true };
    }

    if (!response.ok) {
      return { status: "error", reason: "http", canRetry: true };
    }

    try {
      const segments = this.parser.parse(createCaptionTrackFingerprint(track), await response.text());
      return segments
        ? { status: "ready", segments }
        : { status: "error", reason: "unsupported-format", canRetry: true };
    } catch {
      return { status: "error", reason: "unsupported-format", canRetry: true };
    }
  }
}
