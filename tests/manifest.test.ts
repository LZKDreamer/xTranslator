import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface WebAccessibleResourceRule {
  resources?: string[];
  matches?: string[];
}

interface ExtensionManifest {
  web_accessible_resources?: WebAccessibleResourceRule[];
}

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
) as ExtensionManifest;

describe("extension manifest", () => {
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
});
