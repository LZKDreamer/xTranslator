import { describe, expect, it } from "vitest";
import {
  batchTranslationBlocks,
  buildTranslationBlocks,
  cleanCaptionText,
  cleanTranslatedCaptionText,
  containsSpokenContent,
} from "../src/shared/translation/block-builder";
import { computeInputTokenBudget } from "../src/shared/translation/chunker";
import { estimateTokens } from "../src/shared/translation/token-estimator";
import type { TranslationSourceSegment } from "../src/shared/translation/translation-types";

function segment(id: string, sourceText: string, startMs: number, durationMs = 1000): TranslationSourceSegment {
  return { id, sourceText, startMs, durationMs };
}

describe("token estimator", () => {
  it("estimates CJK at about one token per character and Latin at about a quarter", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    const english = estimateTokens("hello world");
    expect(english).toBeGreaterThanOrEqual(2);
    expect(english).toBeLessThan(4);
  });
});

describe("buildTranslationBlocks", () => {
  it("merges adjacent ASR segments into one block with a combined timeline", () => {
    const blocks = buildTranslationBlocks(
      [segment("a", "hello", 0), segment("b", "world", 1000)],
      computeInputTokenBudget(65_536),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startMs: 0, endMs: 2000, sourceText: "hello world", isSilent: false });
    expect(blocks[0]!.id).toMatch(/^blk-[a-z0-9]+$/);
    expect(blocks[0]!.segmentIds).toEqual(["a", "b"]);
  });

  it("does not add spaces inside CJK text or before punctuation", () => {
    const blocks = buildTranslationBlocks(
      [segment("a", "你好", 0), segment("b", "世界", 500), segment("c", "！", 1000)],
      computeInputTokenBudget(65_536),
    );
    expect(blocks[0]!.sourceText).toBe("你好世界！");
  });

  it("splits blocks at a large timeline gap", () => {
    const blocks = buildTranslationBlocks(
      [segment("a", "hello", 0), segment("b", "world", 2000)],
      computeInputTokenBudget(65_536),
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.sourceText).toBe("hello");
    expect(blocks[1]!.sourceText).toBe("world");
  });

  it("flags blocks with no spoken content as silent", () => {
    const blocks = buildTranslationBlocks(
      [segment("a", "[music]", 0, 2000), segment("c", "speech", 3000)],
      computeInputTokenBudget(65_536),
    );
    expect(blocks[0]!.isSilent).toBe(true);
    expect(blocks[1]!.isSilent).toBe(false);
  });

  it("cleans non-verbal markers from the displayed source text", () => {
    const blocks = buildTranslationBlocks(
      [segment("a", ">> hello [music]", 0), segment("b", "[laughter]", 1000, 200)],
      computeInputTokenBudget(65_536),
    );
    expect(blocks[0]!.sourceText).toBe("hello");
    expect(blocks[1]!.sourceText).toBe("");
    expect(cleanCaptionText(">> hello [music] (sighs)")).toBe("hello");
    expect(cleanCaptionText("This is (probably) [music]")).toBe("This is (probably)");
    expect(cleanCaptionText("你好[音乐]")).toBe("你好");
    expect(cleanCaptionText("…")).toBe("");
    expect(cleanTranslatedCaptionText("这是 Google 的产品。", "zh-Hans")).toBe("这是 Google 的产品。");
    expect(cleanTranslatedCaptionText("What's new?", "en")).toBe("What's new?");
  });

  it("splits multiple sentences inside one raw ASR event and keeps their timelines ordered", () => {
    const blocks = buildTranslationBlocks(
      [segment("a", "First sentence. Second sentence!", 0, 2000)],
      computeInputTokenBudget(65_536),
    );

    expect(blocks.map((block) => block.sourceText)).toEqual(["First sentence.", "Second sentence!"]);
    expect(blocks[0]!.endMs).toBeLessThanOrEqual(blocks[1]!.startMs);
    expect(blocks[1]!.endMs).toBe(2000);
  });

  it("breaks at a new speaker and clamps overlapping block timing", () => {
    const blocks = buildTranslationBlocks(
      [
        segment("a", "first sentence.", 43_840, 2_000),
        segment("m", "[music]", 50_435, 5),
        segment("b", ">> Hey Chad", 50_440, 1_800),
      ],
      computeInputTokenBudget(65_536),
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ startMs: 43_840, endMs: 45_840, segmentIds: ["a"] });
    expect(blocks[1]).toMatchObject({ startMs: 50_435, endMs: 50_440, sourceText: "", isSilent: true });
    expect(blocks[2]).toMatchObject({ startMs: 50_440, segmentIds: ["b"], sourceText: "Hey Chad" });
    expect(blocks[0]!.endMs).toBeLessThanOrEqual(blocks[1]!.startMs);
    expect(blocks[1]!.endMs).toBeLessThanOrEqual(blocks[2]!.startMs);
  });

  it("splits long continuous speech into readable blocks instead of one wall of text", () => {
    // "the quick brown fox" ≈ 5 source tokens; 16 segments at a 0ms gap → no
    // timeline break, so without the readability cap this would be a single huge
    // block. The cap must split it into several small, bounded blocks.
    const segments = Array.from({ length: 16 }, (_, index) =>
      segment(String(index), "the quick brown fox", index * 1000),
    );
    const blocks = buildTranslationBlocks(segments, computeInputTokenBudget(65_536));
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(estimateTokens(block.sourceText)).toBeLessThanOrEqual(68);
    }
  });

  it("limits a continuous block to a readable six-second timing window", () => {
    const segments = Array.from({ length: 7 }, (_, index) => segment(String(index), "word", index * 1000));
    const blocks = buildTranslationBlocks(segments, computeInputTokenBudget(65_536));

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ startMs: 0, endMs: 6000 });
    expect(blocks[1]).toMatchObject({ startMs: 6000, endMs: 7000 });
  });

  it("keeps ordinary English caption blocks within the two-line source budget", () => {
    const blocks = buildTranslationBlocks(
      [
        segment("a", ">> Yeah, this continuous presence also lets", 0),
        segment("b", "the model to kind of index on the time", 1000),
        segment("c", "in the conversation. It gives it a lot of", 2000),
        segment("d", "temporal awareness.", 3000),
      ],
      computeInputTokenBudget(65_536),
    );

    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.sourceText)).toEqual([
      "Yeah, this continuous presence also lets the model to kind of index on the time in the conversation.",
      "It gives it a lot of temporal awareness.",
    ]);
    expect(blocks.every((block) => estimateTokens(block.sourceText) <= 48)).toBe(true);
  });

  it("keeps an unfinished sentence in one timed block", () => {
    const blocks = buildTranslationBlocks(
      [
        segment("a", "Because the model always perceives and generates, the model is able to understand the", 0),
        segment("b", "passage of time in a way previous models were not able to.", 1000),
      ],
      computeInputTokenBudget(65_536),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      sourceText: "Because the model always perceives and generates, the model is able to understand the passage of time in a way previous models were not able to.",
      segmentIds: ["a", "b"],
      startMs: 0,
      endMs: 2000,
    });
  });

  it("keeps the coffee instruction continuation with its preceding block", () => {
    const blocks = buildTranslationBlocks(
      [
        segment("a", "If you're out of water, stop the pour, don't scrape the slurry, just let it drain. Taste it, tell me if it's sharp or thin, we'll tweak the bloom and", 0),
        segment("b", "throttle water next time. Enjoy.", 1000),
      ],
      computeInputTokenBudget(65_536),
    );

    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.sourceText)).toEqual([
      "If you're out of water, stop the pour, don't scrape the slurry, just let it drain.",
      "Taste it, tell me if it's sharp or thin, we'll tweak the bloom and throttle water next time.",
      "Enjoy.",
    ]);
  });

  it("keeps a sentence-completing segment with its unfinished preceding phrase", () => {
    const blocks = buildTranslationBlocks(
      [
        segment("a", "If you're out of water, stop the pour,", 0),
        segment("b", "don't scrape the slurry, just let it", 1000),
        segment("c", "drain.", 2000),
      ],
      computeInputTokenBudget(65_536),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.sourceText).toBe("If you're out of water, stop the pour, don't scrape the slurry, just let it drain.");
  });

  it("prefers to end a block at a sentence boundary once it is long enough", () => {
    // Two long sentences; each independently fits under the hard cap, but together
    // they pass the preferred length. The block must break at the sentence end
    // rather than merging both into one oversized line.
    const first = "We need to talk about the whole plan in detail before we decide.";
    const second = "This is the second sentence that keeps going for quite a while now.";
    const blocks = buildTranslationBlocks(
      [segment("a", first, 0), segment("b", second, 1000)],
      computeInputTokenBudget(65_536),
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.sourceText).toBe(first);
    expect(blocks[1]!.sourceText).toBe(second);
  });
});

