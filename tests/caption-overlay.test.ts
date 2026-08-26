import { describe, expect, it } from "vitest";
import { getCaptionBottomOffset, toTimedBlocks } from "../src/content/caption-overlay";
import type { TranslatedBlock } from "../src/shared/translation/translation-types";

function block(id: string, startMs: number, endMs: number): TranslatedBlock {
  return {
    id,
    segmentIds: [id],
    startMs,
    endMs,
    sourceText: id,
    translatedText: `${id}-translated`,
  };
}

describe("caption timeline normalization", () => {
  it("preserves the later subtitle start and trims only the preceding overlap", () => {
    expect(toTimedBlocks([block("first", 0, 3000), block("next", 2500, 3500)])).toEqual([
      expect.objectContaining({ id: "first", startMs: 0, endMs: 2500 }),
      expect.objectContaining({ id: "next", startMs: 2500, endMs: 3500 }),
    ]);
  });
});

describe("caption progress-bar placement", () => {
  it("places the subtitle above the progress bar with a small gap", () => {
    expect(getCaptionBottomOffset(
      { top: 100, bottom: 500, height: 400 },
      { top: 460, bottom: 470, height: 10 },
    )).toBe(48);
  });

  it("uses the CSS fallback when the progress bar is hidden or outside the player", () => {
    expect(getCaptionBottomOffset(
      { top: 100, bottom: 500, height: 400 },
      { top: 460, bottom: 460, height: 0 },
    )).toBeNull();
    expect(getCaptionBottomOffset(
      { top: 100, bottom: 500, height: 400 },
      { top: 510, bottom: 520, height: 10 },
    )).toBeNull();
  });
});
