import { Check, CircleAlert, createElement, LoaderCircle, type IconDefinition } from "../shared/icons";
import { createBrandMark } from "../shared/brand-assets";
import {
  isTranslateVideoResponse,
  MESSAGE_TYPE,
  type TranslateVideoResponse,
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
  readYouTubeVideoSnapshot,
  removeExtensionMounts,
  type YouTubePageAnchors,
} from "../shared/youtube/youtube-page-contract";
import type { CaptionLoadResult, YouTubeCaptionTrack, YouTubeVideoSnapshot } from "../shared/youtube/youtube-types";
import type { TranslationSourceSegment } from "../shared/translation/translation-types";
import { CommentTranslationController } from "./comments/comment-controller";
import { SelectionController } from "./selection/selection-controller";
import { ensureContentStyle } from "./content-style";

const PAGE_UNSUPPORTED_MESSAGE = "当前 YouTube 页面暂不支持读取。";

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

function mountPlayerControl(documentNode: Document, anchors: YouTubePageAnchors, snapshot: YouTubeVideoSnapshot): void {
  if (hasExtensionMount(documentNode, XTRANSLATOR_DOM.mountPlayer)) {
    return;
  }

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

  button.addEventListener("click", () => {
    const track = selectDefaultCaptionTrack(snapshot);
    if (!track) {
      return;
    }

    setPlayerButtonLabel(button, "翻译中");
    setButtonIcon(documentNode, button, LoaderCircle, true);
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    void (async () => {
      renderStatus(documentNode, status, "info", LoaderCircle, true, "正在读取字幕…");
      await publishVideoTranslationStatus({ phase: "reading-captions", videoId: snapshot.videoId, videoTitle: snapshot.title });
      const result = await loadCaptionTranscript(snapshot, track);
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
          if (response.ok) {
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
      setPlayerBrandIcon(documentNode, button);
      button.disabled = false;
      button.removeAttribute("aria-busy");
    })();
  });
  control.append(button, status);
  anchors.playerRightControls.prepend(control);
}

class YouTubePageRuntime {
  private activeVideoId: string | null = null;
  private mountTimer: number | undefined;

  public start(): void {
    document.addEventListener("yt-navigate-finish", () => this.scheduleMount());
    new MutationObserver(() => this.scheduleMount()).observe(document.documentElement, { childList: true, subtree: true });
    this.scheduleMount();
  }

  private scheduleMount(): void {
    if (this.mountTimer !== undefined) {
      return;
    }

    this.mountTimer = window.setTimeout(() => {
      this.mountTimer = undefined;
      this.mount();
    }, 50);
  }

  private mount(): void {
    const anchors = findYouTubePageAnchors(document);
    if (!anchors) {
      return;
    }

    ensureContentStyle(document);
    const snapshot = readYouTubeVideoSnapshot(document);
    if (!snapshot) {
      deactivateCaptionOverlay();
      removeExtensionMounts(document);
      mountTranslationContainers(document, anchors);
      setTranslationError(document, PAGE_UNSUPPORTED_MESSAGE);
      return;
    }

    if (this.activeVideoId !== snapshot.videoId) {
      deactivateCaptionOverlay();
      removeExtensionMounts(document);
      this.activeVideoId = snapshot.videoId;
    }

    mountTranslationContainers(document, anchors);
    if (snapshot.captionTracks.length > 0) {
      mountPlayerControl(document, anchors, snapshot);
    } else {
      // A video can legitimately have no caption metadata. Keep the page quiet
      // and remove a stale control if YouTube refreshed the player state.
      findExtensionMount(document, XTRANSLATOR_DOM.mountPlayer)?.remove();
    }
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
