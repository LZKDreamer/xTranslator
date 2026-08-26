import { describe, expect, it } from "vitest";
import {
  YOUTUBE_PAGE_SELECTOR,
  findYouTubePageAnchors,
  isYouTubeNativeCaptionsEnabled,
  removeVideoExtensionMounts,
  readYouTubeRouteVideoId,
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
  it("reads the addressed video from watch and Shorts routes", () => {
    expect(readYouTubeRouteVideoId("https://www.youtube.com/watch?v=watch-video&list=PL1")).toBe("watch-video");
    expect(readYouTubeRouteVideoId("https://www.youtube.com/shorts/short-video?feature=share")).toBe("short-video");
    expect(readYouTubeRouteVideoId("https://www.youtube.com/results?search_query=test")).toBeNull();
  });

  it("finds the Shorts player without requiring watch-page metadata", () => {
    const player = { querySelector: () => null } as unknown as HTMLElement;
    const documentNode = {
      querySelector: (selector: string) => {
        if (selector === YOUTUBE_PAGE_SELECTOR.player) {
          return player;
        }
        return null;
      },
    } as unknown as Document;

    expect(YOUTUBE_PAGE_SELECTOR.player).toContain("#shorts-player");
    expect(YOUTUBE_PAGE_SELECTOR.captionWindow).toBe(".ytp-caption-window-container");
    expect(YOUTUBE_PAGE_SELECTOR.commentsRoot).toContain("engagement-panel-comments-section");
    expect(findYouTubePageAnchors(documentNode)).toEqual({
      player,
      playerRightControls: null,
      playerTopControls: null,
      title: null,
      description: null,
    });
  });

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

  it("cleans up video mounts without removing comment controls", () => {
    let selector = "";
    let removed = false;
    const documentNode = {
      querySelectorAll: (value: string) => {
        selector = value;
        return [{ remove: () => { removed = true; } }];
      },
    } as unknown as Document;

    removeVideoExtensionMounts(documentNode);

    expect(removed).toBe(true);
    expect(selector).toContain('data-xtranslator-mount="player"');
    expect(selector).toContain('data-xtranslator-mount="caption"');
    expect(selector).not.toContain("comment");
  });
});
