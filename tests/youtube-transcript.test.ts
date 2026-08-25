import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { YouTubeTranscriptLoader } from "../src/shared/youtube/transcript-loader";
import { YouTubeTranscriptParser, createCaptionTrackFingerprint } from "../src/shared/youtube/transcript-parser";
import type { YouTubeCaptionTrack } from "../src/shared/youtube/youtube-types";

const track: YouTubeCaptionTrack = {
  baseUrl: "https://fixture.invalid/caption-track?signature=REDACTED",
  vssId: "a.en",
  languageCode: "en",
  kind: "asr",
  name: "English (auto-generated)",
};

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/youtube/${name}`, import.meta.url), "utf8");
}

describe("YouTubeTranscriptParser", () => {
  it("creates stable IDs from the selected track and validated XML timing", () => {
    const parser = new YouTubeTranscriptParser();
    const responseBody = readFixture("caption-track.xml");
    const fingerprint = createCaptionTrackFingerprint(track);
    const first = parser.parse(fingerprint, responseBody);
    const second = parser.parse(fingerprint, responseBody);

    expect(first).toHaveLength(2);
    expect(first).toEqual(second);
    expect(first?.[0]).toMatchObject({
      id: expect.stringMatching(/^yt-[a-z0-9]+$/),
      startMs: 0,
      durationMs: 1500,
      sourceText: "Sanitized & verified first segment.",
    });
  });

  it("rejects JSON payloads without a valid events array", () => {
    expect(new YouTubeTranscriptParser().parse(createCaptionTrackFingerprint(track), readFixture("unsupported-caption-payload.json"))).toBeNull();
  });

  it("accepts the versioned JSON3 fixture only after validating its event fields", () => {
    const segments = new YouTubeTranscriptParser().parse(
      createCaptionTrackFingerprint(track),
      readFixture("caption-track.json"),
    );
    expect(segments?.[0]).toMatchObject({ startMs: 0, durationMs: 1500, sourceText: "Sanitized JSON fixture segment." });
  });

  it("accepts a bare { events } json3 payload without requiring a wireMagic envelope", () => {
    const segments = new YouTubeTranscriptParser().parse(
      createCaptionTrackFingerprint(track),
      readFixture("caption-track-json3.json"),
    );
    expect(segments).toHaveLength(2);
    expect(segments?.[0]).toMatchObject({
      startMs: 0,
      durationMs: 1500,
      sourceText: "Sanitized JSON3 segment.",
      fragments: [
        { text: "Sanitized ", offsetMs: 0 },
        { text: "JSON3 segment.", offsetMs: 700 },
      ],
    });
  });

  it("skips malformed events and accepts string timings instead of failing the whole payload", () => {
    const segments = new YouTubeTranscriptParser().parse(
      createCaptionTrackFingerprint(track),
      readFixture("caption-track-json3-lenient.json"),
    );
    expect(segments).toHaveLength(2);
    expect(segments?.[0]).toMatchObject({ startMs: 0, durationMs: 1500, sourceText: "First real segment." });
    expect(segments?.[1]).toMatchObject({ startMs: 1500, durationMs: 500, sourceText: "Second segment with string timings." });
  });

  it("sorts valid events and removes exact duplicate events", () => {
    const payload = JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "Second" }] },
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "First" }] },
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "First" }] },
      ],
    });

    const segments = new YouTubeTranscriptParser().parse(createCaptionTrackFingerprint(track), payload);
    expect(segments?.map((segment) => segment.sourceText)).toEqual(["First", "Second"]);
  });

  it("extends overlapping duplicate events but preserves other event timestamps", () => {
    const payload = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Repeated" }] },
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "Repeated" }] },
        { tStartMs: 2500, dDurationMs: 1000, segs: [{ utf8: "Next" }] },
      ],
    });

    const segments = new YouTubeTranscriptParser().parse(createCaptionTrackFingerprint(track), payload);
    expect(segments).toEqual([
      expect.objectContaining({ startMs: 0, durationMs: 3000, sourceText: "Repeated" }),
      expect.objectContaining({ startMs: 2500, durationMs: 1000, sourceText: "Next" }),
    ]);
  });
});

describe("YouTubeTranscriptLoader", () => {
  it("exposes temporary URL failures as retryable errors without persisting a URL", async () => {
    const loader = new YouTubeTranscriptLoader(async () => ({ ok: false, text: async () => "" }));
    await expect(loader.load(track)).resolves.toEqual({ status: "error", reason: "http", canRetry: true });
  });

  it("exposes malformed payloads as retryable errors", async () => {
    const loader = new YouTubeTranscriptLoader(async () => ({
      ok: true,
      text: async () => readFixture("unsupported-caption-payload.json"),
    }));
    await expect(loader.load(track)).resolves.toEqual({
      status: "error",
      reason: "unsupported-format",
      canRetry: true,
    });
  });
});
