// Types for the content-script <-> MAIN-world bridge.
//
// Chrome isolates the content script from the page, so the two run in separate JS
// worlds that share only the DOM event channel. We use a namespaced
// `window.postMessage` protocol, carrying explicit types with runtime validation,
// never `any`. The MAIN world script is the only place allowed to inspect page
// globals/player internals; it captures the transcript body the player actually
// fetches (which is guaranteed valid, since it carries the proof-of-origin token
// and the same request context) and relays that raw body back. The isolated content
// script parses it with the shared, validated parser.

import { readCaptionVideoId } from "./caption-request";
import type { YouTubeCaptionTrack } from "./youtube-types";

export const CONTENT_BRIDGE_SOURCE = "xtranslator-content";
export const MAIN_WORLD_BRIDGE_SOURCE = "xtranslator-main-world";

export interface BridgeCaptionTrack {
  baseUrl: string;
  vssId: string;
  languageCode: string;
  kind?: string;
  isTranslatable?: boolean;
}

export interface RequestTranscriptMessage {
  source: typeof CONTENT_BRIDGE_SOURCE;
  type: "request-transcript";
  requestId: string;
  videoId: string;
  track: BridgeCaptionTrack;
}

export type TranscriptFailureReason = "no-caption-fetch";

export interface TranscriptReadyMessage {
  source: typeof MAIN_WORLD_BRIDGE_SOURCE;
  type: "transcript-ready";
  requestId: string;
  body: string;
}

export interface TranscriptErrorMessage {
  source: typeof MAIN_WORLD_BRIDGE_SOURCE;
  type: "transcript-error";
  requestId: string;
  reason: TranscriptFailureReason;
}

export type MainWorldBridgeMessage = TranscriptReadyMessage | TranscriptErrorMessage;
export type ContentBridgeMessage = RequestTranscriptMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBridgeCaptionTrack(value: unknown): value is BridgeCaptionTrack {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.baseUrl === "string" &&
    value.baseUrl.length > 0 &&
    typeof value.vssId === "string" &&
    value.vssId.length > 0 &&
    typeof value.languageCode === "string" &&
    value.languageCode.length > 0
  );
}

export function isRequestTranscriptMessage(value: unknown): value is RequestTranscriptMessage {
  if (!isRecord(value) || value.source !== CONTENT_BRIDGE_SOURCE || value.type !== "request-transcript") {
    return false;
  }
  return (
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.videoId === "string" &&
    value.videoId.length > 0 &&
    isBridgeCaptionTrack(value.track)
  );
}

export function isTranscriptReadyMessage(value: unknown): value is TranscriptReadyMessage {
  if (!isRecord(value) || value.source !== MAIN_WORLD_BRIDGE_SOURCE || value.type !== "transcript-ready") {
    return false;
  }
  return typeof value.requestId === "string" && typeof value.body === "string";
}

export function isTranscriptErrorMessage(value: unknown): value is TranscriptErrorMessage {
  if (!isRecord(value) || value.source !== MAIN_WORLD_BRIDGE_SOURCE || value.type !== "transcript-error") {
    return false;
  }
  return typeof value.requestId === "string" && value.reason === "no-caption-fetch";
}

export function bridgeTrackFromCaptionTrack(track: YouTubeCaptionTrack): BridgeCaptionTrack {
  return {
    baseUrl: track.baseUrl,
    vssId: track.vssId,
    languageCode: track.languageCode,
    ...(track.kind !== undefined ? { kind: track.kind } : {}),
    ...(track.isTranslatable !== undefined ? { isTranslatable: track.isTranslatable } : {}),
  };
}

export function readCaptionVideoIdFromUrl(url: string): string | null {
  return readCaptionVideoId(url);
}
