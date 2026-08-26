import { Check, CircleAlert, createElement, LoaderCircle, type IconDefinition } from "../shared/icons";
import { createBrandMark } from "../shared/brand-assets";
import {
  isSettingsMessageResponse,
  isVideoTranslationCacheResponse,
  isTranslateVideoProgressMessage,
  isTranslateVideoResponse,
  MESSAGE_TYPE,
  type TranslateVideoResponse,
  type VideoTranslationCacheResponse,
  type VideoTranslationStatus,
} from "../shared/contracts/messages";
import {
  DEFAULT_SUBTITLE_SETTINGS,
  parseExtensionSettings,
  type SubtitleSettings,
} from "../shared/contracts/settings";
import { getProviderContextWindow, getProviderPreset } from "../shared/providers/provider-registry";
import { createCaptionTrackFingerprint, YouTubeTranscriptParser } from "../shared/youtube/transcript-parser";
import { parseYouTubePlayerResponse } from "../shared/youtube/player-response-parser";
import { requestPlayerResponse, requestTranscriptBody } from "./transcript-client";
import { CaptionOverlayController } from "./caption-overlay";
import {
  XTRANSLATOR_DOM,
  findExtensionMount,
  findYouTubePageAnchors,
  hasExtensionMount,
  isYouTubeNativeCaptionsEnabled,
  readYouTubeVideoSnapshot,
  removeVideoExtensionMounts,
  shouldKeepYouTubeTranslationControl,
  shouldShowYouTubeTranslationControl,
  type YouTubePageAnchors,
} from "../shared/youtube/youtube-page-contract";
import type { CaptionLoadResult, YouTubeCaptionTrack, YouTubeVideoSnapshot } from "../shared/youtube/youtube-types";
import { buildTranslationBlocks } from "../shared/translation/block-builder";
import type { TranslationSourceSegment } from "../shared/translation/translation-types";
import { CommentTranslationController } from "./comments/comment-controller";
import { SelectionController } from "./selection/selection-controller";
import { ensureContentStyle } from "./content-style";
import { createChromeSettingsRepository } from "../shared/storage/settings-repository";
import { t } from "../shared/i18n";

const PAGE_UNSUPPORTED_MESSAGE = t("content.pageUnsupported");
const PLAYER_CONTROL_CONFIRMATION_DELAY_MS = 200;

let captionOverlay: CaptionOverlayController | null = null;
let subtitleSettings: SubtitleSettings = { ...DEFAULT_SUBTITLE_SETTINGS };
let shortsTranslationEnabled = DEFAULT_SUBTITLE_SETTINGS.shortsTranslationEnabled;
let pageRuntime: YouTubePageRuntime | null = null;
let nextVideoTranslationRunId = 0;
let activeVideoTranslationRun: { runId: string; videoId: string; sourceTrackFingerprint: string } | null = null;

function getExtensionSettings(value: unknown) {
  return parseExtensionSettings(value);
}

async function saveCaptionVerticalPosition(verticalPosition: number | null): Promise<void> {
  const repository = createChromeSettingsRepository();
  const settings = await repository.loadSettings();
  await repository.saveSettings({
    ...settings,
    subtitles: { ...settings.subtitles, verticalPosition },
  });
}

function getCaptionOverlay(documentNode: Document, player: Element): CaptionOverlayController {
  captionOverlay ??= new CaptionOverlayController(documentNode, player, saveCaptionVerticalPosition);
  captionOverlay.setSettings(subtitleSettings);
  return captionOverlay;
}

function bindSettingsChange(): void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const settings = getExtensionSettings(changes.settings?.newValue);
    if (settings) {
      subtitleSettings = settings.subtitles;
      shortsTranslationEnabled = settings.subtitles.shortsTranslationEnabled;
      captionOverlay?.setSettings(settings.subtitles);
      pageRuntime?.refresh();
    }
  });
}

function createMount(documentNode: Document, mount: string, className: string): HTMLDivElement {
  const element = documentNode.createElement("div");
  element.setAttribute(XTRANSLATOR_DOM.mountAttribute, mount);
  element.className = className;
  return element;
}

