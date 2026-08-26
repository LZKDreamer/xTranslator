// Isolated-world client for the MAIN-world bridge.
//
// Sends a transcript request to the MAIN world bridge and resolves when the bridge
// relays the transcript body the player actually fetched (or rejects with a
// failure reason). All communication happens through a namespaced
// `window.postMessage` channel, so this module only depends on the DOM event
// channel and never on page globals.

import {
  bridgeTrackFromCaptionTrack,
  CONTENT_BRIDGE_SOURCE,
  isPlayerResponseReadyMessage,
  isTranscriptErrorMessage,
  isTranscriptReadyMessage,
} from "../shared/youtube/main-world-messages";
import type { YouTubeCaptionTrack } from "../shared/youtube/youtube-types";

const REQUEST_TIMEOUT_MS = 15_000;

interface PendingRequest {
  resolve: (body: string) => void;
  reject: (reason: string) => void;
  timer: number;
}

const pending = new Map<string, PendingRequest>();
const pendingPlayerResponses = new Map<string, { resolve: (response: unknown) => void; timer: number }>();
let nextRequestId = 0;

export function requestTranscriptBody(videoId: string, track: YouTubeCaptionTrack): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = `xt-${nextRequestId += 1}`;
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject("timeout");
    }, REQUEST_TIMEOUT_MS);

    pending.set(requestId, { resolve, reject, timer });

    window.postMessage(
      {
        source: CONTENT_BRIDGE_SOURCE,
        type: "request-transcript",
        requestId,
        videoId,
        track: bridgeTrackFromCaptionTrack(track),
      },
      window.location.origin,
    );
  });
}

export function requestPlayerResponse(videoId: string): Promise<unknown> {
  return new Promise((resolve) => {
    const requestId = `xt-player-${nextRequestId += 1}`;
    const timer = window.setTimeout(() => {
      pendingPlayerResponses.delete(requestId);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);
    pendingPlayerResponses.set(requestId, { resolve, timer });
    window.postMessage(
      { source: CONTENT_BRIDGE_SOURCE, type: "request-player-response", requestId, videoId },
      window.location.origin,
    );
  });
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (isPlayerResponseReadyMessage(message)) {
    const entry = pendingPlayerResponses.get(message.requestId);
    if (entry) {
      pendingPlayerResponses.delete(message.requestId);
      window.clearTimeout(entry.timer);
      entry.resolve(message.response);
    }
    return;
  }
  if (isTranscriptReadyMessage(message)) {
    const entry = pending.get(message.requestId);
    if (entry) {
      pending.delete(message.requestId);
      window.clearTimeout(entry.timer);
      entry.resolve(message.body);
    }
    return;
  }

  if (isTranscriptErrorMessage(message)) {
    const entry = pending.get(message.requestId);
    if (entry) {
      pending.delete(message.requestId);
      window.clearTimeout(entry.timer);
      entry.reject(message.reason);
    }
  }
});
