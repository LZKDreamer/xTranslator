// Pure helpers for building and recognizing YouTube caption (timedtext) requests.
//
// YouTube's `/api/timedtext` endpoint now (2025/2026) returns an empty 200 body
// unless the request carries a Proof-of-Origin token (`pot`) minted by the page's
// BotGuard runtime. The signed `baseUrl` from `playerCaptionsTracklistRenderer`
// must be extended with `c=WEB` and `fmt=json3` (and the captured `pot`) to get a
// usable response. This module only does URL logic; it never touches the DOM or
// the network so it can be unit-tested and shared by both the isolated content
// script and the MAIN world bridge.

const TIMEDTEXT_PATHNAME = "/api/timedtext";
const GET_TRANSCRIPT_PATHNAME = "/youtubei/v1/get_transcript";

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isCaptionRequestUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname !== "www.youtube.com") {
    return false;
  }
  return parsed.pathname === TIMEDTEXT_PATHNAME || parsed.pathname === GET_TRANSCRIPT_PATHNAME;
}

export function readCaptionToken(url: string): string | null {
  if (!isCaptionRequestUrl(url)) {
    return null;
  }
  const token = parseUrl(url)?.searchParams.get("pot");
  return token && token.length > 0 ? token : null;
}

export function readCaptionVideoId(url: string): string | null {
  if (!isCaptionRequestUrl(url)) {
    return null;
  }
  const videoId = parseUrl(url)?.searchParams.get("v");
  return videoId && videoId.length > 0 ? videoId : null;
}

export function buildCaptionTrackUrl(
  baseUrl: string,
  options: { captureToken?: string } = {},
): string {
  // The signed `baseUrl` is treated as an opaque string: we only append, and we
  // never re-serialize it (URLSearchParams would re-encode the signature/sparams).
  const separator = baseUrl.includes("?") ? "&" : "?";
  let url = `${baseUrl}${separator}c=WEB&fmt=json3`;
  if (options.captureToken) {
    url += `&pot=${options.captureToken}`;
  }
  return url;
}
