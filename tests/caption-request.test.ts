import { describe, expect, it } from "vitest";
import {
  buildCaptionTrackUrl,
  isCaptionRequestUrl,
  readCaptionToken,
  readCaptionVideoId,
} from "../src/shared/youtube/caption-request";

const baseUrl =
  "https://www.youtube.com/api/timedtext?v=8vvWTz6N7Qg&ei=2kuMapiBGIfessUPjYv0wQM&caps=asr&hl=zh-CN&expire=1787604554&sparams=ip,ipbits,expire,v,ei,caps&signature=ABC123DEF&key=yt8&kind=asr&lang=en&variant=gemini";

describe("caption-request", () => {
  it("recognizes timedtext and get_transcript caption URLs only on YouTube", () => {
    expect(isCaptionRequestUrl(baseUrl)).toBe(true);
    expect(isCaptionRequestUrl("https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false")).toBe(true);
    expect(isCaptionRequestUrl("https://www.youtube.com/watch?v=8vvWTz6N7Qg")).toBe(false);
    expect(isCaptionRequestUrl("https://example.com/api/timedtext?v=abc")).toBe(false);
    expect(isCaptionRequestUrl("not a url")).toBe(false);
  });

  it("reads the proof-of-origin token bound to the caption URL", () => {
    expect(readCaptionToken(`${baseUrl}&c=WEB&fmt=json3&pot=PO0001`)).toBe("PO0001");
    expect(readCaptionToken(baseUrl)).toBeNull();
  });

  it("reads the video id from a caption URL", () => {
    expect(readCaptionVideoId(baseUrl)).toBe("8vvWTz6N7Qg");
  });

  it("extends the signed baseUrl with the format/token query and preserves the original URL", () => {
    const url = buildCaptionTrackUrl(baseUrl, { captureToken: "PO0001" });
    expect(url).toBe(`${baseUrl}&c=WEB&fmt=json3&pot=PO0001`);
    // The original signature/sparams bytes are untouched.
    expect(url).toContain("signature=ABC123DEF");
  });

  it("omits the pot when no token is available", () => {
    expect(buildCaptionTrackUrl(baseUrl)).toBe(`${baseUrl}&c=WEB&fmt=json3`);
  });

  it("uses a query separator when the baseUrl has no query string", () => {
    expect(buildCaptionTrackUrl("https://www.youtube.com/api/timedtext")).toBe(
      "https://www.youtube.com/api/timedtext?c=WEB&fmt=json3",
    );
  });
});
