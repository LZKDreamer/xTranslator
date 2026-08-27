import { Check, CircleAlert, createElement, LoaderCircle, type IconDefinition } from "../shared/icons";
import { createBrandMark } from "../shared/brand-assets";
import {
  isSettingsMessageResponse,
  isTranslateTextResponse,
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
  findYouTubeExpandedDescriptionText,
  findYouTubePageAnchors,
  hasExtensionMount,
  isYouTubeNativeCaptionsEnabled,
  isYouTubeWatchRoute,
  readYouTubeRouteVideoId,
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
import { downloadSubtitleFiles } from "./subtitle-export";
import { ensureContentStyle } from "./content-style";
import { createChromeSettingsRepository } from "../shared/storage/settings-repository";
import { t } from "../shared/i18n";

const PAGE_UNSUPPORTED_MESSAGE = t("content.pageUnsupported");
const PLAYER_CONTROL_CONFIRMATION_DELAY_MS = 200;
const TITLE_TRANSLATION_DELAY_MS = 400;

let captionOverlay: CaptionOverlayController | null = null;
let subtitleSettings: SubtitleSettings = { ...DEFAULT_SUBTITLE_SETTINGS };
let shortsTranslationEnabled = DEFAULT_SUBTITLE_SETTINGS.shortsTranslationEnabled;
let autoDownloadSubtitlesEnabled = DEFAULT_SUBTITLE_SETTINGS.autoDownloadSubtitles;
let autoTranslateTitleEnabled = true;
let titleTranslationSettingsReady = false;
let pageRuntime: YouTubePageRuntime | null = null;
let nextVideoTranslationRunId = 0;
let activeVideoTranslationRun: {
  runId: string;
  videoId: string;
  videoTitle: string;
  sourceTrackFingerprint: string;
  segmentCount: number;
  translatedBlockIds: Set<string>;
  status: HTMLElement;
} | null = null;

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
      autoDownloadSubtitlesEnabled = settings.subtitles.autoDownloadSubtitles;
      autoTranslateTitleEnabled = settings.page.autoTranslateTitle;
      titleTranslationSettingsReady = true;
      captionOverlay?.setSettings(settings.subtitles);
      pageRuntime?.invalidateDescriptionTranslationAvailability();
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
  if (mount === XTRANSLATOR_DOM.mountTitle) {
    container.classList.add("xtranslator-title-translation");
  }
  container.hidden = true;
  container.setAttribute("aria-live", "polite");
  return container;
}

type TitleTranslationState = "waiting" | "checking" | "loading" | "done" | "failed" | "skipped";

interface TitleTranslationRun {
  videoId: string;
  itemId: string;
  sourceText: string;
  state: TitleTranslationState;
  translatedText?: string;
}

type DescriptionTranslationState = "idle" | "loading" | "done" | "failed";

interface DescriptionTranslationRun {
  videoId: string;
  itemId: string;
  sourceText: string;
  sourceLines: string[];
  state: DescriptionTranslationState;
  translatedText?: string;
  translationVisible: boolean;
}

