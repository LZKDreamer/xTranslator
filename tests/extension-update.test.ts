import { checkForExtensionUpdate, compareExtensionVersions, getAvailableUpdate, UPDATE_MANIFEST_URL } from "../src/shared/extension-update";
import { describe, expect, it } from "vitest";

describe("extension update", () => {
  it("loads the mutable update manifest through jsDelivr", () => {
    expect(UPDATE_MANIFEST_URL).toBe("https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@main/public/updates/latest.json");
  });

  it("compares Chrome extension versions", () => {
    expect(compareExtensionVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareExtensionVersions("1.0", "1.0.0")).toBe(0);
    expect(compareExtensionVersions("1.0.0", "1.1")).toBeLessThan(0);
  });

  it("accepts only newer jsDelivr zip releases", () => {
    expect(getAvailableUpdate({
      version: "1.0.1",
      downloadUrl: "https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@v1.0.1/releases/xTranslator-1.0.1.zip",
    }, "1.0.0")).toEqual({
      version: "1.0.1",
      downloadUrl: "https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@v1.0.1/releases/xTranslator-1.0.1.zip",
    });
  });

  it("ignores invalid, stale, and non-CDN updates", () => {
    expect(getAvailableUpdate({ version: "1.0.1", downloadUrl: "https://cdn.jsdelivr.net/update.zip" }, "1.0.0")).toBeNull();
    expect(getAvailableUpdate({ version: "1.0.1", downloadUrl: "https://github.com/update.zip" }, "1.0.0")).toBeNull();
    expect(getAvailableUpdate({ version: "invalid", downloadUrl: "https://cdn.jsdelivr.net/update.zip" }, "1.0.0")).toBeNull();
  });

  it("reports the update check state", async () => {
    await expect(checkForExtensionUpdate("1.0.0", async () => new Response(JSON.stringify({
      version: "1.0.1",
      downloadUrl: "https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@v1.0.1/releases/xTranslator-1.0.1.zip",
    })))).resolves.toEqual({
      state: "available",
      update: {
        version: "1.0.1",
        downloadUrl: "https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@v1.0.1/releases/xTranslator-1.0.1.zip",
      },
    });
    await expect(checkForExtensionUpdate("1.0.1", async () => new Response("not found", { status: 404 }))).resolves.toEqual({
      state: "unavailable",
    });
  });
});