describe("containsSpokenContent", () => {
  it("returns false for caption-only markers and true for real text", () => {
    expect(containsSpokenContent("[music]")).toBe(false);
    expect(containsSpokenContent("♪ ♫")).toBe(false);
    expect(containsSpokenContent("hello[music]world")).toBe(true);
  });
});

describe("batchTranslationBlocks", () => {
  it("groups blocks into batches under the token budget", () => {
    const six = Array.from({ length: 6 }, (_, index) => segment(String(index), "x".repeat(2000), index * 2500));
    const blocks = buildTranslationBlocks(six, computeInputTokenBudget(4000));
    expect(blocks.length).toBeGreaterThan(1);
    const batches = batchTranslationBlocks(blocks, 4000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().length).toBe(blocks.length);
  });

  it("keeps all blocks even when the budget is huge", () => {
    const blocks = buildTranslationBlocks(
      [segment("a", "x", 0), segment("b", "y", 2000)],
      computeInputTokenBudget(65_536),
    );
    const batches = batchTranslationBlocks(blocks, 10_000_000);
    expect(batches.flat().length).toBe(blocks.length);
  });
});

describe("computeInputTokenBudget", () => {
  it("reserves output room within the context window", () => {
    const budget = computeInputTokenBudget(10_000);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(10_000);
  });
});
