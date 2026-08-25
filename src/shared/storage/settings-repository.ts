import {
  DEFAULT_SETTINGS,
  parseExtensionSettings,
  type ExtensionSettings,
} from "../contracts/settings";

const SETTINGS_STORAGE_KEY = "settings";

export interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class SettingsRepository {
  public constructor(private readonly storageArea: LocalStorageArea) {}

  public async loadSettings(): Promise<ExtensionSettings> {
    const stored = await this.storageArea.get(SETTINGS_STORAGE_KEY);
    return parseExtensionSettings(stored[SETTINGS_STORAGE_KEY]) ?? { ...DEFAULT_SETTINGS };
  }

  public async saveSettings(settings: ExtensionSettings): Promise<void> {
    await this.storageArea.set({ [SETTINGS_STORAGE_KEY]: settings });
  }
}

export function createChromeSettingsRepository(): SettingsRepository {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    throw new Error("xTranslator settings are only available inside Chrome.");
  }

  return new SettingsRepository(chrome.storage.local);
}
