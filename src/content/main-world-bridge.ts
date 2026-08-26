// MAIN-world bridge: the only code that may inspect page globals and the YouTube
// player internals to obtain a transcript.
//
// Why this exists: YouTube's timedtext endpoint returns HTTP 200 with an empty
// body unless the request carries a `pot` token minted by the page's own BotGuard
// runtime and bound to the video ID. That token cannot be reproduced from static
// HTML or a plain HTTP request, and it is not reliably reusable from a *separate*
// request built by the extension (a different baseUrl/signature context). The
// player, however, already mints and sends a valid `pot` every time it fetches a
// caption track, so the robust source of truth is the transcript body the player
// actually retrieves. We (a) passively record that body for any caption request we
// observe, and (b) can force one by telling the player to select a caption track
// (hiding the overlay so nothing flashes). The raw body is relayed back to the
// isolated content script, which parses it with the shared, validated parser.

import { isCaptionRequestUrl, readCaptionVideoId } from "../shared/youtube/caption-request";
import {
  isRequestTranscriptMessage,
  isRequestPlayerResponseMessage,
  MAIN_WORLD_BRIDGE_SOURCE,
  type MainWorldBridgeMessage,
  type TranscriptFailureReason,
} from "../shared/youtube/main-world-messages";
import { YOUTUBE_PAGE_SELECTOR } from "../shared/youtube/youtube-page-contract";

const CAPTION_ACQUISITION_TIMEOUT_MS = 10_000;
const ACQUISITION_POLL_MS = 150;
const CAPTION_TRIGGER_RETRY_MS = 2_500;
const CAPTION_BUTTON_STATE_TIMEOUT_MS = 1_000;
const CAPTION_HIDE_STYLE_ID = "xtranslator-hide-captions";

interface PlayerWithCaptionApi {
  setOption?: (key: string, subKey: string, value: unknown) => void;
  getOption?: (key: string, subKey: string) => unknown;
}

interface CaptionState {
  wasOn: boolean;
  previousTrack?: unknown;
}

interface PendingCaptionCapture {
  videoId: string;
  track: { vssId: string; languageCode: string; kind?: string };
  body: string | null;
}

let pendingCaptionCapture: PendingCaptionCapture | null = null;

// Temporarily hide the player's native caption overlay while we make the player
// fetch a caption track, removing the visible "flash" of the original subtitles.
function setCaptionOverlayHidden(hidden: boolean): void {
  let style = document.getElementById(CAPTION_HIDE_STYLE_ID) as HTMLStyleElement | null;
  if (hidden) {
    if (!style) {
      style = document.createElement("style");
      style.id = CAPTION_HIDE_STYLE_ID;
      style.textContent = `${YOUTUBE_PAGE_SELECTOR.captionWindow} { visibility: hidden !important; }`;
      (document.head ?? document.documentElement).append(style);
    }
    return;
  }
  style?.remove();
}

function storeCaptionBody(url: string, body: string): void {
  const videoId = readCaptionVideoId(url);
  const capture = pendingCaptionCapture;
  if (!capture || videoId !== capture.videoId || !body || body.trim().length === 0) {
    return;
  }

  try {
    const parsed = new URL(url);
    const requestedVssId = parsed.searchParams.get("vss_id");
    const requestedLanguage = parsed.searchParams.get("lang");
    const requestedKind = parsed.searchParams.get("kind");
    if (requestedVssId && requestedVssId !== capture.track.vssId) {
      return;
    }
    if (requestedLanguage && requestedLanguage !== capture.track.languageCode) {
      return;
    }
    if (requestedKind && requestedKind !== (capture.track.kind ?? "")) {
      return;
    }
  } catch {
    return;
  }

  capture.body = body;
}

// `fetch` hook: record the captions body the player retrieves (without consuming
// the response, via `clone()`).
function installFetchHook(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const result = originalFetch(input, init);
    if (url && isCaptionRequestUrl(url)) {
      void result
        .then((response) => {
          void response
            .clone()
            .text()
            .then((body) => storeCaptionBody(url, body))
            .catch(() => undefined);
        })
        .catch(() => undefined);
    }
    return result;
  }) as typeof fetch;
}

// `XMLHttpRequest` hook: record the captions body the player retrieves.
function installXhrHook(): void {
  const originalOpen = XMLHttpRequest.prototype.open as (...args: unknown[]) => void;
  const originalSend = XMLHttpRequest.prototype.send as (...args: unknown[]) => void;

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    const url = args[1];
    if (typeof url === "string" || url instanceof URL) {
      (this as unknown as { __xtranslatorCaptionUrl?: string }).__xtranslatorCaptionUrl = String(url);
    }
    return originalOpen.apply(this, args) as void;
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    const recorded = (this as unknown as { __xtranslatorCaptionUrl?: string }).__xtranslatorCaptionUrl;
    if (recorded) {
      try {
        if (isCaptionRequestUrl(recorded)) {
          this.addEventListener("load", () => {
            try {
              storeCaptionBody(recorded, this.responseText ?? "");
            } catch {
              // responseText may not be readable for non-text bodies.
            }
          });
        }
      } catch {
        // Best-effort.
      }
    }
    return originalSend.apply(this, args) as void;
  };
}

function isCaptionButtonPressed(button: HTMLElement): boolean {
  return button.getAttribute("aria-pressed") === "true" || button.classList.contains("ytp-button-pressed");
}

async function waitForCaptionButtonState(button: HTMLElement, pressed: boolean): Promise<void> {
  const deadline = Date.now() + CAPTION_BUTTON_STATE_TIMEOUT_MS;
  while (Date.now() < deadline && isCaptionButtonPressed(button) !== pressed) {
    await sleep(50);
  }
}

