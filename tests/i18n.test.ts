import { describe, expect, it } from "vitest";
import { getUiLocale, translate } from "../src/shared/i18n";

describe("UI language selection", () => {
  it("uses simplified Chinese only for simplified Chinese browser locales", () => {
    expect(getUiLocale("zh-CN")).toBe("zh-CN");
    expect(getUiLocale("ZH-cn")).toBe("zh-CN");
    expect(getUiLocale("zh-Hans")).toBe("zh-CN");
    expect(getUiLocale("zh-SG")).toBe("zh-CN");
    expect(getUiLocale("zh-TW")).toBe("en");
    expect(getUiLocale("en-US")).toBe("en");
    expect(getUiLocale("fr-FR")).toBe("en");
  });

  it("formats localized messages from the selected resource", () => {
    expect(translate("zh-CN", "popup.translatingCaptions", { count: 3 })).toBe("正在翻译 3 处字幕…");
    expect(translate("en", "popup.translatingCaptions", { count: 3 })).toBe("Translating 3 caption segments…");
    expect(translate("zh-CN", "options.createApiKey", { name: "OpenAI" })).toBe("前往 OpenAI 创建 API Key");
  });
});
