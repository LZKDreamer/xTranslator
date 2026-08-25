import { describe, expect, it } from "vitest";
import { AUTO_TARGET_LANGUAGE } from "../src/shared/contracts/settings";
import { resolveTargetLocale, type LocaleEnvironment } from "../src/shared/locale/resolve-target-locale";

function environment(overrides: Partial<LocaleEnvironment>): LocaleEnvironment {
  return {
    getUiLanguage: () => undefined,
    getNavigatorLanguages: () => [],
    getNavigatorLanguage: () => undefined,
    ...overrides,
  };
}

describe("resolveTargetLocale", () => {
  it("uses the Chrome UI language before navigator languages", () => {
    expect(
      resolveTargetLocale(
        AUTO_TARGET_LANGUAGE,
        environment({
          getUiLanguage: () => "ja-JP",
          getNavigatorLanguages: () => ["en-US"],
        }),
      ),
    ).toBe("ja-JP");
  });

  it("normalizes simplified and traditional Chinese", () => {
    expect(resolveTargetLocale(AUTO_TARGET_LANGUAGE, environment({ getUiLanguage: () => "zh-CN" }))).toBe(
      "zh-Hans",
    );
    expect(resolveTargetLocale(AUTO_TARGET_LANGUAGE, environment({ getUiLanguage: () => "zh-TW" }))).toBe(
      "zh-Hant",
    );
  });

  it("uses a valid manual setting before browser preferences", () => {
    expect(
      resolveTargetLocale("fr-ca", environment({ getUiLanguage: () => "zh-CN" })),
    ).toBe("fr-CA");
  });

  it("falls back to English when no environment candidate is valid", () => {
    expect(
      resolveTargetLocale(
        AUTO_TARGET_LANGUAGE,
        environment({
          getUiLanguage: () => "not a locale",
          getNavigatorLanguages: () => ["also invalid"],
          getNavigatorLanguage: () => "",
        }),
      ),
    ).toBe("en");
  });
});
