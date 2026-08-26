export const AUTO_TARGET_LANGUAGE = "auto";

export const DEFAULT_PROVIDER_ID = "deepseek";

export type CaptionDisplayMode = "original" | "translation" | "bilingual";

export const DEFAULT_CAPTION_DISPLAY_MODE: CaptionDisplayMode = "bilingual";

export interface ProviderSettings {
  providerId: string;
  model: string;
}

export interface SubtitleSettings {
  displayMode: CaptionDisplayMode;
}

export interface SelectionSettings {
  /** When false, selection-driven translation overlays and the context-menu action are disabled. */
  enabled: boolean;
  /** When true, send the sentence before/after the selection as context for the LLM. */
  includeContext: boolean;
}

export interface ExtensionSettings {
  provider: ProviderSettings;
  /** API keys keyed by provider id. Kept per-provider so switching providers restores the saved key. */
  apiKeys: Record<string, string>;
  /** Last successfully selected model keyed by provider id. */
  providerModels: Record<string, string>;
  subtitles: SubtitleSettings;
  selection: SelectionSettings;
}

export const DEFAULT_API_KEYS: Readonly<Record<string, string>> = {};
export const DEFAULT_PROVIDER_MODELS: Readonly<Record<string, string>> = {};

export const DEFAULT_PROVIDER_SETTINGS: Readonly<ProviderSettings> = {
  providerId: DEFAULT_PROVIDER_ID,
  model: "",
};

export const DEFAULT_SUBTITLE_SETTINGS: Readonly<SubtitleSettings> = {
  displayMode: DEFAULT_CAPTION_DISPLAY_MODE,
};

export const DEFAULT_SELECTION_SETTINGS: Readonly<SelectionSettings> = {
  enabled: true,
  includeContext: false,
};

export const DEFAULT_SETTINGS: Readonly<ExtensionSettings> = {
  provider: { ...DEFAULT_PROVIDER_SETTINGS },
  apiKeys: { ...DEFAULT_API_KEYS },
  providerModels: { ...DEFAULT_PROVIDER_MODELS },
  subtitles: { ...DEFAULT_SUBTITLE_SETTINGS },
  selection: { ...DEFAULT_SELECTION_SETTINGS },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeLanguageTag(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) {
    return null;
  }

  try {
    const [canonicalTag] = Intl.getCanonicalLocales(candidate);
    if (!canonicalTag) {
      return null;
    }

    const locale = new Intl.Locale(canonicalTag);
    if (locale.language !== "zh") {
      return canonicalTag;
    }

    if (locale.script === "Hans" || locale.region === "CN" || locale.region === "SG") {
      return "zh-Hans";
    }

    if (
      locale.script === "Hant" ||
      locale.region === "TW" ||
      locale.region === "HK" ||
      locale.region === "MO"
    ) {
      return "zh-Hant";
    }

    return canonicalTag;
  } catch {
    return null;
  }
}

export function parseCaptionDisplayMode(value: unknown): CaptionDisplayMode | null {
  if (value === "original" || value === "translation" || value === "bilingual") {
    return value;
  }
  return null;
}

export function parseProviderSettings(value: unknown): ProviderSettings | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.providerId !== "string" || !value.providerId.trim()) {
    return null;
  }
  if (typeof value.model !== "string") {
    return null;
  }

  return {
    providerId: value.providerId.trim(),
    model: value.model.trim(),
  };
}

export function parseApiKeys(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const apiKeys: Record<string, string> = {};
  for (const [providerId, apiKey] of Object.entries(value)) {
    if (typeof apiKey !== "string") {
      return null;
    }
    apiKeys[providerId] = apiKey;
  }
  return apiKeys;
}

export function resolveProviderApiKey(
  settings: ExtensionSettings,
  providerId: string = settings.provider.providerId,
): string {
  return settings.apiKeys[providerId] ?? "";
}

export function resolveProviderModel(
  settings: ExtensionSettings,
  providerId: string = settings.provider.providerId,
): string {
  return settings.providerModels[providerId] ??
    (providerId === settings.provider.providerId ? settings.provider.model : "");
}

export function parseProviderModels(value: unknown): Record<string, string> | null {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return null;
  }

  const models: Record<string, string> = {};
  for (const [providerId, model] of Object.entries(value)) {
    if (typeof model !== "string") {
      return null;
    }
    models[providerId] = model.trim();
  }
  return models;
}

export function parseSubtitleSettings(value: unknown): SubtitleSettings | null {
  if (!isRecord(value)) {
    return null;
  }

  const displayMode = parseCaptionDisplayMode(value.displayMode);
  return displayMode ? { displayMode } : null;
}

export function parseSelectionSettings(value: unknown): SelectionSettings | null {
  if (!isRecord(value)) {
    return null;
  }
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") {
    return null;
  }
  if (typeof value.includeContext !== "boolean") {
    return null;
  }
  return { enabled, includeContext: value.includeContext };
}

export function parseExtensionSettings(value: unknown): ExtensionSettings | null {
  if (!isRecord(value)) {
    return null;
  }

  const provider = parseProviderSettings(value.provider);
  if (!provider) {
    return null;
  }

  let apiKeys = parseApiKeys(value.apiKeys);
  if (!apiKeys) {
    // Migrate the legacy single-key settings shape ({ provider.apiKey }) into the
    // per-provider map so existing users keep their configured key.
    const legacyKey = isRecord(value.provider) ? value.provider.apiKey : undefined;
    if (typeof legacyKey === "string") {
      apiKeys = { [provider.providerId]: legacyKey };
    } else {
      return null;
    }
  }

  const providerModels = parseProviderModels(value.providerModels);
  if (!providerModels) {
    return null;
  }
  if (provider.model && providerModels[provider.providerId] === undefined) {
    // Migrate settings written before models were remembered per provider.
    providerModels[provider.providerId] = provider.model;
  }

  const subtitles = parseSubtitleSettings(value.subtitles);
  if (!subtitles) {
    return null;
  }

  const selection = parseSelectionSettings(value.selection);
  if (!selection) {
    return null;
  }

  return { provider, apiKeys, providerModels, subtitles, selection };
}
