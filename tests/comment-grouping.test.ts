import { describe, expect, it } from "vitest";
import { buildThread, collectCommentBranch, commentToTextItem, commentsToTextItems, dedupeComments } from "../src/shared/youtube/comment-grouping";
import type { RenderedComment } from "../src/shared/youtube/youtube-types";

const root: RenderedComment = { commentId: "root", authorName: "A", sourceText: "hello", isReply: false };
const reply: RenderedComment = { commentId: "rep", authorName: "B", sourceText: "world", isReply: true, parentCommentId: "root" };
const orphan: RenderedComment = { commentId: "orphan", authorName: "C", sourceText: "hi", isReply: true, parentCommentId: "missing" };

describe("comment grouping", () => {
  it("dedupes by stable comment id while preserving order", () => {
    expect(dedupeComments([root, reply, root, orphan, reply])).toEqual([root, reply, orphan]);
  });

  it("groups a thread into its root and replies", () => {
    const group = buildThread([reply, root]);
    expect(group).toEqual({ root, replies: [reply] });
    expect(buildThread([orphan])).toBeNull();
  });

  it("groups a reply as the root of its own nested thread", () => {
    const nestedRoot: RenderedComment = {
      commentId: "nested-root",
      authorName: "B",
      sourceText: "nested",
      isReply: true,
      parentCommentId: "root",
    };
    const nestedReply: RenderedComment = {
      commentId: "nested-reply",
      authorName: "C",
      sourceText: "nested reply",
      isReply: true,
      parentCommentId: "nested-root",
    };

    expect(buildThread([nestedRoot, nestedReply], "nested-root")).toEqual({
      root: nestedRoot,
      replies: [nestedReply],
    });
    expect(collectCommentBranch([root, nestedRoot, nestedReply], "nested-root")).toEqual([
      nestedRoot,
      nestedReply,
    ]);
  });

  it("maps comments to text items with the comment id", () => {
    expect(commentToTextItem(root)).toEqual({ id: "root", sourceText: "hello" });
    expect(commentsToTextItems([reply, root])).toEqual([
      { id: "rep", sourceText: "world" },
      { id: "root", sourceText: "hello" },
    ]);
  });
});
