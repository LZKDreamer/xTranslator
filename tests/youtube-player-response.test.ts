import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInitialPlayerResponse } from "../src/shared/youtube/player-response-parser";

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/youtube/${name}`, import.meta.url), "utf8");
}

describe("YouTube player response contract", () => {
  it("reads only the documented player response fields from a sanitized fixture", () => {
    const snapshot = parseInitialPlayerResponse([readFixture("with-captions-player-response.html")]);

    expect(snapshot).toEqual({
      videoId: "fixture-video-id",
      title: "Fixture title with a brace }",
      author: "Fixture author",
      lengthSeconds: 119,
      shortDescription: "Sanitized fixture description",
      captionTracks: [
        {
          baseUrl: "https://fixture.invalid/caption-track?signature=REDACTED",
          vssId: "a.en",
          languageCode: "en",
          kind: "asr",
          isTranslatable: true,
          name: "English (auto-generated)",
        },
      ],
      translationLanguages: [{ languageCode: "zh-Hans", name: "Chinese (Simplified)" }],
    });
  });

  it("accepts a valid video with no caption tracks", () => {
    expect(parseInitialPlayerResponse([readFixture("without-captions-player-response.html")])?.captionTracks).toEqual([]);
  });

  it("accepts a valid video when YouTube omits caption metadata", () => {
    expect(parseInitialPlayerResponse([readFixture("without-caption-metadata-player-response.html")])).toMatchObject({
      videoId: "no-caption-metadata-video-id",
      captionTracks: [],
      translationLanguages: [],
    });
  });

  it("fails closed when required fields are absent", () => {
    expect(parseInitialPlayerResponse([readFixture("invalid-player-response.html")])).toBeNull();
  });
});
