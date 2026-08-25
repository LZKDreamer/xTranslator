// Selection translation controller ("划词").
//
// Reads the live DOM selection and shows a lightweight glass pill near it
// (翻译 / 复制 / 关闭). Translating shows a result panel with the translation
// (复制 / 关闭), reachable through the pill and through the right-click context
// menu (which the service worker forwards as a message). The original text node
// is never modified: the pill and result are always separate overlays appended to
// the document body. Esc closes the overlay.

import { isSettingsMessageResponse, isTranslateTextResponse, MESSAGE_TYPE } from "../../shared/contracts/messages";
import { Check, CircleAlert, Copy, createElement, LoaderCircle, MousePointer2, X } from "../../shared/icons";
import { extractSentenceContext } from "../../shared/selection/selection-context";
import { XTRANSLATOR_DOM } from "../../shared/youtube/youtube-page-contract";

const PILL_CLASS = "xtranslator-selection-pill";
const RESULT_CLASS = "xtranslator-selection-result";
const MOUNT_SELECTION = XTRANSLATOR_DOM.mountSelection;
const SELECTION_DEBOUNCE_MS = 280;

export class SelectionController {
  private pill: HTMLElement | null = null;
  private result: HTMLElement | null = null;
  private nextItemId = 0;
  private selectionEnabled = true;
  private showPillTimer: number | null = null;

  public constructor(private readonly documentNode: Document) {}

