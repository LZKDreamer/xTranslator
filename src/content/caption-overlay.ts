// Timeline-synced caption overlay.
//
// After a video is translated, the translated (or bilingual) subtitle is rendered
// in the caption position as the video plays, keyed to the block's timeline range.
// While the overlay is active the player's native caption window is suppressed
// (`visibility: hidden`) so the user sees *our* subtitle instead of the original.
//
// In bilingual mode the translated line (yellow) is shown on top and the
// (cleaned) source text below — the LLM has already merged fragmented ASR and
// dropped non-verbal markers, so these are coherent subtitle lines.

import type { TranslatedBlock } from "../shared/translation/translation-types";
import type { CaptionDisplayMode } from "../shared/contracts/settings";
import { XTRANSLATOR_DOM } from "../shared/youtube/youtube-page-contract";

export const CAPTION_SUPPRESSED_CLASS = "xtranslator-captions-suppressed";

export interface TimedBlock {
  id: string;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
}

interface CaptionLine {
  text: string;
  className: string;
}

export function toTimedBlocks(blocks: readonly TranslatedBlock[]): TimedBlock[] {
  const sorted = blocks
    .map((block) => ({
      id: block.id,
      startMs: Number.isFinite(block.startMs) ? Math.max(0, block.startMs) : 0,
      endMs: Number.isFinite(block.endMs) ? Math.max(0, block.endMs) : 0,
      sourceText: block.sourceText.replace(/\r?\n+/gu, " ").replace(/[ \t]+/gu, " ").trim(),
      translatedText: block.translatedText.replace(/\r?\n+/gu, " ").replace(/[ \t]+/gu, " ").trim(),
    }))
    .filter((block) => block.endMs > block.startMs && (block.sourceText.length > 0 || block.translatedText.length > 0))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const result: TimedBlock[] = [];
  for (const block of sorted) {
    const previous = result[result.length - 1];
    if (previous && previous.endMs > block.startMs) {
      // Preserve the later block's original audio anchor. Only shorten the
      // preceding visual window instead of delaying the next subtitle.
      previous.endMs = block.startMs;
      if (previous.endMs <= previous.startMs) {
        result.pop();
      }
    }
    if (block.endMs <= block.startMs) {
      continue;
    }
    result.push({ ...block });
  }
  return result;
}

export class CaptionOverlayController {
  private overlay: HTMLDivElement | null = null;
  private frame: number | null = null;
  private video: HTMLVideoElement | null = null;
  private blocks: TimedBlock[] = [];
  private mode: CaptionDisplayMode = "bilingual";
  private nativeCaptionObserver: MutationObserver | null = null;

  public constructor(
    private readonly documentNode: Document,
    private readonly player: Element,
  ) {}

  /** Provide translated blocks and start showing them. */
  public load(blocks: readonly TranslatedBlock[]): void {
    this.blocks = toTimedBlocks(blocks).sort((a, b) => a.startMs - b.startMs);
    this.syncOverlay();
  }

