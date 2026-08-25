// Validation of the provider's block-level translation reply.
//
// The model is asked to emit one JSON object per block. The validator parses the
// reply leniently (tolerating a code fence or stray prose), matches ids back to
// the expected blocks, and reports which inputs were matched and which were not
// so the orchestrator can retry just the missing ones. An empty `text` is valid
// only for a silent block; spoken blocks must never silently lose their translation.

import type { BlockTranslation, ValidatedBlockTranslation } from "./translation-types";

type ExpectedTranslation = { id: string; isSilent?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractFirstJsonObject(line: string): string | null {
  const start = line.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
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
        return line.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseJsonLine(line: string): { id: string; text: string } | null {
  const candidate = extractFirstJsonObject(line);
  if (!candidate) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.text !== "string") {
    return null;
  }

  const id = parsed.id.trim();
  if (!id) {
    return null;
  }
  return {
    id,
    // A provider occasionally returns a wrapped line despite the prompt. Keep
    // the block as one cue instead of letting an embedded newline become a
    // second visual subtitle line with different timing semantics.
    text: parsed.text.replace(/\r?\n+/gu, " ").replace(/[ \t]+/gu, " ").trim(),
  };
}

export class TranslationResultValidator {
  public validate(expected: readonly ExpectedTranslation[], reply: string): ValidatedBlockTranslation {
    const expectedById = new Map<string, ExpectedTranslation>();
    for (const block of expected) {
      expectedById.set(block.id, block);
    }

    const matched: BlockTranslation[] = [];
    const seen = new Set<string>();

    for (const line of reply.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("```")) {
        continue;
      }

      const parsed = parseJsonLine(trimmed);
      const expectedBlock = parsed ? expectedById.get(parsed.id) : undefined;
      if (!parsed || !expectedBlock || seen.has(parsed.id) || (!parsed.text && expectedBlock.isSilent === false)) {
        continue;
      }

      matched.push({ id: parsed.id, translatedText: parsed.text });
      seen.add(parsed.id);
    }

    const missingIds = Array.from(expectedById.keys()).filter((id) => !seen.has(id));
    return { matched, missingIds };
  }
}
