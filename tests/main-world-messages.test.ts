import { describe, expect, it } from "vitest";
import {
  bridgeTrackFromCaptionTrack,
  isPlayerResponseReadyMessage,
  isRequestPlayerResponseMessage,
  isRequestTranscriptMessage,
  isTranscriptErrorMessage,
  isTranscriptReadyMessage,
  type RequestTranscriptMessage,
  type RequestPlayerResponseMessage,
  type PlayerResponseReadyMessage,
  type TranscriptErrorMessage,
  type TranscriptReadyMessage,
} from "../src/shared/youtube/main-world-messages";
import type { YouTubeCaptionTrack } from "../src/shared/youtube/youtube-types";

const track: YouTubeCaptionTrack = {
  baseUrl: "https://www.youtube.com/api/timedtext?v=8vvWTz6N7Qg&key=yt8&kind=asr&lang=en",
  vssId: "a.en",
  languageCode: "en",
  kind: "asr",
  isTranslatable: true,
  name: "English (auto-generated)",
};

describe("main-world bridge message contract", () => {
  it("maps a caption track to the bridge track descriptor", () => {
    expect(bridgeTrackFromCaptionTrack(track)).toEqual({
      baseUrl: track.baseUrl,
      vssId: "a.en",
      languageCode: "en",
      kind: "asr",
      isTranslatable: true,
    });
  });

  it("accepts a well-formed transcript request from the content script", () => {
    const message: RequestTranscriptMessage = {
      source: "xtranslator-content",
      type: "request-transcript",
      requestId: "xt-1",
      videoId: "8vvWTz6N7Qg",
      track: bridgeTrackFromCaptionTrack(track),
    };
    expect(isRequestTranscriptMessage(message)).toBe(true);
  });

  it("rejects requests with a missing/invalid track", () => {
    const message = {
      source: "xtranslator-content",
      type: "request-transcript",
      requestId: "xt-1",
      videoId: "8vvWTz6N7Qg",
      track: { baseUrl: "", vssId: "a.en", languageCode: "en" },
    };
    expect(isRequestTranscriptMessage(message)).toBe(false);
  });

  it("accepts a player-response request and its bridge reply", () => {
    const request: RequestPlayerResponseMessage = {
      source: "xtranslator-content",
      type: "request-player-response",
      requestId: "xt-player-1",
    };
    expect(isRequestPlayerResponseMessage(request)).toBe(true);
    expect(isRequestPlayerResponseMessage({ ...request, requestId: "" })).toBe(false);

    const ready: PlayerResponseReadyMessage = {
      source: "xtranslator-main-world",
      type: "player-response-ready",
      requestId: request.requestId,
      response: { videoDetails: { videoId: "fixture-video-id" } },
    };
    expect(isPlayerResponseReadyMessage(ready)).toBe(true);
    expect(isPlayerResponseReadyMessage({ ...ready, response: undefined })).toBe(true);
  });

  it("validates the transcript body that is relayed back", () => {
    const ok: TranscriptReadyMessage = {
      source: "xtranslator-main-world",
      type: "transcript-ready",
      requestId: "xt-1",
      body: "<transcript><text start=\"0\" dur=\"1\">hello</text></transcript>",
    };
    expect(isTranscriptReadyMessage(ok)).toBe(true);
    expect(isTranscriptReadyMessage({ ...ok, body: "" })).toBe(true);

    const err: TranscriptErrorMessage = {
      source: "xtranslator-main-world",
      type: "transcript-error",
      requestId: "xt-1",
      reason: "no-caption-fetch",
    };
    expect(isTranscriptErrorMessage(err)).toBe(true);
    expect(isTranscriptErrorMessage({ ...err, reason: "something-else" })).toBe(false);
  });
});