  public start(): void {
    this.documentNode.addEventListener("mouseup", this.onMouseUp);
    this.documentNode.addEventListener("keyup", this.onKeyUp);
    this.documentNode.addEventListener("scroll", this.hideOverlays, true);
    this.documentNode.defaultView?.addEventListener("blur", this.hideOverlays);
    void this.loadSelectionSettings();

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === "local" && changes.settings) {
          void this.loadSelectionSettings();
        }
      });
    }

    typeof chrome !== "undefined" &&
      chrome.runtime.onMessage.addListener((message: unknown) => {
        if (
          this.selectionEnabled &&
          message &&
          (message as { type?: string }).type === MESSAGE_TYPE.translateSelectionFromContext
        ) {
          void this.translateCurrentSelection();
        }
        return false;
      });
  }

  private onMouseUp = (event: MouseEvent): void => {
    if (!this.selectionEnabled) {
      return;
    }
    // A click inside our own pill/result must not re-run showPill(), which would
    // remove the just-created result panel (making the translation flash and
    // vanish). Only page selections drive the pill.
    if (this.isOwnOverlay(event.target as Node | null)) {
      return;
    }
    this.scheduleShowPill();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (!this.selectionEnabled) {
      return;
    }
    if (this.isOwnOverlay(event.target as Node | null)) {
      return;
    }
    this.scheduleShowPill();
  };

  private isOwnOverlay(node: Node | null): boolean {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    return Boolean((node as Element).closest(`.${PILL_CLASS}, .${RESULT_CLASS}`));
  }

  private scheduleShowPill(): void {
    if (!this.selectionEnabled) {
      return;
    }
    if (this.showPillTimer !== null) {
      this.documentNode.defaultView?.clearTimeout(this.showPillTimer);
    }
    const timer = this.documentNode.defaultView?.setTimeout(() => {
      this.showPillTimer = null;
      if (this.selectionEnabled) {
        this.showPill();
      }
    }, SELECTION_DEBOUNCE_MS);
    this.showPillTimer = timer ?? null;
  }

  private readSelection(): { text: string; range: Range; rect: DOMRect } | null {
    const selection = this.documentNode.defaultView?.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const text = selection.toString().trim();
    if (!text) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return null;
    }
    return { text, range, rect };
  }

  private showPill(): void {
    const selection = this.readSelection();
    if (!selection) {
      this.hideOverlays();
      return;
    }
    this.result?.remove();
    this.result = null;

    if (!this.pill || !this.pill.isConnected) {
      this.pill = this.buildPill();
    }
    this.pill.hidden = false;
    this.position(this.pill, selection.rect);
  }

  private buildPill(): HTMLElement {
    const pill = this.documentNode.createElement("div");
    pill.className = PILL_CLASS;
    pill.setAttribute(XTRANSLATOR_DOM.mountAttribute, MOUNT_SELECTION);
    pill.setAttribute("role", "toolbar");
    pill.setAttribute("aria-label", "划词翻译");

    const translate = this.documentNode.createElement("button");
    translate.className = "xtranslator-selection-action xtranslator-selection-primary";
    translate.type = "button";
    translate.dataset.action = "translate";
    translate.setAttribute("aria-label", "翻译所选文本");
    translate.append(createElement(MousePointer2), this.documentNode.createTextNode("翻译"));
    translate.addEventListener("click", () => void this.translateCurrentSelection());

    const copy = this.documentNode.createElement("button");
    copy.className = "xtranslator-selection-action";
    copy.type = "button";
    copy.dataset.action = "copy";
    copy.setAttribute("aria-label", "复制所选文本");
    copy.append(createElement(Copy));
    copy.addEventListener("click", () => this.copySelection());

    const close = this.documentNode.createElement("button");
    close.className = "xtranslator-selection-action";
    close.type = "button";
    close.dataset.action = "close";
    close.setAttribute("aria-label", "关闭划词浮层");
    close.append(createElement(X));
    close.addEventListener("click", () => this.hideOverlays());

    pill.append(translate, copy, close);
    this.documentNode.body.append(pill);
    return pill;
  }

  private async copySelection(): Promise<void> {
    const text = this.documentNode.defaultView?.getSelection()?.toString() ?? "";
    if (text) {
      await this.copyText(text);
    }
  }

  private async copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      const textarea = this.documentNode.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      this.documentNode.body.append(textarea);
      textarea.select();
      this.documentNode.execCommand("copy");
      textarea.remove();
    }
  }

  private buildSelectionItem(): { id: string; sourceText: string; contextBefore?: string; contextAfter?: string } | null {
    const selection = this.readSelection();
    if (!selection) {
      return null;
    }
    const includeContext = this.includeContext();
    const id = `sel-${this.nextItemId += 1}`;

    if (includeContext) {
      const context = this.singleNodeContext(selection.range);
      if (context) {
        return { id, sourceText: selection.text, ...(context.contextBefore ? { contextBefore: context.contextBefore } : {}), ...(context.contextAfter ? { contextAfter: context.contextAfter } : {}) };
      }
    }
    return { id, sourceText: selection.text };
  }

  private singleNodeContext(
    range: Range,
  ): { contextBefore?: string; contextAfter?: string } | null {
    const startNode = range.startContainer;
    const endNode = range.endContainer;
    if (startNode !== endNode || startNode.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    const fullText = startNode.textContent ?? "";
    return extractSentenceContext(fullText, range.startOffset, range.endOffset);
  }

  private includeContext(): boolean {
    // The option is read from settings; a failure to read defaults to false so the
    // user's explicit "只发送选区" choice is the safe default.
    return this.includeContextSetting;
  }

  private includeContextSetting = false;

  private async loadIncludeContext(): Promise<void> {
    await this.loadSelectionSettings();
  }

  private async loadSelectionSettings(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.getSettings });
      if (isSettingsMessageResponse(response)) {
        const enabled = response.settings.selection.enabled;
        if (!enabled) {
          this.hideOverlays();
        }
        this.selectionEnabled = enabled;
        this.includeContextSetting = response.settings.selection.includeContext;
      }
    } catch {
      // Keep the default.
    }
  }

  private async translateCurrentSelection(): Promise<void> {
    if (!this.selectionEnabled) {
      return;
    }
    await this.loadIncludeContext();
    if (!this.selectionEnabled) {
      return;
    }
    const item = this.buildSelectionItem();
    if (!item) {
      return;
    }

    const anchor = this.currentSelectionRect();
    const result = this.showResultPanel(anchor);
    // Once the result panel is up it owns the surface, so drop the pill to avoid
    // two overlays stacked on the selection.
    this.pill?.remove();
    this.pill = null;
    this.setResultState(result, "loading", "正在翻译…");

    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE.translateText,
        scope: "selection",
        items: [item],
      });
      if (!isTranslateTextResponse(response)) {
        throw new Error("Invalid translate-text response.");
      }
      if (!response.ok) {
        throw new Error(response.errorMessage);
      }
      const translated = response.translations[item.id];
      if (typeof translated !== "string") {
        throw new Error("Missing translation.");
      }
      this.setResultText(result, translated);
    } catch {
      this.setResultState(result, "error", "翻译失败，请重试。");
    }
  }

  private currentSelectionRect(): DOMRect | null {
    const selection = this.readSelection();
    return selection?.rect ?? null;
  }

  private showResultPanel(anchor: DOMRect | null): HTMLElement {
    // Reuse an existing result panel if it is already open.
    if (this.result && this.result.isConnected) {
      this.position(this.result, anchor);
      return this.result;
    }
    const panel = this.documentNode.createElement("div");
    panel.className = RESULT_CLASS;
    panel.setAttribute(XTRANSLATOR_DOM.mountAttribute, MOUNT_SELECTION);

    const content = this.documentNode.createElement("div");
    content.className = "xtranslator-selection-result-text";

    const actions = this.documentNode.createElement("div");
    actions.className = "xtranslator-selection-result-actions";

    const copy = this.documentNode.createElement("button");
    copy.className = "xtranslator-selection-action";
    copy.type = "button";
    copy.dataset.action = "copy-result";
    copy.setAttribute("aria-label", "复制译文");
    copy.append(createElement(Copy));
    copy.addEventListener("click", () => void this.copyResultText(panel));

    const close = this.documentNode.createElement("button");
    close.className = "xtranslator-selection-action";
    close.type = "button";
    close.setAttribute("aria-label", "关闭译文面板");
    close.append(createElement(X));
    close.addEventListener("click", () => this.hideOverlays());

    actions.append(copy, close);
    panel.append(content, actions);
    this.documentNode.body.append(panel);
    this.result = panel;
    this.position(panel, anchor);
    return panel;
  }

  private async copyResultText(panel: HTMLElement): Promise<void> {
    const text = panel.querySelector<HTMLElement>(".xtranslator-selection-result-text")?.textContent ?? "";
    if (text) {
      await this.copyText(text);
      const copyButton = panel.querySelector<HTMLButtonElement>('[data-action="copy-result"]');
      if (copyButton) {
        copyButton.replaceChildren(createElement(Check));
        this.documentNode.defaultView?.setTimeout(() => copyButton.replaceChildren(createElement(Copy)), 1200);
      }
    }
  }

  private setResultState(panel: HTMLElement, state: "loading" | "error" | "done", message: string): void {
    panel.dataset.state = state;
    const content = panel.querySelector<HTMLElement>(".xtranslator-selection-result-text");
    if (content) {
      content.replaceChildren();
      if (state === "loading") {
        content.append(createElement(LoaderCircle), this.documentNode.createTextNode(message));
      } else if (state === "error") {
        content.append(createElement(CircleAlert), this.documentNode.createTextNode(message));
      } else {
        content.textContent = message;
      }
    }
  }

  private setResultText(panel: HTMLElement, translated: string): void {
    panel.dataset.state = "done";
    const content = panel.querySelector<HTMLElement>(".xtranslator-selection-result-text");
    if (content) {
      content.replaceChildren();
      content.textContent = translated;
    }
  }

  private position(element: HTMLElement, anchor: DOMRect | null): void {
    const viewport = this.documentNode.defaultView;
    if (!viewport) {
      return;
    }
    element.style.left = "0px";
    element.style.top = "0px";
    element.style.transform = "translateY(0)";
    const rect = element.getBoundingClientRect();
    const margin = 8;
    const anchorRect = anchor ?? rect;
    let left = anchorRect.left + margin;
    let top = anchorRect.bottom + margin;
    left = Math.max(margin, Math.min(left, viewport.innerWidth - rect.width - margin));
    if (top + rect.height > viewport.innerHeight - margin) {
      top = Math.max(margin, anchorRect.top - rect.height - margin);
    }
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  private hideOverlays = (): void => {
    if (this.showPillTimer !== null) {
      this.documentNode.defaultView?.clearTimeout(this.showPillTimer);
      this.showPillTimer = null;
    }
    this.pill?.remove();
    this.pill = null;
    this.result?.remove();
    this.result = null;
  };
}
