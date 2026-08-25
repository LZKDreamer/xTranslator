import { Check, CircleAlert, createElement, LoaderCircle, type IconDefinition } from "../shared/icons";
import { createBrandMark } from "../shared/brand-assets";
import {
  isVideoTranslationCacheResponse,
  isTranslateVideoResponse,
  MESSAGE_TYPE,
  type TranslateVideoResponse,
  type VideoTranslationCacheResponse,
  type VideoTranslationStatus,
} from "../shared/contracts/messages";
import { parseCaptionDisplayMode, type CaptionDisplayMode } from "../shared/contracts/settings";
import { createCaptionTrackFingerprint, YouTubeTranscriptParser } from "../shared/youtube/transcript-parser";
import { requestTranscriptBody } from "./transcript-client";
import { CaptionOverlayController } from "./caption-overlay";
import {
  XTRANSLATOR_DOM,
  findExtensionMount,
  findYouTubePageAnchors,
  hasExtensionMount,
  isYouTubeNativeCaptionsEnabled,
  readYouTubeVideoSnapshot,
  removeExtensionMounts,
  shouldKeepYouTubeTranslationControl,
  shouldShowYouTubeTranslationControl,
  type YouTubePageAnchors,
} from "../shared/youtube/youtube-page-contract";
import type { CaptionLoadResult, YouTubeCaptionTrack, YouTubeVideoSnapshot } from "../shared/youtube/youtube-types";
import type { TranslationSourceSegment } from "../shared/translation/translation-types";
import { CommentTranslationController } from "./comments/comment-controller";
import { SelectionController } from "./selection/selection-controller";
import { ensureContentStyle } from "./content-style";

const PAGE_UNSUPPORTED_MESSAGE = "当前 YouTube 页面暂不支持读取。";
const PLAYER_CONTROL_CONFIRMATION_DELAY_MS = 200;

let captionOverlay: CaptionOverlayController | null = null;

function readDisplayMode(value: unknown): CaptionDisplayMode | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const subtitles = (value as { subtitles?: unknown }).subtitles;
  if (typeof subtitles !== "object" || subtitles === null) {
    return null;
  }

  return parseCaptionDisplayMode((subtitles as { displayMode?: unknown }).displayMode);
}

function bindSettingsChange(): void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const mode = readDisplayMode(changes.settings?.newValue);
    if (mode && captionOverlay?.isActive()) {
      captionOverlay.setMode(mode);
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
  if (!hasExtensionMount(documentNode, XTRANSLATOR_DOM.mountTitle)) {
    anchors.title.insertAdjacentElement("afterend", createTranslationContainer(documentNode, XTRANSLATOR_DOM.mountTitle));
  }

  if (!hasExtensionMount(documentNode, XTRANSLATOR_DOM.mountDescription)) {
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
      return "字幕链接已失效或暂时不可用，请重试。";
    case "network":
      return "无法读取字幕，请检查网络后重试。";
    case "unsupported-format":
      return "当前字幕格式暂不支持读取，请稍后重试。";
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
): Promise<TranslateVideoResponse> {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE.translateVideo,
    videoId: snapshot.videoId,
    videoTitle: snapshot.title,
    videoDescription: snapshot.shortDescription,
    sourceTrackFingerprint: createCaptionTrackFingerprint(track),
    sourceLanguage: track.languageCode,
    segments: [...segments],
  });
  if (!isTranslateVideoResponse(response)) {
    throw new Error("Invalid xTranslator translate response.");
  }
  return response;
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

function partialTranslationMessage(errorMessage: string): string {
  if (errorMessage.includes("超时")) {
    return "翻译超时，部分字幕已完成，点击继续。";
  }
  return "翻译未完成，部分字幕已完成，点击继续。";
}