function renderTitleTranslation(container: HTMLElement, run: TitleTranslationRun, onRetry?: () => void): void {
  container.dataset.state = run.state;
  if (run.state === "waiting" || run.state === "checking" || run.state === "skipped") {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  switch (run.state) {
    case "loading":
      if (container.textContent !== t("content.translatingTitle") || container.childElementCount > 0) {
        container.textContent = t("content.translatingTitle");
      }
      break;
    case "done":
      if (container.textContent !== (run.translatedText ?? "") || container.childElementCount > 0) {
        container.textContent = run.translatedText ?? "";
      }
      break;
    case "failed":
      if (!onRetry) {
        if (container.textContent !== t("content.titleTranslationFailed") || container.childElementCount > 0) {
          container.textContent = t("content.titleTranslationFailed");
        }
        break;
      }
      if (container.querySelector<HTMLButtonElement>("[data-xtranslator-title-retry]")) {
        break;
      }
      const failureMessage = container.ownerDocument.createElement("span");
      failureMessage.textContent = t("content.titleTranslationFailed");
      const retryButton = container.ownerDocument.createElement("button");
      retryButton.type = "button";
      retryButton.className = "xtranslator-title-retry";
      retryButton.setAttribute("data-xtranslator-title-retry", "");
      retryButton.textContent = t("content.retryTitleTranslation");
      retryButton.addEventListener("click", onRetry);
      container.replaceChildren(failureMessage, retryButton);
      break;
  }
}

function getDescriptionTranslationItems(run: DescriptionTranslationRun): { id: string; sourceText: string }[] {
  return run.sourceLines.flatMap((sourceText, index) => {
    const text = sourceText.trim();
    return text ? [{ id: `${run.itemId}-${index}`, sourceText: text }] : [];
  });
}

function reassembleDescriptionTranslation(
  run: DescriptionTranslationRun,
  translations: Record<string, string>,
  skippedIds: readonly string[] = [],
): string | null {
  const skipped = new Set(skippedIds);
  let missingTranslation = false;
  const translatedLines = run.sourceLines.map((sourceText, index) => {
    if (!sourceText.trim()) {
      return sourceText;
    }
    const itemId = `${run.itemId}-${index}`;
    if (skipped.has(itemId)) {
      return sourceText;
    }
    const translatedText = translations[itemId]?.trim();
    if (!translatedText) {
      missingTranslation = true;
      return sourceText;
    }
    return translatedText;
  });
  return missingTranslation ? null : translatedLines.join("\n");
}

function createDescriptionTranslationContainer(documentNode: Document): HTMLDivElement {
  const container = createMount(documentNode, XTRANSLATOR_DOM.mountDescription, "xtranslator-description-translation");
  const button = documentNode.createElement("button");
  button.type = "button";
  button.className = "xtranslator-description-action";
  button.setAttribute("data-xtranslator-description-action", "");
  button.append(createBrandMark(documentNode, "light", 16));
  const label = documentNode.createElement("span");
  label.setAttribute("data-xtranslator-description-action-label", "");
  button.append(label);

  const result = documentNode.createElement("div");
  result.className = "xtranslator-description-result";
  result.setAttribute("data-xtranslator-description-result", "");
  result.hidden = true;
  const resultLabel = documentNode.createElement("span");
  resultLabel.className = "xtranslator-description-label";
  resultLabel.setAttribute("data-xtranslator-description-label", "");
  const resultText = documentNode.createElement("div");
  resultText.className = "xtranslator-description-result-text";
  resultText.setAttribute("data-xtranslator-description-result-text", "");
  result.append(resultLabel, resultText);

  container.append(button, result);
  container.hidden = true;
  container.setAttribute("aria-live", "polite");
  return container;
}

function setDescriptionActionLabel(button: HTMLButtonElement, label: string): void {
  button.setAttribute("aria-label", t("content.descriptionActionAria", { action: label }));
  const labelElement = button.querySelector<HTMLElement>("[data-xtranslator-description-action-label]");
  if (labelElement) {
    labelElement.textContent = label;
  }
}

function renderDescriptionTranslation(container: HTMLElement, run: DescriptionTranslationRun): void {
  const button = container.querySelector<HTMLButtonElement>("[data-xtranslator-description-action]");
  const result = container.querySelector<HTMLElement>("[data-xtranslator-description-result]");
  const resultLabel = container.querySelector<HTMLElement>("[data-xtranslator-description-label]");
  const resultText = container.querySelector<HTMLElement>("[data-xtranslator-description-result-text]");
  if (!button || !result || !resultLabel || !resultText) {
    return;
  }

  container.hidden = false;
  container.dataset.state = run.state;
  button.disabled = run.state === "loading";
  result.hidden = run.state !== "done" || !run.translationVisible;
  switch (run.state) {
    case "idle":
      setDescriptionActionLabel(button, t("content.translateDescription"));
      resultLabel.textContent = "";
      resultText.textContent = "";
      break;
    case "loading":
      setDescriptionActionLabel(button, t("content.translatingDescription"));
      resultLabel.textContent = "";
      resultText.textContent = "";
      break;
    case "done":
      setDescriptionActionLabel(button, t(run.translationVisible ? "content.hideDescriptionTranslation" : "content.showDescriptionTranslation"));
      resultLabel.textContent = t("content.descriptionTranslation");
      resultText.textContent = run.translatedText ?? "";
      break;
    case "failed":
      setDescriptionActionLabel(button, t("content.translateDescription"));
      result.hidden = false;
      resultLabel.textContent = "";
      resultText.textContent = t("content.descriptionTranslationFailed");
      break;
  }
}

function showTranslationStatus(container: HTMLElement, message: string): void {
  container.hidden = false;
  container.textContent = message;
}

function mountTranslationContainers(documentNode: Document, anchors: YouTubePageAnchors): void {
  if (anchors.title && !hasExtensionMount(documentNode, XTRANSLATOR_DOM.mountTitle)) {
    anchors.title.insertAdjacentElement("afterend", createTranslationContainer(documentNode, XTRANSLATOR_DOM.mountTitle));
  }

}

function setTranslationError(documentNode: Document, message: string): void {
  const titleContainer = findExtensionMount(documentNode, XTRANSLATOR_DOM.mountTitle);
  if (titleContainer) {
    showTranslationStatus(titleContainer, `xTranslator：${message}`);
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
): Promise<
  | { status: "ready"; segments: TranslationSourceSegment[]; rawBody: string }
  | Extract<CaptionLoadResult, { status: "error" }>
> {
  let body: string;
  try {
    body = await requestTranscriptBody(snapshot.videoId, track);
  } catch {
    return { status: "error", reason: "network", canRetry: true };
  }

  const segments = new YouTubeTranscriptParser().parse(createCaptionTrackFingerprint(track), body);
  return segments
    ? { status: "ready", segments, rawBody: body }
    : { status: "error", reason: "unsupported-format", canRetry: true };
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
    active.translatedBlockIds.add(message.block.id);
    renderStatus(
      document,
      active.status,
      "info",
      LoaderCircle,
      true,
      t("content.translatingProgress", {
        translated: active.translatedBlockIds.size,
        total: active.segmentCount,
      }),
    );
    void publishVideoTranslationStatus({
      phase: "translating",
      videoId: active.videoId,
      videoTitle: active.videoTitle,
      segmentCount: active.segmentCount,
      translatedCount: active.translatedBlockIds.size,
    });
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
  const existingIcon = status.querySelector("svg");
  const existingMessage = status.querySelector<HTMLElement>(".xtranslator-status-text");
  const canUpdateMessageInPlace =
    existingIcon instanceof SVGElement &&
    existingMessage !== null &&
    status.dataset.icon === icon.name &&
    status.dataset.spinning === String(spinning);

  if (canUpdateMessageInPlace) {
    existingMessage.textContent = message;
  } else {
    const messageNode = documentNode.createElement("span");
    messageNode.className = "xtranslator-status-text";
    messageNode.textContent = message;
    status.replaceChildren(createStatusIcon(icon, spinning), messageNode);
  }
  status.dataset.icon = icon.name;
  status.dataset.spinning = String(spinning);
  status.dataset.tone = tone;
  status.hidden = false;
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
    renderStatus(
      documentNode,
      status,
      "success",
      Check,
      false,
      t("content.translationCompleteProgress", {
        translated: translatedCount,
        total: response.blocks.length,
      }),
    );
    setPlayerButtonLabel(button, t("content.translateAgain"));
    await publishVideoTranslationStatus({
      phase: "translated",
      videoId: snapshot.videoId,
      videoTitle: snapshot.title,
      segmentCount: response.blocks.length,
      translatedCount,
    });
    if (autoDownloadSubtitlesEnabled && track) {
      void loadCaptionTranscript(snapshot, track).then((rawResult) => {
        if (isCurrent()) {
          downloadSubtitleFiles({
            snapshot,
            track,
            ...(rawResult.status === "ready" ? { rawBody: rawResult.rawBody } : {}),
            blocks: response.blocks,
            targetLanguage: response.targetLanguage,
          });
        }
      });
    }
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
        videoTitle: snapshot.title,
        sourceTrackFingerprint: createCaptionTrackFingerprint(track),
        segmentCount: 0,
        translatedBlockIds: new Set(),
        status,
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
        if (activeVideoTranslationRun?.runId === runId) {
          activeVideoTranslationRun.segmentCount = translationBlockCount;
          activeVideoTranslationRun.translatedBlockIds.clear();
          renderStatus(
            documentNode,
            status,
            "info",
            LoaderCircle,
            true,
            t("content.translatingProgress", { translated: 0, total: translationBlockCount }),
          );
        }
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
              renderStatus(
                documentNode,
                status,
                "success",
                Check,
                false,
                t("content.translationCompleteProgress", {
                  translated: translatedCount,
                  total: response.blocks.length,
                }),
              );
              if (autoDownloadSubtitlesEnabled) {
                downloadSubtitleFiles({
                  snapshot,
                  track,
                  rawBody: result.rawBody,
                  blocks: response.blocks,
                  targetLanguage: response.targetLanguage,
                });
              }
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
                const translatedCount = response.partial.blocks.length - response.partial.missingIds.length;
                renderStatus(
                  documentNode,
                  status,
                  "error",
                  CircleAlert,
                  false,
                  t("content.partialTranslationProgress", {
                    translated: translatedCount,
                    total: response.partial.blocks.length,
                    missing: response.partial.missingIds.length,
                  }),
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
  private routeVideoId: string | null = null;
  private mountTimer: number | undefined;
  private navigationVersion = 0;
  private mountRetryCount = 0;
  private pendingPlayerControlVideoId: string | null = null;
  private playerControlShownVideoId: string | null = null;
  private bridgeSnapshot: YouTubeVideoSnapshot | null = null;
  private bridgeSnapshotPending = false;
  private bridgeSnapshotRequestId = 0;
  private titleTranslation: TitleTranslationRun | null = null;
  private titleTranslationTimer: number | undefined;
  private descriptionTranslation: DescriptionTranslationRun | null = null;
  private descriptionTranslationAvailable: boolean | null = null;
  private descriptionSettingsCheck: Promise<boolean> | null = null;

  public start(): void {
    document.addEventListener("yt-navigate-finish", () => this.resetForVideoNavigation());
    window.addEventListener("popstate", () => this.resetForVideoNavigation());
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

  public invalidateDescriptionTranslationAvailability(): void {
    this.descriptionTranslationAvailable = null;
  }

  private resetForVideoNavigation(): void {
    this.navigationVersion += 1;
    this.activeVideoId = null;
    activeVideoTranslationRun = null;
    this.mountRetryCount = 0;
    this.pendingPlayerControlVideoId = null;
    this.playerControlShownVideoId = null;
    this.bridgeSnapshot = null;
    this.bridgeSnapshotPending = false;
    this.bridgeSnapshotRequestId += 1;
    this.titleTranslation = null;
    this.descriptionTranslation = null;
    if (this.titleTranslationTimer !== undefined) {
      window.clearTimeout(this.titleTranslationTimer);
      this.titleTranslationTimer = undefined;
    }
    deactivateCaptionOverlay();
    removeVideoExtensionMounts(document);
    void publishVideoTranslationStatus({ phase: "idle" });
    this.scheduleMount();
  }

  private isSnapshotForCurrentRoute(snapshot: YouTubeVideoSnapshot | null): snapshot is YouTubeVideoSnapshot {
    return snapshot !== null && (this.routeVideoId === null || snapshot.videoId === this.routeVideoId);
  }

  private mount(): void {
    const routeVideoId = readYouTubeRouteVideoId(window.location.href);
    if (routeVideoId !== this.routeVideoId) {
      this.routeVideoId = routeVideoId;
      this.resetForVideoNavigation();
    }

    const anchors = findYouTubePageAnchors(document);
    if (!anchors) {
      this.scheduleMountRetry();
      return;
    }

    ensureContentStyle(document);
    const documentSnapshot = readYouTubeVideoSnapshot(document);
    const currentBridgeSnapshot = this.isSnapshotForCurrentRoute(this.bridgeSnapshot) ? this.bridgeSnapshot : null;
    const currentDocumentSnapshot = this.isSnapshotForCurrentRoute(documentSnapshot) ? documentSnapshot : null;
    const snapshot = currentBridgeSnapshot ?? currentDocumentSnapshot;
    if (!currentBridgeSnapshot && (!currentDocumentSnapshot || currentDocumentSnapshot.captionTracks.length === 0)) {
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
      this.titleTranslation = null;
      this.descriptionTranslation = null;
      if (this.titleTranslationTimer !== undefined) {
        window.clearTimeout(this.titleTranslationTimer);
        this.titleTranslationTimer = undefined;
      }
      this.pendingPlayerControlVideoId = null;
      this.playerControlShownVideoId = null;
    }

    mountTranslationContainers(document, anchors);
    this.mountTitleTranslation(snapshot);
    this.mountDescriptionTranslation(snapshot);
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

  private mountTitleTranslation(snapshot: YouTubeVideoSnapshot): void {
    const container = findExtensionMount(document, XTRANSLATOR_DOM.mountTitle);
    if (!container) {
      return;
    }
    if (
      !isYouTubeWatchRoute(window.location.href)
      || !titleTranslationSettingsReady
      || !autoTranslateTitleEnabled
    ) {
      container.hidden = true;
      return;
    }

    const sourceText = snapshot.title.trim();
    if (!sourceText) {
      container.hidden = true;
      return;
    }

    const current = this.titleTranslation;
    if (current?.videoId === snapshot.videoId && current.sourceText === sourceText) {
      this.renderTitleTranslation(container, current);
      return;
    }

    const run: TitleTranslationRun = {
      videoId: snapshot.videoId,
      itemId: `title-${snapshot.videoId}`,
      sourceText,
      state: "waiting",
    };
    this.titleTranslation = run;
    this.titleTranslationTimer = window.setTimeout(() => {
      this.titleTranslationTimer = undefined;
      void this.startTitleTranslation(run);
    }, TITLE_TRANSLATION_DELAY_MS);
  }

  private renderTitleTranslation(container: HTMLElement, run: TitleTranslationRun): void {
    renderTitleTranslation(container, run, () => {
      this.retryTitleTranslation(run);
    });
  }

  private retryTitleTranslation(run: TitleTranslationRun): void {
    if (
      this.titleTranslation !== run
      || this.activeVideoId !== run.videoId
      || !autoTranslateTitleEnabled
      || !isYouTubeWatchRoute(window.location.href)
    ) {
      return;
    }
    run.state = "checking";
    const container = findExtensionMount(document, XTRANSLATOR_DOM.mountTitle);
    if (container) {
      this.renderTitleTranslation(container, run);
    }
    void this.startTitleTranslation(run);
  }

  private mountDescriptionTranslation(snapshot: YouTubeVideoSnapshot): void {
    if (!isYouTubeWatchRoute(window.location.href)) {
      findExtensionMount(document, XTRANSLATOR_DOM.mountDescription)?.remove();
      return;
    }

    const source = findYouTubeExpandedDescriptionText(document);
    const sourceText = source?.textContent?.trim() ?? "";
    if (!source || !sourceText) {
      findExtensionMount(document, XTRANSLATOR_DOM.mountDescription)?.remove();
      return;
    }

    let run = this.descriptionTranslation;
    if (run?.videoId !== snapshot.videoId || run.sourceText !== sourceText) {
      run = {
        videoId: snapshot.videoId,
        itemId: `description-${snapshot.videoId}`,
        sourceText,
        sourceLines: sourceText.split(/\r?\n/u),
        state: "idle",
        translationVisible: false,
      };
      this.descriptionTranslation = run;
      findExtensionMount(document, XTRANSLATOR_DOM.mountDescription)?.remove();
    }

    let container = findExtensionMount(document, XTRANSLATOR_DOM.mountDescription);
    if (container?.nextElementSibling !== source) {
      container?.remove();
      container = createDescriptionTranslationContainer(document);
      source.insertAdjacentElement("beforebegin", container);
      container.querySelector<HTMLButtonElement>("[data-xtranslator-description-action]")?.addEventListener("click", () => {
        this.handleDescriptionTranslationAction(run!);
      });
    }

    if (this.descriptionTranslationAvailable !== null) {
      container.hidden = !this.descriptionTranslationAvailable;
      if (this.descriptionTranslationAvailable) {
        renderDescriptionTranslation(container, run);
      }
      return;
    }

    container.hidden = true;
    void this.ensureDescriptionTranslationAvailable().then((available) => {
      if (
        this.descriptionTranslation !== run
        || this.activeVideoId !== run.videoId
        || !isYouTubeWatchRoute(window.location.href)
      ) {
        return;
      }
      const currentContainer = findExtensionMount(document, XTRANSLATOR_DOM.mountDescription);
      if (!currentContainer) {
        return;
      }
      currentContainer.hidden = !available;
      if (available) {
        renderDescriptionTranslation(currentContainer, run);
      }
    });
  }

  private async ensureDescriptionTranslationAvailable(): Promise<boolean> {
    if (this.descriptionTranslationAvailable !== null) {
      return this.descriptionTranslationAvailable;
    }
    if (this.descriptionSettingsCheck) {
      return this.descriptionSettingsCheck;
    }

    const check = (async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.getSettings });
        if (!isSettingsMessageResponse(response)) {
          this.descriptionTranslationAvailable = false;
          return false;
        }
        const settings = response.settings;
        const apiKey = settings.apiKeys[settings.provider.providerId]?.trim() ?? "";
        this.descriptionTranslationAvailable = Boolean(apiKey && settings.provider.model.trim());
        return this.descriptionTranslationAvailable;
      } catch {
        this.descriptionTranslationAvailable = false;
        return false;
      }
    })();
    this.descriptionSettingsCheck = check;
    try {
      return await check;
    } finally {
      if (this.descriptionSettingsCheck === check) {
        this.descriptionSettingsCheck = null;
      }
    }
  }

  private handleDescriptionTranslationAction(run: DescriptionTranslationRun): void {
    if (this.descriptionTranslation !== run || this.activeVideoId !== run.videoId) {
      return;
    }
    if (run.state === "done") {
      run.translationVisible = !run.translationVisible;
      const container = findExtensionMount(document, XTRANSLATOR_DOM.mountDescription);
      if (container) {
        renderDescriptionTranslation(container, run);
      }
      return;
    }
    void this.startDescriptionTranslation(run);
  }

  private async startDescriptionTranslation(run: DescriptionTranslationRun): Promise<void> {
    if (
      this.descriptionTranslation !== run
      || this.activeVideoId !== run.videoId
      || !this.descriptionTranslationAvailable
      || !isYouTubeWatchRoute(window.location.href)
    ) {
      return;
    }

    run.state = "loading";
    const container = findExtensionMount(document, XTRANSLATOR_DOM.mountDescription);
    if (container) {
      renderDescriptionTranslation(container, run);
    }

    try {
      const items = getDescriptionTranslationItems(run);
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.translateText,
        scope: "description",
        items,
      });
      if (!isTranslateTextResponse(response) || !response.ok) {
        run.state = "failed";
      } else {
        const translatedText = reassembleDescriptionTranslation(run, response.translations, response.skippedIds);
        if (translatedText) {
          run.state = "done";
          run.translatedText = translatedText;
          run.translationVisible = true;
        } else {
          run.state = "failed";
        }
      }
    } catch {
      run.state = "failed";
    }

    if (
      this.descriptionTranslation !== run
      || this.activeVideoId !== run.videoId
      || !isYouTubeWatchRoute(window.location.href)
    ) {
      return;
    }
    const currentContainer = findExtensionMount(document, XTRANSLATOR_DOM.mountDescription);
    if (currentContainer) {
      renderDescriptionTranslation(currentContainer, run);
    }
  }

  private async startTitleTranslation(run: TitleTranslationRun): Promise<void> {
    if (
      this.titleTranslation !== run
      || this.activeVideoId !== run.videoId
      || !autoTranslateTitleEnabled
      || !isYouTubeWatchRoute(window.location.href)
    ) {
      return;
    }

    run.state = "checking";
    let settingsResponse: unknown;
    try {
      settingsResponse = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.getSettings });
    } catch {
      run.state = "skipped";
      return;
    }
    if (
      this.titleTranslation !== run
      || this.activeVideoId !== run.videoId
      || !autoTranslateTitleEnabled
      || !isYouTubeWatchRoute(window.location.href)
    ) {
      return;
    }
    if (!isSettingsMessageResponse(settingsResponse)) {
      run.state = "skipped";
      return;
    }

    const settings = settingsResponse.settings;
    const apiKey = settings.apiKeys[settings.provider.providerId]?.trim() ?? "";
    if (!apiKey || !settings.provider.model.trim()) {
      run.state = "skipped";
      return;
    }

    run.state = "loading";
    const container = findExtensionMount(document, XTRANSLATOR_DOM.mountTitle);
    if (container) {
      this.renderTitleTranslation(container, run);
    }

    try {
      const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.translateText,
      scope: "title",
      items: [{ id: run.itemId, sourceText: run.sourceText }],
      });
      if (!isTranslateTextResponse(response) || !response.ok) {
        run.state = "failed";
      } else {
        const translatedText = response.translations[run.itemId]?.trim();
        if (translatedText) {
          run.state = "done";
          run.translatedText = translatedText;
        } else if (response.skippedIds?.includes(run.itemId)) {
          run.state = "skipped";
        } else {
          run.state = "failed";
        }
      }

      if (
        this.titleTranslation !== run
        || this.activeVideoId !== run.videoId
        || !autoTranslateTitleEnabled
      ) {
        return;
      }
      const currentContainer = findExtensionMount(document, XTRANSLATOR_DOM.mountTitle);
      if (currentContainer) {
        this.renderTitleTranslation(currentContainer, run);
      }
    } catch {
      if (this.titleTranslation !== run) {
        return;
      }
      run.state = "failed";
      if (this.activeVideoId !== run.videoId || !autoTranslateTitleEnabled) {
        return;
      }
      const currentContainer = findExtensionMount(document, XTRANSLATOR_DOM.mountTitle);
      if (currentContainer) {
        this.renderTitleTranslation(currentContainer, run);
      }
    }
  }

  private requestBridgeSnapshot(): void {
    if (this.bridgeSnapshotPending || this.routeVideoId === null) {
      return;
    }
    this.bridgeSnapshotPending = true;
    const navigationVersion = this.navigationVersion;
    const routeVideoId = this.routeVideoId;
    const requestId = this.bridgeSnapshotRequestId += 1;
    void requestPlayerResponse(routeVideoId).then((response) => {
      const snapshot = parseYouTubePlayerResponse(response);
      if (
        navigationVersion === this.navigationVersion &&
        routeVideoId === this.routeVideoId &&
        this.isSnapshotForCurrentRoute(snapshot)
      ) {
        this.bridgeSnapshot = snapshot;
      }
      if (requestId === this.bridgeSnapshotRequestId) {
      this.bridgeSnapshotPending = false;
        this.scheduleMount();
      }
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
  autoDownloadSubtitlesEnabled = settings.subtitles.autoDownloadSubtitles;
  autoTranslateTitleEnabled = settings.page.autoTranslateTitle;
  titleTranslationSettingsReady = true;
  captionOverlay?.setSettings(subtitleSettings);
  pageRuntime?.refresh();
}).catch(() => {
  titleTranslationSettingsReady = true;
  pageRuntime?.refresh();
});

pageRuntime = new YouTubePageRuntime();
pageRuntime.start();

const commentController = new CommentTranslationController(document);
commentController.start();
document.addEventListener("yt-navigate-finish", () => commentController.reset());

new SelectionController(document).start();
