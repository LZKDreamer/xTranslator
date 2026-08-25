import type { YouTubeCaptionTrack, YouTubeVideoSnapshot } from "./youtube-types";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function readString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCaptionTrack(value: unknown): YouTubeCaptionTrack | null {
  if (!isRecord(value)) {
    return null;
  }

  const baseUrl = readString(value, "baseUrl");
  const vssId = readString(value, "vssId");
  const languageCode = readString(value, "languageCode");
  const nameValue = value.name;
  const name = isRecord(nameValue) ? readString(nameValue, "simpleText") : null;

  if (!baseUrl || !vssId || !languageCode || !name) {
    return null;
  }

  return {
    baseUrl,
    vssId,
    languageCode,
    name,
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    ...(typeof value.isTranslatable === "boolean" ? { isTranslatable: value.isTranslatable } : {}),
  };
}

function readTranslationLanguages(value: unknown): Array<{ languageCode: string; name: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const languageCode = readString(item, "languageCode");
    const languageName = item.languageName;
    const name = isRecord(languageName) ? readString(languageName, "simpleText") : null;
    return languageCode && name ? [{ languageCode, name }] : [];
  });
}

function parseLengthSeconds(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }

  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

export function parseYouTubePlayerResponse(value: unknown): YouTubeVideoSnapshot | null {
  if (!isRecord(value) || !isRecord(value.videoDetails)) {
    return null;
  }

  const videoId = readString(value.videoDetails, "videoId");
  const title = readString(value.videoDetails, "title");
  const author = readString(value.videoDetails, "author");
  const shortDescription = readString(value.videoDetails, "shortDescription");
  const lengthSeconds = parseLengthSeconds(value.videoDetails.lengthSeconds);
  const captions = isRecord(value.captions) ? value.captions : null;
  // YouTube omits `captions` (or the track list) when a video has no subtitles.
  // That is a valid video state, not an unsupported page.
  const trackList = captions && isRecord(captions.playerCaptionsTracklistRenderer)
    ? captions.playerCaptionsTracklistRenderer
    : {};

  if (!videoId || !title || !author || shortDescription === null || lengthSeconds === null) {
    return null;
  }

  const captionTracks = Array.isArray(trackList.captionTracks)
    ? trackList.captionTracks.flatMap((track) => {
        const parsedTrack = readCaptionTrack(track);
        return parsedTrack ? [parsedTrack] : [];
      })
    : [];

  return {
    videoId,
    title,
    author,
    lengthSeconds,
    shortDescription,
    captionTracks,
    translationLanguages: readTranslationLanguages(trackList.translationLanguages),
  };
}

function extractBalancedJson(source: string, startIndex: number): string | null {
  const jsonStart = source.indexOf("{", startIndex);
  if (jsonStart < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;
  for (let index = jsonStart; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(jsonStart, index + 1);
      }
    }
  }

  return null;
}

const PLAYER_RESPONSE_ASSIGNMENT = /(?:\bvar\s+)?ytInitialPlayerResponse\s*=/g;

export function parseInitialPlayerResponse(scriptTexts: Iterable<string>): YouTubeVideoSnapshot | null {
  for (const scriptText of scriptTexts) {
    PLAYER_RESPONSE_ASSIGNMENT.lastIndex = 0;
    const assignment = PLAYER_RESPONSE_ASSIGNMENT.exec(scriptText);
    if (!assignment) {
      continue;
    }

    const json = extractBalancedJson(scriptText, assignment.index + assignment[0].length);
    if (!json) {
      return null;
    }

    try {
      return parseYouTubePlayerResponse(JSON.parse(json) as unknown);
    } catch {
      return null;
    }
  }

  return null;
}