async function selectCaptionTrack(
  player: Element,
  track: { vssId: string; languageCode: string; kind?: string; isTranslatable?: boolean },
): Promise<boolean> {
  const withApi = player as PlayerWithCaptionApi;
  if (typeof withApi.setOption === "function") {
    try {
      withApi.setOption("captions", "track", {
        vssId: track.vssId,
        languageCode: track.languageCode,
        kind: track.kind ?? "",
        isTranslatable: track.isTranslatable ?? true,
      });
      withApi.setOption("captions", "reload", true);
      return true;
    } catch {
      // Fall through to the native control below.
    }
  }

  const subtitlesButton = document.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.subtitleButton);
  if (subtitlesButton) {
    // When captions are already on, toggle off/on while the native caption
    // layer is hidden. This forces the player to issue a fresh request instead
    // of assuming the previous caption response is still available.
    if (isCaptionButtonPressed(subtitlesButton)) {
      subtitlesButton.click();
      await waitForCaptionButtonState(subtitlesButton, false);
      if (isCaptionButtonPressed(subtitlesButton)) {
        return false;
      }
    }

    subtitlesButton.click();
    await waitForCaptionButtonState(subtitlesButton, true);
    return true;
  }

  return false;
}

function readCaptionState(player: Element): CaptionState {
  const withApi = player as PlayerWithCaptionApi;
  if (typeof withApi.getOption === "function") {
    try {
      const track = withApi.getOption("captions", "track");
      if (track) {
        return { wasOn: true, previousTrack: track };
      }
    } catch {
      // Fall through to the native control below.
    }
  }

  const button = document.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.subtitleButton);
  return { wasOn: button ? isCaptionButtonPressed(button) : false };
}

function restoreCaptionState(player: Element, state: CaptionState): void {
  const withApi = player as PlayerWithCaptionApi;

  if (state.wasOn) {
    if (typeof withApi.setOption === "function" && state.previousTrack !== undefined) {
      try {
        withApi.setOption("captions", "track", state.previousTrack);
        withApi.setOption("captions", "reload", true);
      } catch {
        // Best-effort restore.
      }
    } else {
      const button = document.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.subtitleButton);
      if (button && !isCaptionButtonPressed(button)) {
        button.click();
      }
    }
    return;
  }

  const button = document.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.subtitleButton);
  if (button && isCaptionButtonPressed(button)) {
    button.click();
    return;
  }
  if (typeof withApi.setOption === "function") {
    try {
      withApi.setOption("captions", "track", null);
      withApi.setOption("captions", "reload", true);
    } catch {
      // Best-effort restore.
    }
  }
}

async function triggerCaptionLoad(
  track: { vssId: string; languageCode: string; kind?: string; isTranslatable?: boolean },
): Promise<boolean> {
  const player = document.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.player);
  return player ? selectCaptionTrack(player, track) : false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function obtainTranscript(
  videoId: string,
  track: { vssId: string; languageCode: string; kind?: string; isTranslatable?: boolean },
): Promise<string | null> {
  // Do not reuse a previous track's body. The player is the source of truth for
  // the currently selected track, and the captured body is only a one-shot relay.
  const capture: PendingCaptionCapture = { videoId, track, body: null };
  pendingCaptionCapture = capture;

  const player = document.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.player);
  const state = player ? readCaptionState(player) : { wasOn: false };

  setCaptionOverlayHidden(true);
  const deadline = Date.now() + CAPTION_ACQUISITION_TIMEOUT_MS;
  let changedPlayerState = false;
  let body: string | null = null;
  while (Date.now() < deadline) {
    changedPlayerState = (await triggerCaptionLoad(track)) || changedPlayerState;
    body = capture.body;
    if (body) {
      break;
    }

    const retryDeadline = Math.min(Date.now() + CAPTION_TRIGGER_RETRY_MS, deadline);
    while (Date.now() < retryDeadline && !capture.body) {
      await sleep(ACQUISITION_POLL_MS);
    }
    body = capture.body;
  }

  if (player && changedPlayerState) {
    restoreCaptionState(player, state);
  }
  setCaptionOverlayHidden(false);
  if (pendingCaptionCapture === capture) {
    pendingCaptionCapture = null;
  }

  return body;
}

function postToContent(message: MainWorldBridgeMessage): void {
  window.postMessage(message, window.location.origin);
}

function replyWithFailure(requestId: string, reason: TranscriptFailureReason): void {
  postToContent({ source: MAIN_WORLD_BRIDGE_SOURCE, type: "transcript-error", requestId, reason });
}

function installMessageListener(): void {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    // The isolated content script posts with targetOrigin = this page's origin.
    // Guard on `origin` (available across worlds) rather than `event.source`,
    // whose identity is not guaranteed to match `window` across Chrome worlds.
    if (event.origin !== window.location.origin) {
      return;
    }
    const message = event.data;
    if (isRequestPlayerResponseMessage(message)) {
      const response = (window as unknown as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse ?? null;
      postToContent({ source: MAIN_WORLD_BRIDGE_SOURCE, type: "player-response-ready", requestId: message.requestId, response });
      return;
    }
    if (!isRequestTranscriptMessage(message)) {
      return;
    }

    void (async () => {
      const body = await obtainTranscript(message.videoId, message.track);
      if (body) {
        postToContent({ source: MAIN_WORLD_BRIDGE_SOURCE, type: "transcript-ready", requestId: message.requestId, body });
      } else {
        replyWithFailure(message.requestId, "no-caption-fetch");
      }
    })();
  });
}

if (typeof window.fetch === "function") {
  installFetchHook();
}
if (typeof XMLHttpRequest !== "undefined") {
  installXhrHook();
}
installMessageListener();