function createTranslationContainer(documentNode: Document, mount: string): HTMLDivElement {
  const container = createMount(documentNode, mount, "xtranslator-translation");
  container.hidden = true;
  container.setAttribute("aria-live", "polite");
  return container;
}

function showTranslationStatus(container: HTMLElement, message: string): void {
  container.hidden = false;
  container.textContent = message;
}

function mountTranslationContainers(documentNode: Document, anchors: YouTubePageAnchors): void {
  if (anchors.title && !hasExtensionMount(documentNode, XTRANSLATOR_DOM.mountTitle)) {
    anchors.title.insertAdjacentElement("afterend", createTranslationContainer(documentNode, XTRANSLATOR_DOM.mountTitle));
  }

  if (anchors.description && !hasExtensionMount(documentNode, XTRANSLATOR_DOM.mountDescription)) {
    anchors.description.insertAdjacentElement(
      "afterend",
      createTranslationContainer(documentNode, XTRANSLATOR_DOM.mountDescription),
    );
  }
}

function setTranslationError(documentNode: Document, message: string): void {
  const titleContainer = findExtensionMount(documentNode, XTRANSLATOR_DOM.mountTitle);
  const descriptionContainer = findExtensionMount(documentNode, XTRANSLATOR_DOM.mountDescription);
  if (titleContainer) {
    showTranslationStatus(titleContainer, `xTranslator：${message}`);
  }
  if (descriptionContainer) {
    showTranslationStatus(descriptionContainer, `xTranslator：${message}`);
  }
}

function deactivateCaptionOverlay(): void {
  captionOverlay?.deactivate();
  captionOverlay = null;
}

function selectDefaultCaptionTrack(snapshot: YouTubeVideoSnapshot) {
  return snapshot.captionTracks.find((track) => track.kind !== "asr") ?? snapshot.captionTracks[0];
}

function captionErrorMessage(result: Extract<CaptionLoadResult, { status: "error" }>): string {
  switch (result.reason) {
    case "http":
      return t("content.captionHttp");
    case "network":
      return t("content.captionNetwork");
    case "unsupported-format":
      return t("content.captionUnsupported");
  }
}

async function loadCaptionTranscript(
  snapshot: YouTubeVideoSnapshot,
  track: YouTubeCaptionTrack,
): Promise<CaptionLoadResult> {
  let body: string;
  try {
    body = await requestTranscriptBody(snapshot.videoId, track);
  } catch {
    return { status: "error", reason: "network", canRetry: true };
  }

  const segments = new YouTubeTranscriptParser().parse(createCaptionTrackFingerprint(track), body);
  return segments ? { status: "ready", segments } : { status: "error", reason: "unsupported-format", canRetry: true };
}

async function requestVideoTranslation(
  snapshot: YouTubeVideoSnapshot,
  track: YouTubeCaptionTrack,
  segments: readonly TranslationSourceSegment[],
  runId: string,
): Promise<TranslateVideoResponse> {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE.translateVideo,
    runId,
    videoId: snapshot.videoId,
    videoTitle: snapshot.title,
    sourceTrackFingerprint: createCaptionTrackFingerprint(track),
    sourceLanguage: track.languageCode,
    segments: [...segments],
  });
  if (!isTranslateVideoResponse(response)) {
    throw new Error("Invalid xTranslator translate response.");
  }
  return response;
}

function bindVideoTranslationProgress(): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
    return;
  }
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isTranslateVideoProgressMessage(message)) {
      return false;
    }
    const active = activeVideoTranslationRun;
    if (
      !active ||
      active.runId !== message.runId ||
      active.videoId !== message.videoId ||
      active.sourceTrackFingerprint !== message.sourceTrackFingerprint
    ) {
      return false;
    }

    const anchors = findYouTubePageAnchors(document);
    if (!anchors) {
      return false;
    }
    const overlay = getCaptionOverlay(document, anchors.player);
    overlay.append([message.block]);
    overlay.setMode(message.displayMode);
    return false;
  });
}

