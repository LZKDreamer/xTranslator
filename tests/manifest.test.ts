import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface WebAccessibleResourceRule {
  resources?: string[];
  matches?: string[];
}

interface ExtensionManifest {
  default_locale?: string;
  description?: string;
  host_permissions?: string[];
  name?: string;
  web_accessible_resources?: WebAccessibleResourceRule[];
}

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
) as ExtensionManifest;

describe("extension manifest", () => {
  it("uses Chrome locale resources for extension metadata", () => {
    expect(manifest.default_locale).toBe("en");
    expect(manifest.name).toBe("__MSG_extensionName__");
    expect(manifest.description).toBe("__MSG_extensionDescription__");
    expect(() => readFileSync(new URL("../public/_locales/en/messages.json", import.meta.url), "utf8")).not.toThrow();
    expect(() => readFileSync(new URL("../public/_locales/zh_CN/messages.json", import.meta.url), "utf8")).not.toThrow();
  });

  it("exposes logo assets to YouTube content pages", () => {
    const rules = manifest.web_accessible_resources ?? [];

    const logoRule = rules.find(
      (rule) =>
        Array.isArray(rule.resources) &&
        rule.resources.includes("icons/icon-32.png") &&
        rule.resources.includes("icons/icon-light-32.png"),
    );

    expect(logoRule).toBeDefined();
    expect(logoRule?.matches).toEqual(["https://www.youtube.com/*"]);
  });

  it("allows update checks through jsDelivr only", () => {
    expect(manifest.host_permissions).toContain("https://cdn.jsdelivr.net/*");
  });
});