function mountPlayerControl(
  documentNode: Document,
  anchors: YouTubePageAnchors,
  snapshot: YouTubeVideoSnapshot,
  isCurrent: () => boolean,
): void {
  const existingMount = findExtensionMount(documentNode, XTRANSLATOR_DOM.mountPlayer);
  if (existingMount?.parentElement === anchors.playerRightControls) {
    return;
  }
  existingMount?.remove();

  const control = createMount(documentNode, XTRANSLATOR_DOM.mountPlayer, "xtranslator-player-mount");
  const button = documentNode.createElement("button");
  button.className = "xtranslator-control";
  button.type = "button";
  setPlayerButtonLabel(button, "开始翻译");
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
    captionOverlay ??= new CaptionOverlayController(documentNode, anchors.player);
    captionOverlay.load(response.blocks);
    captionOverlay.setMode(response.displayMode);
    const translatedCount = response.blocks.filter((block) => block.translatedText.trim()).length;
    renderStatus(documentNode, status, "success", Check, false, `已加载缓存：${response.blocks.length} 段`);
    setPlayerButtonLabel(button, "再次翻译");
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
    setPlayerButtonLabel(button, "翻译中");
    setButtonIcon(documentNode, button, LoaderCircle, true);
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    void (async () => {
      const finish = (): void => {
        if (isCurrent()) {
          setPlayerBrandIcon(documentNode, button);
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      };
      if (!isCurrent()) {
        return;
      }

      renderStatus(documentNode, status, "info", LoaderCircle, true, "正在读取缓存…");
      const cachedResponse = await readCache();
      if (!isCurrent()) {
        return;
      }
      if (await applyCachedResponse(cachedResponse)) {
        finish();
        return;
      }

      if (!track) {
        const message = "当前视频没有可用字幕，且没有本地翻译缓存。";
        setPlayerButtonLabel(button, "重试字幕");
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

      renderStatus(documentNode, status, "info", LoaderCircle, true, "正在读取字幕…");
      await publishVideoTranslationStatus({ phase: "reading-captions", videoId: snapshot.videoId, videoTitle: snapshot.title });
      const result = await loadCaptionTranscript(snapshot, track);
      if (!isCurrent()) {
        return;
      }
      if (result.status === "ready") {
        renderStatus(documentNode, status, "info", LoaderCircle, true, `正在翻译 ${result.segments.length} 段…`);
        await publishVideoTranslationStatus({
          phase: "translating",
          videoId: snapshot.videoId,
          videoTitle: snapshot.title,
          segmentCount: result.segments.length,
        });

        try {
          const response = await requestVideoTranslation(snapshot, track, result.segments);
          if (!isCurrent()) {
            return;
          }
          if (response.ok) {
            if (response.skipped) {
              deactivateCaptionOverlay();
              renderStatus(documentNode, status, "success", Check, false, "当前字幕已是目标语言，无需翻译");
              setPlayerButtonLabel(button, "无需翻译");
              await publishVideoTranslationStatus({
                phase: "translated",
                videoId: snapshot.videoId,
                videoTitle: snapshot.title,
                segmentCount: 0,
                translatedCount: 0,
              });
            } else {
              captionOverlay ??= new CaptionOverlayController(documentNode, anchors.player);
              captionOverlay.load(response.blocks);
              captionOverlay.setMode(response.displayMode);

              const translatedCount = response.blocks.length - response.missingIds.length;
              renderStatus(documentNode, status, "success", Check, false, `翻译完成：${response.blocks.length} 段`);
              setPlayerButtonLabel(button, "再次翻译");
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
              captionOverlay ??= new CaptionOverlayController(documentNode, anchors.player);
              captionOverlay.load(response.partial.blocks);
              captionOverlay.setMode(response.partial.displayMode);
              setPlayerButtonLabel(button, "继续翻译");
              renderStatus(
                documentNode,
                status,
                "error",
                CircleAlert,
                false,
                partialTranslationMessage(response.errorMessage),
              );
            } else {
              setPlayerButtonLabel(button, "重试");
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
          const message = "无法连接到翻译服务，请检查扩展设置后重试。";
          setPlayerButtonLabel(button, "重试");
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
        setPlayerButtonLabel(button, "重试字幕");
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
  anchors.playerRightControls.prepend(control);
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

  public start(): void {
    document.addEventListener("yt-navigate-finish", () => {
      this.navigationVersion += 1;
      this.activeVideoId = null;
      this.mountRetryCount = 0;
      this.pendingPlayerControlVideoId = null;
      this.playerControlShownVideoId = null;
      deactivateCaptionOverlay();
      removeExtensionMounts(document);
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

  private mount(): void {
    const anchors = findYouTubePageAnchors(document);
    if (!anchors) {
      this.scheduleMountRetry();
      return;
    }

    ensureContentStyle(document);
    const snapshot = readYouTubeVideoSnapshot(document);
    if (!snapshot) {
      if (this.scheduleMountRetry()) {
        return;
      }
      this.pendingPlayerControlVideoId = null;
      this.playerControlShownVideoId = null;
      deactivateCaptionOverlay();
      removeExtensionMounts(document);
      mountTranslationContainers(document, anchors);
      setTranslationError(document, PAGE_UNSUPPORTED_MESSAGE);
      return;
    }

    this.mountRetryCount = 0;

    if (this.activeVideoId !== snapshot.videoId) {
      deactivateCaptionOverlay();
      removeExtensionMounts(document);
      this.activeVideoId = snapshot.videoId;
      this.pendingPlayerControlVideoId = null;
      this.playerControlShownVideoId = null;
    }

    mountTranslationContainers(document, anchors);
    const nativeCaptionsEnabled = isYouTubeNativeCaptionsEnabled(document);
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
}

// Inject the stylesheet up front so comment controls and the selection overlay are
// styled even on pages where the player mount is delayed.
ensureContentStyle(document);
bindSettingsChange();

new YouTubePageRuntime().start();

const commentController = new CommentTranslationController(document);
commentController.start();
document.addEventListener("yt-navigate-finish", () => commentController.reset());

new SelectionController(document).start();