async function resolveTranslationBlockCount(
  segments: readonly TranslationSourceSegment[],
  sourceLanguage: string,
): Promise<number> {
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.getSettings });
    if (isSettingsMessageResponse(response)) {
      const preset = getProviderPreset(response.settings.provider.providerId);
      if (preset) {
        const model = response.settings.provider.model.trim();
        if (!model) {
          return segments.length;
        }
        return buildTranslationBlocks(
          segments,
          getProviderContextWindow(preset, model),
          undefined,
          undefined,
          undefined,
          sourceLanguage,
        ).length;
      }
    }
  } catch {
    // Translation will still report its result if settings are temporarily unavailable.
  }
  return segments.length;
}

async function requestCachedVideoTranslation(videoId: string): Promise<VideoTranslationCacheResponse> {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE.getVideoTranslationCache,
    videoId,
  });
  if (!isVideoTranslationCacheResponse(response)) {
    throw new Error("Invalid xTranslator cache response.");
  }
  return response;
}

async function publishVideoTranslationStatus(status: VideoTranslationStatus): Promise<void> {
  if (typeof chrome === "undefined") {
    return;
  }

  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.updateVideoTranslationStatus, status });
  } catch {
    // The player control remains usable if the service worker is temporarily unavailable.
  }
}

function createStatusIcon(icon: IconDefinition, spinning: boolean): SVGElement {
  const element = createElement(icon);
  if (spinning) {
    element.classList.add("xtranslator-spin");
  }
  return element;
}

function setPlayerBrandIcon(documentNode: Document, button: HTMLButtonElement): void {
  button.replaceChildren(createBrandMark(documentNode, "dark", 20));
}

function setPlayerButtonLabel(button: HTMLButtonElement, label: string): void {
  button.title = label;
  button.setAttribute("aria-label", label);
}

function setButtonIcon(documentNode: Document, button: HTMLButtonElement, icon: IconDefinition, spinning = false): void {
  button.replaceChildren(createStatusIcon(icon, spinning));
}

function renderStatus(documentNode: Document, status: HTMLElement, tone: "info" | "success" | "error", icon: IconDefinition, spinning: boolean, message: string): void {
  status.replaceChildren(createStatusIcon(icon, spinning), documentNode.createTextNode(message));
  status.dataset.tone = tone;
  status.hidden = false;
}

function partialTranslationMessage(): string {
  return t("content.partialTranslation");
}

