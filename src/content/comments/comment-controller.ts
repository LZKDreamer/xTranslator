// Comment translation controller.
//
// It observes the live comment DOM (threads, expanding replies, scroll loading),
// only ever translating what YouTube has already rendered. It adds a "翻译可见评论"
// batch control on the comments header for comments in the current viewport, plus
// a thread-level translation action for a parent comment and its expanded replies.
// Each rendered
// comment keeps a stable state by id, so collapse/expand and scroll reloading
// never issue a duplicate request, and the translation is drawn *below* the
// original text node (the original is never rewritten).

import { isTranslateTextProgressMessage, isTranslateTextResponse, MESSAGE_TYPE } from "../../shared/contracts/messages";
import { createBrandMark } from "../../shared/brand-assets";
import type { TextTranslationItem } from "../../shared/translation/translation-types";
import { buildThread, collectCommentBranch, dedupeComments, commentsToTextItems } from "../../shared/youtube/comment-grouping";
import { XTRANSLATOR_DOM, YOUTUBE_PAGE_SELECTOR } from "../../shared/youtube/youtube-page-contract";
import type { RenderedComment } from "../../shared/youtube/youtube-types";
import { collectThreadComments, findCommentsRoot, readComment } from "./comment-dom";
import { t } from "../../shared/i18n";

type CommentLoadState = "idle" | "pending" | "done" | "failed";

const COMMENT_ID_ATTRIBUTE = "data-xtranslator-comment-id";
const MOUNT_COMMENT_TRANSLATION = XTRANSLATOR_DOM.mountCommentTranslation;
const MOUNT_COMMENT_CONTROL = XTRANSLATOR_DOM.mountCommentControl;
const MOUNT_BATCH_CONTROL = "comment-batch-control";
const SCROLL_IDLE_DELAY_MS = 150;
export class CommentTranslationController {
  private readonly commentState = new Map<string, CommentLoadState>();
  private readonly translatedTextById = new Map<string, string>();
  private readonly commentItemById = new Map<string, TextTranslationItem>();
  private observer: MutationObserver | null = null;
  private rootObserver: MutationObserver | null = null;
  private root: HTMLElement | null = null;
  private scanScheduled = false;
  private scanHandle: number | null = null;
  private scrollIdleHandle: number | null = null;
  private activeTranslationRunId: string | null = null;
  private activeTranslationButton: HTMLButtonElement | null = null;
  private readonly onScroll = (): void => this.requestScrollScan();
  private readonly onTextTranslationProgress = (message: unknown): void => {
    if (
      !isTranslateTextProgressMessage(message) ||
      message.scope !== "comment" ||
      message.runId !== this.activeTranslationRunId ||
      !this.activeTranslationButton
    ) {
      return;
    }
    this.setButtonState(
      this.activeTranslationButton,
      t("comment.translatingProgress", { completed: message.completed, total: message.total }),
      "loading",
    );
  };

  public constructor(private readonly documentNode: Document) {}

  public start(): void {
    this.documentNode.defaultView?.addEventListener("scroll", this.onScroll, true);
    if (typeof chrome !== "undefined") {
      chrome.runtime?.onMessage?.addListener(this.onTextTranslationProgress);
    }
    this.watchForRoot();
  }

  /** Re-attach on SPA video navigation, dropping the previous root and state. */
  public reset(): void {
    this.stop();
    this.start();
  }

  public stop(): void {
    this.documentNode.defaultView?.removeEventListener("scroll", this.onScroll, true);
    if (typeof chrome !== "undefined") {
      chrome.runtime?.onMessage?.removeListener(this.onTextTranslationProgress);
    }
    if (this.scanHandle !== null) {
      this.documentNode.defaultView?.cancelAnimationFrame(this.scanHandle);
      this.scanHandle = null;
    }
    if (this.scrollIdleHandle !== null) {
      this.documentNode.defaultView?.clearTimeout(this.scrollIdleHandle);
      this.scrollIdleHandle = null;
    }
    this.scanScheduled = false;
    this.observer?.disconnect();
    this.observer = null;
    this.rootObserver?.disconnect();
    this.rootObserver = null;
    this.root = null;
    this.commentState.clear();
    this.translatedTextById.clear();
    this.commentItemById.clear();
    this.activeTranslationRunId = null;
    this.activeTranslationButton = null;
    this.documentNode
      .querySelectorAll<HTMLElement>(
        `[${XTRANSLATOR_DOM.mountAttribute}="${MOUNT_COMMENT_TRANSLATION}"],` +
          `[${XTRANSLATOR_DOM.mountAttribute}="${MOUNT_COMMENT_CONTROL}"],` +
          `[${XTRANSLATOR_DOM.mountAttribute}="${MOUNT_BATCH_CONTROL}"]`,
      )
      .forEach((element) => element.remove());
  }