  /** Merge blocks received from a streaming translation response. */
  public append(blocks: readonly TranslatedBlock[]): void {
    const merged = new Map(this.blocks.map((block) => [block.id, block]));
    for (const block of toTimedBlocks(blocks)) {
      merged.set(block.id, block);
    }
    this.blocks = [...merged.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    this.syncOverlay();
  }

  public setMode(mode: CaptionDisplayMode): void {
    this.mode = mode;
    this.syncOverlay();
  }

  public isActive(): boolean {
    return this.overlay !== null;
  }

  private syncOverlay(): void {
    this.activate();
  }

  private activate(): void {
    if (this.overlay !== null) {
      this.renderActive();
      return;
    }

    this.overlay = this.documentNode.createElement("div");
    this.overlay.className = "xtranslator-caption";
    this.overlay.setAttribute(XTRANSLATOR_DOM.mountAttribute, XTRANSLATOR_DOM.mountCaption);
    this.overlay.hidden = true;
    // Keep the overlay inside the player so it stays visible in fullscreen, but
    // give it a high z-index so it paints above YouTube's own video layers.
    this.player.append(this.overlay);

    this.resolveVideo();
    this.documentNode.body.classList.add(CAPTION_SUPPRESSED_CLASS);
    this.suppressNativeCaptions();
    if (typeof MutationObserver !== "undefined") {
      this.nativeCaptionObserver = new MutationObserver(() => this.suppressNativeCaptions());
      this.nativeCaptionObserver.observe(this.player, { childList: true, subtree: true });
    }
    this.startLoop();
  }

  private suppressNativeCaptions(): void {
    this.player
      .querySelectorAll<HTMLElement>(".ytp-caption-window-container")
      .forEach((captionWindow) => captionWindow.classList.add(XTRANSLATOR_DOM.nativeCaptionSuppressedClass));
  }

  private restoreNativeCaptions(): void {
    this.player
      .querySelectorAll<HTMLElement>(`.${XTRANSLATOR_DOM.nativeCaptionSuppressedClass}`)
      .forEach((captionWindow) => captionWindow.classList.remove(XTRANSLATOR_DOM.nativeCaptionSuppressedClass));
  }

  private resolveVideo(): void {
    this.video =
      this.player.querySelector<HTMLVideoElement>("video") ?? this.documentNode.querySelector<HTMLVideoElement>("video");
  }

  public deactivate(): void {
    if (this.frame !== null) {
      this.documentNode.defaultView?.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.nativeCaptionObserver?.disconnect();
    this.nativeCaptionObserver = null;
    this.restoreNativeCaptions();
    this.documentNode.body.classList.remove(CAPTION_SUPPRESSED_CLASS);
    this.overlay?.remove();
    this.overlay = null;
    this.video = null;
  }

  private startLoop(): void {
    if (this.frame !== null) {
      return;
    }
    this.renderActive();
    this.frame = this.documentNode.defaultView?.requestAnimationFrame(this.tick) ?? null;
  }

  private tick = (): void => {
    this.renderActive();
    this.frame = this.documentNode.defaultView?.requestAnimationFrame(this.tick) ?? null;
  };

  private renderActive(): void {
    if (this.overlay === null) {
      return;
    }
    if (this.video === null) {
      this.resolveVideo();
    }
    this.syncOverlayGeometry();
    this.render(this.findActive(this.currentTimeMs()));
  }

  private syncOverlayGeometry(): void {
    if (this.overlay === null) {
      return;
    }
    const target = this.video ?? this.player;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    this.overlay.style.left = `${rect.left}px`;
    this.overlay.style.top = `${rect.top}px`;
    this.overlay.style.width = `${rect.width}px`;
    this.overlay.style.height = `${rect.height}px`;
  }

  private currentTimeMs(): number {
    const currentTime = this.video?.currentTime;
    return typeof currentTime === "number" && Number.isFinite(currentTime) ? currentTime * 1000 : Number.NaN;
  }

  private findActive(timeMs: number): TimedBlock | null {
    if (!Number.isFinite(timeMs) || this.blocks.length === 0) {
      return null;
    }
    // Find the rightmost block whose start <= now, then confirm containment.
    let low = 0;
    let high = this.blocks.length - 1;
    let index = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.blocks[mid]!.startMs <= timeMs) {
        index = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (index === -1) {
      return null;
    }
    const block = this.blocks[index]!;
    return timeMs < block.endMs ? block : null;
  }

  private render(block: TimedBlock | null): void {
    if (this.overlay === null) {
      return;
    }
    if (!block) {
      this.overlay.hidden = true;
      this.overlay.replaceChildren();
      return;
    }

    const lines: CaptionLine[] = [];
    if (this.mode === "original") {
      if (block.sourceText) {
        lines.push({ text: block.sourceText, className: "xtranslator-caption-original" });
      }
    } else if (this.mode === "translation") {
      if (block.translatedText) {
        lines.push({ text: block.translatedText, className: "xtranslator-caption-translation" });
      }
    } else if (block.translatedText) {
      // Bilingual: translation on top (yellow), source text below (dim).
      lines.push({ text: block.translatedText, className: "xtranslator-caption-translation" });
      if (block.sourceText) {
        lines.push({ text: block.sourceText, className: "xtranslator-caption-original" });
      }
    } else if (block.sourceText) {
      lines.push({ text: block.sourceText, className: "xtranslator-caption-original" });
    }

    if (lines.length === 0) {
      this.overlay.hidden = true;
      this.overlay.replaceChildren();
      return;
    }

    this.overlay.hidden = false;
    this.overlay.replaceChildren();
    this.appendCard(lines, block.id);
  }

  private appendCard(lines: readonly CaptionLine[], blockId: string): void {
    const card = this.documentNode.createElement("div");
    card.className = "xtranslator-caption-card";
    card.dataset.xtranslatorBlockId = blockId;
    lines.forEach((line) => this.appendLine(card, line.text, line.className, blockId));
    this.overlay?.append(card);
  }

  private appendLine(parent: HTMLElement, text: string, className: string, blockId: string): void {
    const element = this.documentNode.createElement("span");
    element.className = `xtranslator-caption-line ${className}`;
    element.dataset.xtranslatorBlockId = blockId;
    element.textContent = text;
    parent.append(element);
  }
}
