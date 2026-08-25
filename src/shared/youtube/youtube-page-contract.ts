import { parseInitialPlayerResponse } from "./player-response-parser";
import type { YouTubeVideoSnapshot } from "./youtube-types";

export const YOUTUBE_PAGE_SELECTOR = {
  player: "#movie_player",
  playerRightControls: "#movie_player .ytp-right-controls",
  title: "ytd-watch-metadata h1",
  description: "#description-inline-expander",
  subtitleButton: ".ytp-subtitles-button",
  captionWindow: "#movie_player .ytp-caption-window-container",
  playerResponseScripts: "script",
  extensionMount: "[data-xtranslator-mount]",
  commentsRoot: "#comments",
  // The comment element tag changed to `ytd-comment-view-model`; keep the older
  // `ytd-comment-renderer` as a fallback so the adapter tolerates both layouts.
  comment: "ytd-comment-view-model, ytd-comment-renderer",
  commentThread: "ytd-comment-thread-renderer, ytd-comment-thread-view-model",
  commentContent: "#content-text",
  commentContentContainer: "#content",
  commentExpander: "#expander",
  commentAuthor: "#author-text, ytd-comment-view-model #author-text",
  commentHeader: "ytd-comments-header-renderer",
  commentRepliesContainer: "ytd-comment-replies-renderer, ytd-comment-replies-view-model",
  commentPermalink: "a[href*='lc=']",
  commentReplyCount: "#reply-count-end, #comment-count",
  // Reply expand controls are owned by YouTube. The extension never expands
  // replies as a side effect of translation.
  commentReplyExpand: "[id='more-replies'], [id='more-replies-sub-thread']",
} as const;

export const XTRANSLATOR_DOM = {
  mountAttribute: "data-xtranslator-mount",
  mountPlayer: "player",
  mountTitle: "title",
  mountDescription: "description",
  mountCaption: "caption",
  nativeCaptionSuppressedClass: "xtranslator-native-captions-suppressed",
  mountCommentTranslation: "comment-translation",
  mountCommentControl: "comment-control",
  mountSelection: "selection",
  styleId: "xtranslator-stage-two-style",
} as const;

export interface YouTubePageAnchors {
  player: HTMLElement;
  playerRightControls: HTMLElement;
  title: HTMLElement;
  description: HTMLElement;
}

export function readYouTubeVideoSnapshot(documentNode: Document): YouTubeVideoSnapshot | null {
  const scriptTexts = Array.from(documentNode.querySelectorAll<HTMLScriptElement>(YOUTUBE_PAGE_SELECTOR.playerResponseScripts))
    .map((script) => script.textContent ?? "")
    .filter((text) => text.includes("ytInitialPlayerResponse"));
  return parseInitialPlayerResponse(scriptTexts);
}

export function findYouTubePageAnchors(documentNode: Document): YouTubePageAnchors | null {
  const player = documentNode.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.player);
  const playerRightControls = documentNode.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.playerRightControls);
  const title = documentNode.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.title);
  const description = documentNode.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.description);
  return player && playerRightControls && title && description
    ? { player, playerRightControls, title, description }
    : null;
}

export function isYouTubeNativeCaptionsEnabled(documentNode: Document): boolean {
  const button = documentNode.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.subtitleButton);
  if (!button) {
    return false;
  }

  const unavailable = button.getAttribute("aria-disabled") === "true"
    || button.getAttribute("disabled") !== null
    || button.classList.contains("ytp-button-disabled");
  return !unavailable && (
    button.getAttribute("aria-pressed") === "true" || button.classList.contains("ytp-button-pressed")
  );
}

export function shouldShowYouTubeTranslationControl(
  snapshot: YouTubeVideoSnapshot,
  nativeCaptionsEnabled: boolean,
): boolean {
  return snapshot.captionTracks.length > 0 || nativeCaptionsEnabled;
}

export function shouldKeepYouTubeTranslationControl(
  snapshot: YouTubeVideoSnapshot,
  nativeCaptionsEnabled: boolean,
  alreadyShownForVideo: boolean,
): boolean {
  return alreadyShownForVideo || shouldShowYouTubeTranslationControl(snapshot, nativeCaptionsEnabled);
}

export function findExtensionMount(documentNode: Document, mount: string): HTMLElement | null {
  return documentNode.querySelector<HTMLElement>(`${YOUTUBE_PAGE_SELECTOR.extensionMount}[${XTRANSLATOR_DOM.mountAttribute}="${mount}"]`);
}

export function hasExtensionMount(documentNode: Document, mount: string): boolean {
  return findExtensionMount(documentNode, mount) !== null;
}

export function removeExtensionMounts(documentNode: Document): void {
  documentNode.querySelectorAll<HTMLElement>(YOUTUBE_PAGE_SELECTOR.extensionMount).forEach((mount) => mount.remove());
}
