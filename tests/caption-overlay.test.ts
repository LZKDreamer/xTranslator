import { describe, expect, it } from "vitest";
import { toTimedBlocks } from "../src/content/caption-overlay";
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
