import { describe, expect, it } from "vitest";
import { TranslationResultValidator } from "../src/shared/translation/result-validator";
import type { TranslationBlockInput } from "../src/shared/translation/translation-types";

const blocks: TranslationBlockInput[] = [
  { id: "blk-aa", segmentIds: ["a"], startMs: 0, endMs: 1000, sourceText: "hello", isSilent: false },
  { id: "blk-bb", segmentIds: ["b"], startMs: 1000, endMs: 2000, sourceText: "world", isSilent: true },
];

describe("TranslationResultValidator", () => {
  const validator = new TranslationResultValidator();

  it("maps strict JSON Lines back to block ids", () => {
    const result = validator.validate(blocks, '{"id":"blk-aa","text":"你好"}\n{"id":"blk-bb","text":"世界"}');
    expect(result.matched).toEqual([
      { id: "blk-aa", translatedText: "你好" },
      { id: "blk-bb", translatedText: "世界" },
    ]);
    expect(result.missingIds).toEqual([]);
  });

  it("tolerates code fences and prose around the objects", () => {
    const result = validator.validate(
      blocks,
      '```json\n{"id":"blk-aa","text":"你好"}\n{"id":"blk-bb","text":"世界"}\n```',
    );
    expect(result.matched).toHaveLength(2);
    expect(result.missingIds).toEqual([]);
  });

  it("rejects an empty text for spoken blocks but accepts it for silent blocks", () => {
    const result = validator.validate(blocks, '{"id":"blk-aa","text":""}\n{"id":"blk-bb","text":"世界"}');
    expect(result.matched).toEqual([
      { id: "blk-bb", translatedText: "世界" },
    ]);
    expect(result.missingIds).toEqual(["blk-aa"]);
    const silentResult = validator.validate(blocks, '{"id":"blk-bb","text":""}');
    expect(silentResult.matched).toEqual([{ id: "blk-bb", translatedText: "" }]);
    expect(silentResult.missingIds).toEqual(["blk-aa"]);
  });

  it("reports ids the model failed to return", () => {
    const result = validator.validate(blocks, '{"id":"blk-aa","text":"你好"}');
    expect(result.matched).toHaveLength(1);
    expect(result.missingIds).toEqual(["blk-bb"]);
  });

  it("ignores unknown ids and malformed lines without failing the rest", () => {
    const result = validator.validate(blocks, 'not json\n{"id":"blk-aa","text":"你好"}\n{"id":"nope","text":"x"}');
    expect(result.matched).toHaveLength(1);
    expect(result.missingIds).toEqual(["blk-bb"]);
  });
});
