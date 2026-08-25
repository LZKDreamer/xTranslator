// Pure helpers for the comment-translation feature.
//
// Comment DOM extraction lives in the content script (it needs the live DOM, which
// is only smoke-tested); everything here is side-effect free and unit-tested:
// deduplicating by a stable comment id (so collapse/expand and scroll-loading never
// request a comment twice) and grouping a thread into its parent + replies.

import type { TextTranslationItem } from "../translation/translation-types";
import type { RenderedComment } from "./youtube-types";

/** Keep first occurrence per stable comment id, preserving input order. */
export function dedupeComments(comments: readonly RenderedComment[]): RenderedComment[] {
  const seen = new Set<string>();
  const result: RenderedComment[] = [];
  for (const comment of comments) {
    if (seen.has(comment.commentId)) {
      continue;
    }
    seen.add(comment.commentId);
    result.push(comment);
  }
  return result;
}

export interface CommentThread {
  root: RenderedComment;
  replies: RenderedComment[];
}

/**
 * Group a flat list of rendered comments (from one thread container) into the
 * parent comment and its replies. Returns null when there is no non-reply root.
 */
export function buildThread(comments: readonly RenderedComment[], rootCommentId?: string): CommentThread | null {
  const root = rootCommentId
    ? comments.find((comment) => comment.commentId === rootCommentId)
    : comments.find((comment) => !comment.isReply);
  if (!root) {
    return null;
  }
  const replies = comments.filter((comment) => comment.isReply && comment.parentCommentId === root.commentId);
  return { root, replies };
}

/** Return one comment and every rendered descendant in DOM order. */
export function collectCommentBranch(
  comments: readonly RenderedComment[],
  rootCommentId: string,
): RenderedComment[] {
  const root = comments.find((comment) => comment.commentId === rootCommentId);
  if (!root) {
    return [];
  }

  const childrenByParent = new Map<string, RenderedComment[]>();
  for (const comment of comments) {
    if (!comment.parentCommentId) {
      continue;
    }
    const children = childrenByParent.get(comment.parentCommentId) ?? [];
    children.push(comment);
    childrenByParent.set(comment.parentCommentId, children);
  }

  const result: RenderedComment[] = [];
  const visited = new Set<string>();
  const append = (comment: RenderedComment): void => {
    if (visited.has(comment.commentId)) {
      return;
    }
    visited.add(comment.commentId);
    result.push(comment);
    for (const child of childrenByParent.get(comment.commentId) ?? []) {
      append(child);
    }
  };
  append(root);
  return result;
}

export function commentToTextItem(comment: RenderedComment): TextTranslationItem {
  return { id: comment.commentId, sourceText: comment.sourceText };
}

export function commentsToTextItems(comments: readonly RenderedComment[]): TextTranslationItem[] {
  return comments.map((comment) => commentToTextItem(comment));
}
