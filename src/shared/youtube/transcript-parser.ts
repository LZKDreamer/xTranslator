import type { TranscriptFragment, TranscriptSegment } from "./youtube-types";

function decodeXmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&#(x[\da-fA-F]+|\d+);/g, (_match, encoded: string) => {
      const codePoint = encoded.startsWith("x")
        ? Number.parseInt(encoded.slice(1), 16)
        : Number.parseInt(encoded, 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "";
    })
    .replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
      const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      return entities[entity] ?? "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function readRequiredNumberAttribute(attributes: string, name: "start" | "dur"): number | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']+)\\1`).exec(attributes);
  if (!match?.[2]) {
    return null;
  }

  const value = Number(match[2]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function createStableSegmentId(trackFingerprint: string, startMs: number, durationMs: number, sourceText: string): string {
  let hash = 2166136261;
  for (const character of `${trackFingerprint}\u0000${startMs}\u0000${durationMs}\u0000${sourceText}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  return `yt-${(hash >>> 0).toString(36)}`;
}

const XML_TRANSCRIPT = /^\s*(?:<\?xml[^>]*\?>\s*)?<transcript(?:\s[^>]*)?>([\s\S]*)<\/transcript>\s*$/;
const XML_TEXT_SEGMENT = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function normalizeTranscriptText(value: string): string {
  return value
    .replace(/\r\n?|[\u2028\u2029]/gu, " ")
    .replace(/\u00a0/gu, " ")
    .replace(/\u200B|\uFEFF/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeFragmentText(value: string): string {
  return value
    .replace(/\r\n?|[\u2028\u2029]/gu, " ")
    .replace(/\u00a0/gu, " ")
    .replace(/\u200B|\uFEFF/gu, "");
}

function normalizeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const seen = new Set<string>();
  const ordered = segments
    .filter((segment) => segment.durationMs > 0 && segment.sourceText.trim().length > 0)
    .sort((a, b) => a.startMs - b.startMs || a.durationMs - b.durationMs)
    .filter((segment) => {
      const key = `${segment.startMs}\u0000${segment.durationMs}\u0000${segment.sourceText}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  const normalized: TranscriptSegment[] = [];
  for (const segment of ordered) {
    const previous = normalized[normalized.length - 1];
    const segmentEndMs = segment.startMs + segment.durationMs;

    // Whisper/YouTube occasionally repeats the same caption with a shifted
    // duration. Treat an overlapping repeat as one event and keep the longer
    // timing range, matching the reference project's duplicate post-process.
    if (previous && previous.sourceText === segment.sourceText && segment.startMs <= previous.startMs + previous.durationMs) {
      previous.durationMs = Math.max(previous.startMs + previous.durationMs, segmentEndMs) - previous.startMs;
      continue;
    }

    // Different YouTube events may legitimately overlap. Preserve their
    // original audio anchors; shifting a later event to the previous end
    // makes the subtitle visibly lag behind speech. The display layer trims
    // only the preceding visual window when needed.
    normalized.push({ ...segment });
  }

  return normalized;
}

function toMilliseconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
  }
  return null;
}

function parseJson3Fragments(value: unknown): TranscriptFragment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((segment) => {
    if (!isRecord(segment) || typeof segment.utf8 !== "string" || !segment.utf8) {
      return [];
    }

    const text = normalizeFragmentText(segment.utf8);
    if (!text.trim()) {
      return [];
    }
    const offsetMs = toMilliseconds(segment.tOffsetMs);
    return [{
      text,
      ...(offsetMs !== null ? { offsetMs } : {}),
    }];
  });
}

export class YouTubeTranscriptParser {
  public parse(trackFingerprint: string, responseBody: string): TranscriptSegment[] | null {
    return this.parseXml(trackFingerprint, responseBody) ?? this.parseJson3(trackFingerprint, responseBody);
  }

  private parseXml(trackFingerprint: string, responseBody: string): TranscriptSegment[] | null {
    const transcript = XML_TRANSCRIPT.exec(responseBody);
    if (!transcript?.[1]) {
      return null;
    }

    const segments: TranscriptSegment[] = [];
    XML_TEXT_SEGMENT.lastIndex = 0;
    for (const match of transcript[1].matchAll(XML_TEXT_SEGMENT)) {
      const attributes = match[1];
      const sourceText = decodeXmlText(match[2] ?? "");
      const startSeconds = attributes ? readRequiredNumberAttribute(attributes, "start") : null;
      const durationSeconds = attributes ? readRequiredNumberAttribute(attributes, "dur") : null;
      if (startSeconds === null || durationSeconds === null || !sourceText) {
        continue;
      }

      const startMs = Math.round(startSeconds * 1000);
      const durationMs = Math.round(durationSeconds * 1000);
      segments.push({
        id: createStableSegmentId(trackFingerprint, startMs, durationMs, sourceText),
        startMs,
        durationMs,
        sourceText,
      });
    }

    const normalizedSegments = normalizeSegments(segments);
    return normalizedSegments.length > 0 ? normalizedSegments : null;
  }

  private parseJson3(trackFingerprint: string, responseBody: string): TranscriptSegment[] | null {
    let payload: unknown;
    try {
      payload = JSON.parse(responseBody) as unknown;
    } catch {
      return null;
    }

    // timedtext `fmt=json3` responses are the `{ events: [...] }` array (they may
    // or may not carry `wireMagic: "pb3"`). We validate the event fields instead
    // of requiring a specific envelope key, so we do not depend on an unverified
    // format contract.
    if (!isRecord(payload) || !Array.isArray(payload.events)) {
      return null;
    }

    const segments: TranscriptSegment[] = [];
    for (const event of payload.events) {
      if (!isRecord(event)) {
        continue;
      }

      const segs = Array.isArray(event.segs) ? event.segs : [];
      const startMs = toMilliseconds(event.tStartMs);
      const durationMs = toMilliseconds(event.dDurationMs);
      if (startMs === null || durationMs === null) {
        continue;
      }

      const fragments = parseJson3Fragments(segs);
      const sourceText = normalizeTranscriptText(fragments.map((fragment) => fragment.text).join(""));
      if (!sourceText) {
        continue;
      }

      segments.push({
        id: createStableSegmentId(trackFingerprint, startMs, durationMs, sourceText),
        startMs,
        durationMs,
        sourceText,
        ...(fragments.length > 0 ? { fragments } : {}),
      });
    }

    const normalizedSegments = normalizeSegments(segments);
    return normalizedSegments.length > 0 ? normalizedSegments : null;
  }
}

export function createCaptionTrackFingerprint(track: { vssId: string; languageCode: string; kind?: string }): string {
  return `${track.vssId}\u0000${track.languageCode}\u0000${track.kind ?? ""}`;
}
