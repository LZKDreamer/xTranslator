import { AUTO_TARGET_LANGUAGE, normalizeLanguageTag } from "../contracts/settings";

export interface LocaleEnvironment {
  getUiLanguage(): string | undefined;
  getNavigatorLanguages(): readonly string[];
  getNavigatorLanguage(): string | undefined;
}

const FALLBACK_LANGUAGE = "en";

export function resolveTargetLocale(preference: string, environment: LocaleEnvironment): string {
  if (preference !== AUTO_TARGET_LANGUAGE) {
    return normalizeLanguageTag(preference) ?? FALLBACK_LANGUAGE;
  }

  const candidates = [
    environment.getUiLanguage(),
    environment.getNavigatorLanguages()[0],
    environment.getNavigatorLanguage(),
    FALLBACK_LANGUAGE,
  ];

  for (const candidate of candidates) {
    if (candidate) {
      const normalized = normalizeLanguageTag(candidate);
      if (normalized) {
        return normalized;
      }
    }
  }

  return FALLBACK_LANGUAGE;
}

export function createBrowserLocaleEnvironment(): LocaleEnvironment {
  return {
    getUiLanguage: () => {
      if (typeof chrome === "undefined" || !chrome.i18n) {
        return undefined;
      }

      return chrome.i18n.getUILanguage();
    },
    getNavigatorLanguages: () => navigator.languages,
    getNavigatorLanguage: () => navigator.language,
  };
}
