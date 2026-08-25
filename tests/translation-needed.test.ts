import { describe, expect, it } from "vitest";
import { languagesAreEquivalent, shouldTranslateText } from "../src/shared/locale/translation-needed";

describe("translation-needed", () => {
  it("treats simplified and traditional Chinese as the same language", () => {
    expect(languagesAreEquivalent("zh-Hant", "zh-Hans")).toBe(true);
    expect(shouldTranslateText("", "zh-Hans", "zh-TW")).toBe(false);
  });

  it("matches non-Chinese language variants by their language subtag", () => {
    expect(languagesAreEquivalent("en-US", "en-GB")).toBe(true);
    expect(shouldTranslateText("hello", "en-GB", "en-US")).toBe(false);
    expect(shouldTranslateText("hello", "zh-Hans", "en-US")).toBe(true);
  });

  it("skips both Chinese scripts when the target is Chinese", () => {
    expect(shouldTranslateText("这是简体中文评论。", "zh-Hans")).toBe(false);
    expect(shouldTranslateText("這是繁體中文留言。", "zh-Hans")).toBe(false);
    expect(shouldTranslateText("これは日本語です。", "zh-Hans")).toBe(true);
    expect(shouldTranslateText("這是繁體中文留言。", "en")).toBe(true);
  });
});

