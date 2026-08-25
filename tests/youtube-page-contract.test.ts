import { describe, expect, it } from "vitest";
import {
  isYouTubeNativeCaptionsEnabled,
  shouldKeepYouTubeTranslationControl,
  shouldShowYouTubeTranslationControl,
} from "../src/shared/youtube/youtube-page-contract";
import type { YouTubeVideoSnapshot } from "../src/shared/youtube/youtube-types";

function createSnapshot(captionTracks: YouTubeVideoSnapshot["captionTracks"]): YouTubeVideoSnapshot {
  return {
    videoId: "fixture-video-id",
    title: "Fixture title",
    author: "Fixture author",
    lengthSeconds: 60,
    shortDescription: "Fixture description",
    captionTracks,
    translationLanguages: [],
  };
}

describe("YouTube translation control visibility", () => {
  it("shows the control when the native subtitle switch is enabled", () => {
    const button = {
      getAttribute: (name: string) => (name === "aria-pressed" ? "true" : null),
      classList: { contains: () => false },
    } as unknown as HTMLElement;
    const documentNode = { querySelector: () => button } as unknown as Document;

    expect(isYouTubeNativeCaptionsEnabled(documentNode)).toBe(true);
    expect(shouldShowYouTubeTranslationControl(createSnapshot([]), true)).toBe(true);
  });

  it("shows the control whenever a caption track is available, even if native captions are off", () => {
    expect(
      shouldShowYouTubeTranslationControl(
        createSnapshot([
          {
            baseUrl: "https://fixture.invalid/caption",
            vssId: "a.en",
            languageCode: "en",
            name: "English (auto-generated)",
          },
        ]),
        false,
      ),
    ).toBe(true);
  });

  it("hides the control when neither source reports captions", () => {
    const button = {
      getAttribute: () => "false",
      classList: { contains: () => false },
    } as unknown as HTMLElement;
    const documentNode = { querySelector: () => button } as unknown as Document;

    expect(isYouTubeNativeCaptionsEnabled(documentNode)).toBe(false);
    expect(shouldShowYouTubeTranslationControl(createSnapshot([]), false)).toBe(false);
  });

  it("treats a disabled native subtitle button as unavailable, not enabled", () => {
    const button = {
      getAttribute: (name: string) => {
        if (name === "aria-pressed") {
          return "true";
        }
        if (name === "aria-disabled") {
          return "true";
        }
        return null;
      },
      classList: { contains: () => false },
    } as unknown as HTMLElement;
    const documentNode = { querySelector: () => button } as unknown as Document;

    expect(isYouTubeNativeCaptionsEnabled(documentNode)).toBe(false);
    expect(shouldShowYouTubeTranslationControl(createSnapshot([]), false)).toBe(false);
  });

  it("keeps a shown control during a transient incomplete response for the same video", () => {
    expect(shouldKeepYouTubeTranslationControl(createSnapshot([]), false, true)).toBe(true);
    expect(shouldKeepYouTubeTranslationControl(createSnapshot([]), false, false)).toBe(false);
  });
});