function mountPlayerControl(
  documentNode: Document,
  anchors: YouTubePageAnchors,
  snapshot: YouTubeVideoSnapshot,
  isCurrent: () => boolean,
): void {
  const isShortsPlayer = anchors.player.id === "shorts-player";
  // Shorts also creates a `.ytp-right-controls` container, but its visible
  // CC/overflow/fullscreen actions live in the top toolbar instead.
  const controlParent = isShortsPlayer
    ? anchors.playerTopControls ?? anchors.player
    : anchors.playerRightControls ?? anchors.playerTopControls ?? anchors.player;
  const existingMount = findExtensionMount(documentNode, XTRANSLATOR_DOM.mountPlayer);
  if (existingMount?.parentElement === controlParent) {
    return;
  }
  existingMount?.remove();

  const isShortsFallback = isShortsPlayer && anchors.playerTopControls === null;
  const control = createMount(
    documentNode,
    XTRANSLATOR_DOM.mountPlayer,
    isShortsFallback ? "xtranslator-player-mount xtranslator-shorts-player-mount" : "xtranslator-player-mount",
  );
  const button = documentNode.createElement("button");
  button.className = "xtranslator-control";
  button.type = "button";
  setPlayerButtonLabel(button, t("content.startTranslation"));
  setPlayerBrandIcon(documentNode, button);

  const status = documentNode.createElement("div");
  status.className = "xtranslator-status";
  status.hidden = true;
  status.setAttribute("role", "status");

  let cachedResponsePromise: Promise<VideoTranslationCacheResponse> | null = null;
  const readCache = (): Promise<VideoTranslationCacheResponse> => {
    cachedResponsePromise ??= requestCachedVideoTranslation(snapshot.videoId).catch(() => ({ found: false }));
    return cachedResponsePromise;
  };
  const track = selectDefaultCaptionTrack(snapshot);
  const applyCachedResponse = async (response: VideoTranslationCacheResponse): Promise<boolean> => {
    if (!response.found || !isCurrent()) {
      return false;
    }
    if (track && (
      response.sourceLanguage !== track.languageCode ||
      response.sourceTrackFingerprint !== createCaptionTrackFingerprint(track)
    )) {
      return false;
    }
    const overlay = getCaptionOverlay(documentNode, anchors.player);
    overlay.load(response.blocks);
    overlay.setMode(response.displayMode);
    const translatedCount = response.blocks.filter((block) => block.translatedText.trim()).length;
    renderStatus(documentNode, status, "success", Check, false, t("content.cacheLoaded", { count: response.blocks.length }));
    setPlayerButtonLabel(button, t("content.translateAgain"));
    await publishVideoTranslationStatus({
      phase: "translated",
      videoId: snapshot.videoId,
      videoTitle: snapshot.title,
      segmentCount: response.blocks.length,
      translatedCount,
    });
    return true;
  };

  button.addEventListener("click", () => {
    const runId = `video-${nextVideoTranslationRunId += 1}`;
    setPlayerButtonLabel(button, t("content.translating"));
    setButtonIcon(documentNode, button, LoaderCircle, true);
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    void (async () => {
      const finish = (): void => {
        if (activeVideoTranslationRun?.runId === runId) {
          activeVideoTranslationRun = null;
        }
        if (isCurrent()) {
          setPlayerBrandIcon(documentNode, button);
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      };
      if (!isCurrent()) {
        return;
      }

      renderStatus(documentNode, status, "info", LoaderCircle, true, t("content.readingCache"));
      const cachedResponse = await readCache();
      if (!isCurrent()) {
        return;
      }
      if (await applyCachedResponse(cachedResponse)) {
        finish();
        return;
      }

      if (!track) {
        const message = t("content.noCaptionsOrCache");
        setPlayerButtonLabel(button, t("content.retryCaptions"));
        renderStatus(documentNode, status, "error", CircleAlert, false, message);
        await publishVideoTranslationStatus({
          phase: "error",
          videoId: snapshot.videoId,
          videoTitle: snapshot.title,
          errorMessage: message,
        });
        finish();
        return;
      }

      activeVideoTranslationRun = {
        runId,
        videoId: snapshot.videoId,
        sourceTrackFingerprint: createCaptionTrackFingerprint(track),
      };
      renderStatus(documentNode, status, "info", LoaderCircle, true, t("content.readingCaptions"));
      await publishVideoTranslationStatus({ phase: "reading-captions", videoId: snapshot.videoId, videoTitle: snapshot.title });
      const result = await loadCaptionTranscript(snapshot, track);
      if (!isCurrent()) {
        return;
      }
      if (result.status === "ready") {
        const translationBlockCount = await resolveTranslationBlockCount(result.segments, track.languageCode);
        renderStatus(documentNode, status, "info", LoaderCircle, true, t("content.translatingSegments", { count: translationBlockCount }));
        await publishVideoTranslationStatus({
          phase: "translating",
          videoId: snapshot.videoId,
          videoTitle: snapshot.title,
          segmentCount: translationBlockCount,
        });

        try {
          const response = await requestVideoTranslation(snapshot, track, result.segments, runId);
          if (!isCurrent()) {
            return;
          }
          if (response.ok) {
            if (response.skipped) {
              deactivateCaptionOverlay();
              renderStatus(documentNode, status, "success", Check, false, t("content.noTranslationNeeded"));
              setPlayerButtonLabel(button, t("content.noTranslation"));
              await publishVideoTranslationStatus({
                phase: "translated",
                videoId: snapshot.videoId,
                videoTitle: snapshot.title,
                segmentCount: 0,
                translatedCount: 0,
              });
            } else {
              const overlay = getCaptionOverlay(documentNode, anchors.player);
              overlay.load(response.blocks);
              overlay.setMode(response.displayMode);

              const translatedCount = response.blocks.length - response.missingIds.length;
              renderStatus(documentNode, status, "success", Check, false, t("content.translationComplete", { count: response.blocks.length }));
              setPlayerButtonLabel(button, t("content.translateAgain"));
              await publishVideoTranslationStatus({
                phase: "translated",
                videoId: snapshot.videoId,
                videoTitle: snapshot.title,
                segmentCount: response.blocks.length,
                translatedCount,
              });
            }
          } else {
            if (response.partial) {
              const overlay = getCaptionOverlay(documentNode, anchors.player);
              overlay.load(response.partial.blocks);
              overlay.setMode(response.partial.displayMode);
              setPlayerButtonLabel(button, t("content.continueTranslation"));
              renderStatus(
                documentNode,
                status,
                "error",
                CircleAlert,
                false,
                partialTranslationMessage(),
              );
            } else {
              setPlayerButtonLabel(button, t("content.retry"));
              renderStatus(documentNode, status, "error", CircleAlert, false, response.errorMessage);
            }
            await publishVideoTranslationStatus({
              phase: "error",
              videoId: snapshot.videoId,
              videoTitle: snapshot.title,
              errorMessage: response.errorMessage,
            });
          }
        } catch {
          if (!isCurrent()) {
            return;
          }
          const message = t("content.serviceUnavailable");
          setPlayerButtonLabel(button, t("content.retry"));
          renderStatus(documentNode, status, "error", CircleAlert, false, message);
          await publishVideoTranslationStatus({
            phase: "error",
            videoId: snapshot.videoId,
            videoTitle: snapshot.title,
            errorMessage: message,
          });
        }
      } else {
        if (!isCurrent()) {
          return;
        }
        const message = captionErrorMessage(result);
        setPlayerButtonLabel(button, t("content.retryCaptions"));
        renderStatus(documentNode, status, "error", CircleAlert, false, message);
        await publishVideoTranslationStatus({
          phase: "error",
          videoId: snapshot.videoId,
          videoTitle: snapshot.title,
          errorMessage: message,
        });
      }
      finish();
    })();
  });
  control.append(button, status);
  controlParent.prepend(control);
  void readCache().then((response) => {
    if (!button.disabled && response.found) {
      void applyCachedResponse(response);
    }
  });
}

class YouTubePageRuntime {
  private activeVideoId: string | null = null;
  private mountTimer: number | undefined;
  private navigationVersion = 0;
  private mountRetryCount = 0;
  private pendingPlayerControlVideoId: string | null = null;
  private playerControlShownVideoId: string | null = null;
  private bridgeSnapshot: YouTubeVideoSnapshot | null = null;
  private bridgeSnapshotPending = false;

  public start(): void {
    document.addEventListener("yt-navigate-finish", () => {
      this.navigationVersion += 1;
      this.activeVideoId = null;
      activeVideoTranslationRun = null;
      this.mountRetryCount = 0;
      this.pendingPlayerControlVideoId = null;
      this.playerControlShownVideoId = null;
      this.bridgeSnapshot = null;
      this.bridgeSnapshotPending = false;
      deactivateCaptionOverlay();
      removeVideoExtensionMounts(document);
      void publishVideoTranslationStatus({ phase: "idle" });
      this.scheduleMount();
    });
    new MutationObserver(() => this.scheduleMount()).observe(document.documentElement, { childList: true, subtree: true });
    this.scheduleMount();
  }

  private scheduleMount(delayMs = 50): void {
    if (this.mountTimer !== undefined) {
      return;
    }

    this.mountTimer = window.setTimeout(() => {
      this.mountTimer = undefined;
      this.mount();
    }, delayMs);
  }

  private scheduleMountRetry(): boolean {
    if (this.mountRetryCount >= 24) {
      return false;
    }

    this.mountRetryCount += 1;
    this.scheduleMount(250);
    return true;
  }

  public refresh(): void {
    this.scheduleMount();
  }

  private mount(): void {
    const anchors = findYouTubePageAnchors(document);
    if (!anchors) {
      this.scheduleMountRetry();
      return;
    }

    ensureContentStyle(document);
    const documentSnapshot = readYouTubeVideoSnapshot(document);
    const snapshot = this.bridgeSnapshot ?? documentSnapshot;
    if (!this.bridgeSnapshot && (!documentSnapshot || documentSnapshot.captionTracks.length === 0)) {
      this.requestBridgeSnapshot();
    }
    if (!snapshot) {
      if (this.scheduleMountRetry()) {
        return;
      }
      this.pendingPlayerControlVideoId = null;
      this.playerControlShownVideoId = null;
      deactivateCaptionOverlay();
      removeVideoExtensionMounts(document);
      mountTranslationContainers(document, anchors);
      setTranslationError(document, PAGE_UNSUPPORTED_MESSAGE);
      return;
    }

    this.mountRetryCount = 0;

    if (this.activeVideoId !== snapshot.videoId) {
      activeVideoTranslationRun = null;
      deactivateCaptionOverlay();
      removeVideoExtensionMounts(document);
      this.activeVideoId = snapshot.videoId;
      this.pendingPlayerControlVideoId = null;
      this.playerControlShownVideoId = null;
    }

    mountTranslationContainers(document, anchors);
    if (anchors.player.id === "shorts-player" && !shortsTranslationEnabled) {
      this.pendingPlayerControlVideoId = null;
      findExtensionMount(document, XTRANSLATOR_DOM.mountPlayer)?.remove();
      return;
    }
    const nativeCaptionsEnabled = isYouTubeNativeCaptionsEnabled(document, anchors.player);
    const canShowPlayerControl = shouldShowYouTubeTranslationControl(snapshot, nativeCaptionsEnabled);
    const alreadyShownForVideo = this.playerControlShownVideoId === snapshot.videoId;
    if (!shouldKeepYouTubeTranslationControl(snapshot, nativeCaptionsEnabled, alreadyShownForVideo)) {
      this.pendingPlayerControlVideoId = null;
      findExtensionMount(document, XTRANSLATOR_DOM.mountPlayer)?.remove();
      return;
    }
    if (!canShowPlayerControl) {
      // Once the current video's caption availability has been confirmed and
      // the control is shown, keep it during transient player-response updates.
      // YouTube may briefly publish an incomplete response while the player is
      // still settling; removing the control here causes visible flicker.
      this.pendingPlayerControlVideoId = null;
      return;
    }

    if (this.playerControlShownVideoId !== snapshot.videoId) {
      if (this.pendingPlayerControlVideoId !== snapshot.videoId) {
        this.pendingPlayerControlVideoId = snapshot.videoId;
        this.scheduleMount(PLAYER_CONTROL_CONFIRMATION_DELAY_MS);
        return;
      }
      this.pendingPlayerControlVideoId = null;
      this.playerControlShownVideoId = snapshot.videoId;
    }

    const navigationVersion = this.navigationVersion;
    mountPlayerControl(
      document,
      anchors,
      snapshot,
      () => navigationVersion === this.navigationVersion && this.activeVideoId === snapshot.videoId,
    );
  }

  private requestBridgeSnapshot(): void {
    if (this.bridgeSnapshotPending) {
      return;
    }
    this.bridgeSnapshotPending = true;
    const navigationVersion = this.navigationVersion;
    void requestPlayerResponse().then((response) => {
      if (navigationVersion === this.navigationVersion) {
        this.bridgeSnapshot = parseYouTubePlayerResponse(response);
      }
      this.bridgeSnapshotPending = false;
      this.scheduleMount();
    });
  }
}

// Inject the stylesheet up front so comment controls and the selection overlay are
// styled even on pages where the player mount is delayed.
ensureContentStyle(document);
bindSettingsChange();
bindVideoTranslationProgress();
void createChromeSettingsRepository().loadSettings().then((settings) => {
  subtitleSettings = settings.subtitles;
  shortsTranslationEnabled = settings.subtitles.shortsTranslationEnabled;
  captionOverlay?.setSettings(subtitleSettings);
  pageRuntime?.refresh();
}).catch(() => undefined);

pageRuntime = new YouTubePageRuntime();
pageRuntime.start();

const commentController = new CommentTranslationController(document);
commentController.start();
document.addEventListener("yt-navigate-finish", () => commentController.reset());

new SelectionController(document).start();