  private watchForRoot(): void {
    const root = findCommentsRoot(this.documentNode);
    if (root) {
      this.attachRoot(root);
    }
    this.rootObserver = new MutationObserver(() => {
      const found = findCommentsRoot(this.documentNode);
      if (found && found !== this.root) {
        this.attachRoot(found);
      }
    });
    this.rootObserver.observe(this.documentNode.documentElement, { childList: true, subtree: true });
  }

  private attachRoot(root: HTMLElement): void {
    this.observer?.disconnect();
    this.root = root;
    this.observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => this.isRelevantMutation(mutation))) {
        this.requestScan();
      }
    });
    this.observer.observe(root, { childList: true, subtree: true });
    this.runScan();
  }

  /**
   * Coalesce a burst of mutations into a single scan per animation frame, so the
   * controller never re-enters while YouTube is hydrating comments.
   */
  private requestScan(): void {
    if (this.scanScheduled || !this.root) {
      return;
    }
    this.scanScheduled = true;
    this.scanHandle = this.documentNode.defaultView?.requestAnimationFrame(() => {
      this.scanHandle = null;
      this.scanScheduled = false;
      this.runScan();
    }) ?? null;
  }

  /** Keep the control stable while the page is moving, then re-anchor at rest. */
  private requestScrollScan(): void {
    const view = this.documentNode.defaultView;
    if (!view || !this.root) {
      return;
    }
    if (this.scrollIdleHandle !== null) {
      view.clearTimeout(this.scrollIdleHandle);
    }
    this.scrollIdleHandle = view.setTimeout(() => {
      this.scrollIdleHandle = null;
      this.requestScan();
    }, SCROLL_IDLE_DELAY_MS);
  }

  private runScan(): void {
    if (!this.root) {
      return;
    }
    // Disconnect while we mutate so our own writes never re-trigger the observer
    // (which would loop the page). YouTube's own mutations during the synchronous
    // scan are impossible to lose because nothing else runs in between.
    this.mutate(() => this.scan(this.root!));
  }

  private mutate(apply: () => void): void {
    this.observer?.disconnect();
    try {
      apply();
    } finally {
      if (this.root) {
        this.observer?.observe(this.root, { childList: true, subtree: true });
      }
    }
  }

  private mountBatchControl(root: HTMLElement): void {
    // Self-heal: an earlier build inserted the batch button without the mount
    // attribute, so the guard below could not see it and duplicated it. Drop any
    // such orphan "翻译可见评论" buttons (which lack the mount marker) so the injected
    // controls never pile up; the correctly marked one is kept.
    root.querySelectorAll<HTMLElement>("button.xtranslator-comment-action").forEach((element) => {
      if (element.getAttribute(XTRANSLATOR_DOM.mountAttribute) !== MOUNT_BATCH_CONTROL) {
        const label = element.querySelector<HTMLElement>(".xtranslator-comment-action-label");
        if (label?.textContent?.startsWith(t("comment.translateVisiblePrefix"))) {
          element.remove();
        }
      }
    });

    let button = root.querySelector<HTMLButtonElement>(
      `[${XTRANSLATOR_DOM.mountAttribute}="${MOUNT_BATCH_CONTROL}"]`,
    );
    // While scrolling, an existing button stays in place. Moving it only after
    // a short idle period prevents the control from visibly jumping between rows.
    if (button && this.scrollIdleHandle !== null) {
      return;
    }
    const topLevelComments = this.collectCommentElements(root).filter(
      (comment) => !comment.closest(YOUTUBE_PAGE_SELECTOR.commentRepliesContainer),
    );
    // YouTube keeps older comments in the DOM while loading later pages. Anchor
    // the control to the first top-level comment currently in the viewport so it
    // follows the virtualized list instead of remaining above the user's view.
    const firstComment = topLevelComments.find((comment) => {
      const rect = comment.getBoundingClientRect();
      return rect.top >= 0 && rect.top < (this.documentNode.defaultView?.innerHeight ?? 0);
    }) ?? topLevelComments.find((comment) => this.isVisibleInViewport(comment)) ?? topLevelComments[0];
    if (!firstComment) {
      return;
    }
    const visibleCount = this.collectVisibleComments().length;
    if (!button) {
      button = this.createActionButton(
        t("comment.translateVisible", { count: visibleCount }),
        t("comment.translateVisibleAria", { count: visibleCount }),
      );
      button.setAttribute(XTRANSLATOR_DOM.mountAttribute, MOUNT_BATCH_CONTROL);
      button.addEventListener("click", () => void this.translateVisibleBatch(button!));
    } else if (button.dataset.state !== "loading" && button.dataset.state !== "error") {
      this.setActionButtonLabel(
        button,
        t("comment.translateVisible", { count: visibleCount }),
        t("comment.translateVisibleAria", { count: visibleCount }),
      );
    }
    // YouTube virtualizes the comment list. Keep the action beside the first
    // rendered top-level comment so loading a later page never strands the
    // control in an earlier, off-screen comments header.
    if (button.parentElement !== firstComment.parentElement || button.nextElementSibling !== firstComment) {
      firstComment.insertAdjacentElement("beforebegin", button);
    }
  }

  private scan(root: HTMLElement): void {
    this.mountBatchControl(root);
    const seen = new Set<string>();

    for (const element of this.collectCommentElements(root)) {
      const comment = readComment(element);
      if (!comment || seen.has(comment.commentId)) {
        continue;
      }
      seen.add(comment.commentId);
      if (element.getAttribute(COMMENT_ID_ATTRIBUTE) !== comment.commentId) {
        element.setAttribute(COMMENT_ID_ATTRIBUTE, comment.commentId);
      }
      this.ensureCommentMounted(element, comment, this.collectThreadAround(element));
    }
  }

  private collectCommentElements(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(YOUTUBE_PAGE_SELECTOR.comment));
  }

  /**
   * Best-effort thread grouping: when the comment sits inside a known thread
   * container, return every comment in it (parent + expanded replies); otherwise
   * return the single comment so single/batch translation still works.
   */
  private collectThreadAround(commentElement: HTMLElement): RenderedComment[] {
    const thread = commentElement.closest<HTMLElement>(YOUTUBE_PAGE_SELECTOR.commentThread);
    if (!thread) {
      return [readComment(commentElement)].filter((comment): comment is RenderedComment => comment !== null);
    }
    return collectThreadComments(thread);
  }

  private ensureCommentMounted(
    commentElement: HTMLElement,
    comment: RenderedComment,
    threadComments: RenderedComment[],
  ): void {
    this.commentItemById.set(comment.commentId, { id: comment.commentId, sourceText: comment.sourceText });
    const state = this.commentState.get(comment.commentId) ?? "idle";
    if (state !== "idle") {
      // Already handled or in flight; re-render any stored translation, never re-request.
      this.renderStoredTranslation(commentElement, comment.commentId);
    } else {
      this.commentState.set(comment.commentId, "idle");
    }
    // A thread can receive a batch translation before its replies are expanded.
    // Keep evaluating controls so its thread action appears as soon as YouTube
    // renders those replies.
    this.mountCommentControls(commentElement, comment, threadComments);
  }

  private mountCommentControls(
    commentElement: HTMLElement,
    comment: RenderedComment,
    threadComments: RenderedComment[],
  ): void {
    const group = buildThread(threadComments, comment.commentId);
    const isThreadRootWithReplies = group?.root.commentId === comment.commentId && group.replies.length > 0;

    if (!isThreadRootWithReplies) {
      // No complete rendered thread to translate (this is a reply, a standalone
      // comment, or a root whose replies are still collapsed). The batch covers
      // visible comments and YouTube owns the reply expand/collapse control.
      commentElement
        .querySelector(`[${XTRANSLATOR_DOM.mountAttribute}="${MOUNT_COMMENT_CONTROL}"]`)
        ?.remove();
      return;
    }

    let row = commentElement.querySelector<HTMLElement>(
      `[${XTRANSLATOR_DOM.mountAttribute}="${MOUNT_COMMENT_CONTROL}"]`,
    );
    if (!row) {
      row = this.documentNode.createElement("div");
      row.className = "xtranslator-comment-controls";
      row.setAttribute(XTRANSLATOR_DOM.mountAttribute, MOUNT_COMMENT_CONTROL);
      row.setAttribute(COMMENT_ID_ATTRIBUTE, comment.commentId);
      const toolbar = commentElement.querySelector<HTMLElement>("#toolbar");
      if (toolbar) {
        toolbar.insertAdjacentElement("afterend", row);
      } else {
        commentElement.append(row);
      }
    }

    // A prior build exposed an icon-only reply toggle beside this label. Remove
    // that injected control when the current script takes over; reply expansion
    // belongs to YouTube and the entire xTranslator button translates the thread.
    row.querySelectorAll<HTMLElement>('[data-action="thread-toggle"], .xtranslator-comment-thread-label').forEach(
      (element) => element.remove(),
    );
    const threadButtonCount = comment.isReply ? group.replies.length : threadComments.length;

    if (!row.querySelector('[data-action="thread"]')) {
      const threadButton = this.createActionButton(
        t("comment.translateThread", { count: threadButtonCount }),
        t("comment.translateThreadAria", { count: threadButtonCount }),
      );
      threadButton.dataset.action = "thread";
      // YouTube delegates reply toggles from the thread container. Do not let an
      // interaction with our button bubble into that handler.
      threadButton.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
      threadButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void this.translateCurrentThread(commentElement, threadButton);
      }, true);
      row.append(threadButton);
    } else {
      const threadButton = row.querySelector<HTMLButtonElement>('[data-action="thread"]');
      if (threadButton && threadButton.dataset.state !== "loading" && threadButton.dataset.state !== "error") {
        this.setActionButtonLabel(
          threadButton,
          t("comment.translateThread", { count: threadButtonCount }),
          t("comment.translateThreadAria", { count: threadButtonCount }),
        );
      }
    }
  }

  private async translateCurrentThread(commentElement: HTMLElement, button: HTMLButtonElement): Promise<void> {
    // YouTube replaces reply elements while collapsing/expanding. Read the
    // current rendered thread at click time instead of retaining the scan-time
    // snapshot captured when this button was first mounted.
    const allThreadComments = dedupeComments(this.collectThreadAround(commentElement));
    const commentId = commentElement.getAttribute(COMMENT_ID_ATTRIBUTE);
    const threadComments = commentId ? collectCommentBranch(allThreadComments, commentId) : [];
    const group = commentId ? buildThread(threadComments, commentId) : null;
    if (!group || group.replies.length === 0) {
      this.setButtonState(button, t("comment.noExpandedReplies"), "error");
      const threadButtonCount = group?.root.isReply ? group.replies.length : threadComments.length;
      this.documentNode.defaultView?.setTimeout(
        () => this.setActionButtonLabel(
          button,
          t("comment.translateThread", { count: threadButtonCount }),
          t("comment.translateThreadAria", { count: threadButtonCount }),
        ),
        1800,
      );
      return;
    }
    await this.requestTranslation(
      commentsToTextItems(threadComments),
      button,
      t("comment.translatedThread", {
        count: group.root.isReply ? group.replies.length : threadComments.length,
      }),
    );
  }

  private async translateVisibleBatch(button: HTMLButtonElement): Promise<void> {
    const all = this.collectVisibleComments();
    const candidates = dedupeComments(
      all.filter((comment) => {
        const state = this.commentState.get(comment.commentId);
        return state === undefined || state === "idle" || state === "failed";
      }),
    );

    if (candidates.length === 0) {
      // Surface feedback instead of silently doing nothing, so an extraction miss
      // is visible. Reset to the idle label shortly after.
      this.setButtonState(
        button,
        all.length > 0
          ? t("comment.translatedVisible", { count: all.length })
          : t("comment.noTranslatableComments"),
        "done",
      );
      return;
    }
    await this.requestTranslation(
      commentsToTextItems(candidates),
      button,
      t("comment.translatedVisible", { count: candidates.length }),
    );
  }

  private collectVisibleComments(): RenderedComment[] {
    if (!this.root) {
      return [];
    }
    const all: RenderedComment[] = [];
    const seen = new Set<string>();
    for (const element of this.collectCommentElements(this.root)) {
      if (!this.isVisibleInViewport(element)) {
        continue;
      }
      const comment = readComment(element);
      if (!comment || seen.has(comment.commentId)) {
        continue;
      }
      seen.add(comment.commentId);
      all.push(comment);
    }
    return all;
  }

  private isVisibleInViewport(element: HTMLElement): boolean {
    const view = this.documentNode.defaultView;
    if (!view) {
      return true;
    }
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < view.innerHeight;
  }

  private isRelevantMutation(mutation: MutationRecord): boolean {
    const target = mutation.target instanceof Element ? mutation.target : null;
    if (target?.closest(`[${XTRANSLATOR_DOM.mountAttribute}]`)) {
      return false;
    }
    const isCommentStructure = (node: Node): boolean => {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) {
        return false;
      }
      return (
        element.matches(YOUTUBE_PAGE_SELECTOR.comment) ||
        element.matches(YOUTUBE_PAGE_SELECTOR.commentHeader) ||
        element.querySelector(YOUTUBE_PAGE_SELECTOR.comment) !== null ||
        element.querySelector(YOUTUBE_PAGE_SELECTOR.commentHeader) !== null ||
        element.closest(YOUTUBE_PAGE_SELECTOR.comment) !== null
      );
    };
    return Array.from(mutation.addedNodes).some(isCommentStructure) || Array.from(mutation.removedNodes).some(isCommentStructure);
  }

  private async requestTranslation(
    items: TextTranslationItem[],
    button: HTMLButtonElement | null,
    doneLabel = t("comment.translatedVisible", { count: 0 }),
  ): Promise<void> {
    const fresh: TextTranslationItem[] = [];
    for (const item of items) {
      const state = this.commentState.get(item.id);
      if (state === "pending" || state === "done") {
        continue;
      }
      this.commentState.set(item.id, "pending");
      fresh.push(item);
    }

    if (fresh.length === 0) {
      return;
    }

    if (button) {
      this.setButtonState(button, t("comment.translatingProgress", { completed: 0, total: fresh.length }), "loading");
    }
    const runId = `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.activeTranslationRunId = runId;
    this.activeTranslationButton = button;
    try {
      const videoTitle = this.getVideoTitle();
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.translateText,
        runId,
        scope: "comment",
        items: fresh,
        ...(videoTitle ? { videoTitle } : {}),
      });
      if (!isTranslateTextResponse(response)) {
        throw new Error("Invalid translate-text response.");
      }
      if (!response.ok) {
        throw new Error(response.errorMessage);
      }
      const failedIds = new Set(response.missingIds);
      const skippedIds = new Set(response.skippedIds ?? []);
      let hasFailure = false;
      for (const item of fresh) {
        if (skippedIds.has(item.id)) {
          this.commentState.set(item.id, "done");
          this.removeTranslation(item.id);
          continue;
        }
        const translated = response.translations[item.id];
        if (!failedIds.has(item.id) && typeof translated === "string" && translated.trim().length > 0) {
          this.translatedTextById.set(item.id, translated);
          this.commentState.set(item.id, "done");
          this.renderTranslation(item.id, translated, "done");
        } else {
          hasFailure = true;
          this.commentState.set(item.id, "failed");
          this.renderTranslation(item.id, "", "failed");
        }
      }
      if (button) {
        this.setButtonState(
          button,
          hasFailure
            ? t("comment.retryIncompleteCount", { count: fresh.filter((item) => failedIds.has(item.id)).length })
            : doneLabel,
          hasFailure ? "error" : "done",
        );
      }
    } catch {
      // Keep every item retryable. A provider failure must not make successful
      // comments look untranslated or strand a failed comment without an action.
      for (const item of fresh) {
        this.commentState.set(item.id, "failed");
        this.renderTranslation(item.id, "", "failed");
      }
      if (button) {
        this.setButtonState(button, t("comment.retryIncompleteCount", { count: fresh.length }), "error");
      }
    } finally {
      if (this.activeTranslationRunId === runId) {
        this.activeTranslationRunId = null;
        this.activeTranslationButton = null;
      }
    }
  }

  private getVideoTitle(): string | undefined {
    const title = this.documentNode.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.title)?.textContent?.trim();
    return title || undefined;
  }

  private renderStoredTranslation(commentElement: HTMLElement, commentId: string): void {
    const translated = this.translatedTextById.get(commentId);
    const state = this.commentState.get(commentId);
    if (translated === undefined && state !== "failed") {
      return;
    }
    this.renderTranslation(commentId, translated ?? "", state === "failed" ? "failed" : "done");
  }

  private removeTranslation(commentId: string): void {
    const commentElement = this.collectCommentElements(this.root ?? this.documentNode.documentElement).find(
      (element) => element.getAttribute(COMMENT_ID_ATTRIBUTE) === commentId,
    );
    commentElement
      ?.querySelector<HTMLElement>(`[${XTRANSLATOR_DOM.mountAttribute}="${MOUNT_COMMENT_TRANSLATION}"]`)
      ?.remove();
  }

  private renderTranslation(commentId: string, translated: string, state: "done" | "failed"): void {
    const commentElement = this.collectCommentElements(this.root ?? this.documentNode.documentElement).find(
      (element) => element.getAttribute(COMMENT_ID_ATTRIBUTE) === commentId,
    );
    if (!commentElement) {
      return;
    }
    const textElement = commentElement.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.commentContent);
    if (!textElement) {
      return;
    }
    // YouTube clips long comments inside #content. Put our result after the
    // expander rather than immediately after #content-text, otherwise the
    // translation is also hidden until the user clicks "了解详情".
    const translationAnchor =
      commentElement.querySelector<HTMLElement>(YOUTUBE_PAGE_SELECTOR.commentExpander) ??
      textElement.closest<HTMLElement>(YOUTUBE_PAGE_SELECTOR.commentContentContainer) ??
      textElement;
    let node = commentElement.querySelector<HTMLElement>(
      `[${XTRANSLATOR_DOM.mountAttribute}="${MOUNT_COMMENT_TRANSLATION}"]`,
    );
    if (!node) {
      node = this.documentNode.createElement("div");
      node.className = "xtranslator-comment-translation";
      node.setAttribute(XTRANSLATOR_DOM.mountAttribute, MOUNT_COMMENT_TRANSLATION);
    }
    if (translationAnchor.nextElementSibling !== node) {
      translationAnchor.insertAdjacentElement("afterend", node);
    }
    node.dataset.state = state;
    if (state === "failed") {
      const existingRetryButton = node.querySelector<HTMLButtonElement>('[data-action="comment-retry"]');
      if (existingRetryButton) {
        existingRetryButton.textContent = t("comment.translationFailedRetry");
        existingRetryButton.dataset.state = "error";
        existingRetryButton.disabled = false;
        existingRetryButton.setAttribute("aria-busy", "false");
        return;
      }

      const retryButton = this.documentNode.createElement("button");
      retryButton.className = "xtranslator-comment-retry";
      retryButton.type = "button";
      retryButton.dataset.action = "comment-retry";
      retryButton.setAttribute("aria-label", t("comment.retryComment", { id: commentId }));
      retryButton.textContent = t("comment.translationFailedRetry");
      retryButton.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
      retryButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const item = this.commentItemById.get(commentId);
        if (!item) {
          return;
        }
        this.setButtonState(retryButton, t("comment.translatingProgress", { completed: 0, total: 1 }), "loading");
        void this.requestTranslation([item], retryButton, t("comment.retried"));
      }, true);
      node.replaceChildren(retryButton);
      return;
    }

    const text = translated;
    // Writing textContent is itself a childList mutation watched by our observer;
    // guard it so an unchanged value never re-triggers scan() -> renderTranslation()
    // (which would loop the page to a halt).
    if (node.textContent !== text || node.querySelector('[data-action="comment-retry"]')) {
      node.replaceChildren(this.documentNode.createTextNode(text));
    }
  }

  private createActionButton(label: string, ariaLabel: string): HTMLButtonElement {
    const button = this.documentNode.createElement("button");
    button.className = "xtranslator-comment-action";
    button.type = "button";
    button.setAttribute("aria-label", ariaLabel);
    button.append(createBrandMark(this.documentNode, "light", 16));
    const labelElement = this.documentNode.createElement("span");
    labelElement.className = "xtranslator-comment-action-label";
    labelElement.textContent = label;
    button.append(labelElement);
    return button;
  }

  private setActionButtonLabel(button: HTMLButtonElement, label: string, ariaLabel: string): void {
    const labelElement = button.querySelector<HTMLElement>(".xtranslator-comment-action-label");
    if (labelElement) {
      labelElement.textContent = label;
    } else {
      button.textContent = label;
    }
    button.setAttribute("aria-label", ariaLabel);
  }

  private setButtonState(button: HTMLButtonElement, label: string, state: "loading" | "done" | "error"): void {
    this.setActionButtonLabel(button, label, label);
    button.dataset.state = state;
    button.disabled = state === "loading";
    button.setAttribute("aria-busy", state === "loading" ? "true" : "false");
  }
}
