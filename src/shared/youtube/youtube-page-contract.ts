import { parseInitialPlayerResponse } from "./player-response-parser";
import type { YouTubeVideoSnapshot } from "./youtube-types";

export const YOUTUBE_PAGE_SELECTOR = {
  // Shorts uses a separate player host from the regular watch page, but keeps
  // the same YouTube player controls and caption APIs inside it.
  player: "#movie_player, #shorts-player",
  playerRightControls: ".ytp-right-controls",
  playerTopControls: ".ytp-chrome-top-buttons",
  progressBarContainer: ".ytp-progress-bar-container",
  title: "ytd-watch-metadata h1, ytd-reel-player-header-renderer #title",
  description: "#description-inline-expander, ytd-reel-player-header-renderer #description",
  subtitleButton: ".ytp-subtitles-button",
  captionWindow: ".ytp-caption-window-container",
  playerResponseScripts: "script",
  extensionMount: "[data-xtranslator-mount]",
  // A Short opens comments in an engagement panel. Depending on the current
  // YouTube rollout, the panel either contains `#comments` or is itself the
  // stable root while comments are hydrated lazily.
  commentsRoot: "#comments, ytd-reel-engagement-panel-section-renderer ytd-comments, ytd-reel-engagement-panel-section-renderer[target-id='engagement-panel-comments-section'], ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-comments-section']",
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
  playerRightControls: HTMLElement | null;
  playerTopControls: HTMLElement | null;
  title: HTMLElement | null;
  description: HTMLElement | null;
}

/**
 * Returns the video currently addressed by a YouTube watch or Shorts URL.
 * This is deliberately separate from player-response parsing: YouTube keeps
 * the document alive during SPA navigation, so an old player response can be
 * present briefly after the URL has already changed.
 */
export function readYouTubeRouteVideoId(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.pathname === "/watch") {
      return url.searchParams.get("v") || null;
    }

    const shortsMatch = /^\/shorts\/([^/?#]+)/u.exec(url.pathname);
    return shortsMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

export function readYouTubeVideoSnapshot(documentNode: Document): YouTubeVideoSnapshot | null {
  const scriptTexts = Array.from(documentNode.querySelectorAll<HTMLScriptElement>(YOUTUBE_PAGE_SELECTOR.playerResponseScripts))
    .map((script) => script.textContent ?? "")
    .filter((text) => text.includes("ytInitialPlayerResponse"));
  return parseInitialPlayerResponse(scriptTexts);
}

export function findYouTubePageAnchors(documentNode: Document): YouTubePageAnchors | null {
  const player = documentNode.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.player);
  const playerRightControls = player?.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.playerRightControls) ?? null;
  const playerTopControls = player?.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.playerTopControls) ?? null;
  const title = documentNode.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.title);
  const description = documentNode.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.description);
  return player
    ? { player, playerRightControls, playerTopControls, title, description }
    : null;
}

export function isYouTubeNativeCaptionsEnabled(documentNode: Document, player?: ParentNode): boolean {
  const button = (player ?? documentNode).querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.subtitleButton);
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

export function removeVideoExtensionMounts(documentNode: Document): void {
  const mounts = [
    XTRANSLATOR_DOM.mountPlayer,
    XTRANSLATOR_DOM.mountTitle,
    XTRANSLATOR_DOM.mountDescription,
    XTRANSLATOR_DOM.mountCaption,
  ];
  documentNode
    .querySelectorAll<HTMLElement>(mounts.map((mount) => `[${XTRANSLATOR_DOM.mountAttribute}="${mount}"]`).join(","))
    .forEach((mount) => mount.remove());
}
