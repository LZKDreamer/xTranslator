// Defensive extraction of rendered comments from the live YouTube DOM.
//
// Per the page contract, comment data is *observed* — never fetched through a
// continuation API. YouTube's comment markup is not a stable public contract, so
// every read tries several fallbacks. A node without a real YouTube comment id or
// readable text is skipped: a derived id can collide after YouTube virtualizes a
// thread and would attach one comment's translation to another comment.

import { YOUTUBE_PAGE_SELECTOR } from "../../shared/youtube/youtube-page-contract";
import type { RenderedComment } from "../../shared/youtube/youtube-types";

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseReplyCount(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }
  return parseInt(value.trim(), 10);
}

function commentIdFromHref(href: string): string | null {
  try {
    const url = new URL(href, "https://www.youtube.com");
    const lc = url.searchParams.get("lc");
    return lc && lc.length > 0 ? lc : null;
  } catch {
    return null;
  }
}

function isOwnedByComment(node: Element, commentElement: Element): boolean {
  return node.closest(YOUTUBE_PAGE_SELECTOR.comment) === commentElement;
}

function closestAncestor<T extends Element>(element: Element, selector: string): T | null {
  let current = element.parentElement;
  while (current) {
    if (current.matches(selector)) {
      return current as unknown as T;
    }
    current = current.parentElement;
  }
  return null;
}

function findOwnedElement<T extends Element>(commentElement: Element, selector: string): T | null {
  return Array.from(commentElement.querySelectorAll<T>(selector)).find(
    (node) => isOwnedByComment(node, commentElement),
  ) ?? null;
}

export function findCommentsRoot(documentNode: Document): HTMLElement | null {
  const roots = Array.from(documentNode.querySelectorAll<HTMLElement>(YOUTUBE_PAGE_SELECTOR.commentsRoot));
  return roots.find((root) => root.querySelector(YOUTUBE_PAGE_SELECTOR.comment) !== null)
    ?? roots.find((root) => root.matches(YOUTUBE_PAGE_SELECTOR.shortsCommentsRoot))
    ?? roots[0]
    ?? null;
}

function extractCommentText(element: Element): string {
  const candidates = [
    YOUTUBE_PAGE_SELECTOR.commentContent,
    "#content yt-attributed-string",
    "#content .yt-core-attributed-string",
    "#content",
  ];
  for (const selector of candidates) {
    const node = findOwnedElement<HTMLElement>(element, selector);
    if (!node) {
      continue;
    }
    const text = normalizeText(node.textContent ?? "");
    if (text) {
      return text;
    }
  }
  return "";
}

function extractAuthor(element: Element): string {
  const author = findOwnedElement<HTMLElement>(element, YOUTUBE_PAGE_SELECTOR.commentAuthor);
  return author ? normalizeText(author.textContent ?? "") : "";
}

function extractCommentId(element: Element): string | null {
  const ownDataId = element.getAttribute("data-comment-id") ?? element.getAttribute("data-xtranslator-comment-id");
  if (ownDataId) {
    return ownDataId;
  }

  const permalink = findOwnedElement<HTMLAnchorElement>(element, YOUTUBE_PAGE_SELECTOR.commentPermalink);
  const fromPermalink = permalink?.href ? commentIdFromHref(permalink.href) : null;
  if (fromPermalink) {
    return fromPermalink;
  }

  const dataId = findOwnedElement<HTMLElement>(element, "[data-comment-id]")?.getAttribute("data-comment-id");
  if (dataId) {
    return dataId;
  }
  return null;
}

/**
 * Read one rendered YouTube comment into a `RenderedComment`. Returns null only when
 * the comment text cannot be read, so the caller can skip it without logging
 * anything sensitive.
 */
export function readComment(commentElement: Element): RenderedComment | null {
  const sourceText = extractCommentText(commentElement);
  if (!sourceText) {
    return null;
  }
  const authorName = extractAuthor(commentElement);
  const commentId = extractCommentId(commentElement);
  if (!commentId) {
    return null;
  }
  const isReply = Boolean(commentElement.closest(YOUTUBE_PAGE_SELECTOR.commentRepliesContainer));
  const parsedReplyCount = parseReplyCount(
    findOwnedElement<HTMLElement>(commentElement, YOUTUBE_PAGE_SELECTOR.commentReplyCount)?.textContent,
  );

  return {
    commentId,
    authorName,
    sourceText,
    ...(parsedReplyCount !== undefined ? { replyCount: parsedReplyCount } : {}),
    isReply,
  };
}

function findOutermostThread(threadElement: Element): HTMLElement {
  let outermost = threadElement as HTMLElement;
  let parent = closestAncestor<HTMLElement>(outermost, YOUTUBE_PAGE_SELECTOR.commentThread);
  while (parent) {
    outermost = parent;
    parent = closestAncestor<HTMLElement>(outermost, YOUTUBE_PAGE_SELECTOR.commentThread);
  }
  return outermost;
}

function findThreadComment(threadElement: Element): HTMLElement | null {
  return Array.from(threadElement.querySelectorAll<HTMLElement>(YOUTUBE_PAGE_SELECTOR.comment)).find(
    (element) => closestAncestor<HTMLElement>(element, YOUTUBE_PAGE_SELECTOR.commentThread) === threadElement,
  ) ?? null;
}

function findDirectCommentInSubThread(subThread: Element): HTMLElement | null {
  return Array.from(subThread.querySelectorAll<HTMLElement>(YOUTUBE_PAGE_SELECTOR.comment)).find(
    (element) => element.closest("yt-sub-thread") === subThread,
  ) ?? null;
}

/**
 * Collect one rendered thread recursively. YouTube represents a reply through
 * nested `ytd-comment-thread-renderer` and `yt-sub-thread` hosts. The latter
 * can contain sibling reply thread renderers, so the complete rendered tree is
 * collected first and parent ids are then derived from sub-thread ancestry.
 * Comment-id suffixes are intentionally never parsed.
 */
export function collectThreadComments(threadElement: Element): RenderedComment[] {
  const outermostThread = findOutermostThread(threadElement);
  const rootElement = findThreadComment(outermostThread);
  const rootComment = rootElement ? readComment(rootElement) : null;
  if (!rootElement || !rootComment) {
    return [];
  }

  const parsedComments = new Map<HTMLElement, RenderedComment>();
  for (const element of outermostThread.querySelectorAll<HTMLElement>(YOUTUBE_PAGE_SELECTOR.comment)) {
    const comment = readComment(element);
    if (comment) {
      parsedComments.set(element, comment);
    }
  }

  const comments: RenderedComment[] = [rootComment];
  for (const [element, comment] of parsedComments) {
    if (element === rootElement) {
      continue;
    }
    if (!comment.isReply) {
      // A second non-reply inside one outer thread is not a safe parent; skip it
      // instead of attaching it to a guessed root.
      continue;
    }

    const subThread = element.closest<HTMLElement>("yt-sub-thread");
    const parentSubThread = subThread ? closestAncestor<HTMLElement>(subThread, "yt-sub-thread") : null;
    const parentElement = parentSubThread
      ? findDirectCommentInSubThread(parentSubThread)
      : rootElement;
    const parentComment = parentElement ? parsedComments.get(parentElement) : undefined;
    if (!parentComment) {
      // A continuation may render a child before its parent; leave it out until
      // YouTube renders enough DOM to establish the relationship.
      continue;
    }
    comments.push({ ...comment, parentCommentId: parentComment.commentId });
  }

  if (comments[0]?.commentId !== rootComment.commentId) {
    return [];
  }
  return comments;
}
