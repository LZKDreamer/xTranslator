// Pure helpers for the "附上下文" selection option.
//
// Given a text node's full text and the selection offsets, this returns the
// sentence immediately before and after the sentence containing the selection, so
// the LLM can disambiguate the marked text. Only a single text node is supported —
// a cross-node selection simply gets no context (the caller still sends the exact
// selection). Sentences are split on `.`, `?`, `!` and their CJK equivalents.

const SENTENCE_TERMINATORS = /[.!?。！？]/u;

interface SentenceSpan {
  start: number;
  end: number;
}

function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (SENTENCE_TERMINATORS.test(text[index]!)) {
      let end = index + 1;
      while (end < text.length && /\s/u.test(text[end]!)) {
        end += 1;
      }
      spans.push({ start, end });
      start = end;
      index = end - 1;
    }
  }
  if (start < text.length) {
    spans.push({ start, end: text.length });
  }
  return spans;
}

export interface SelectionContextResult {
  contextBefore?: string;
  contextAfter?: string;
}

export function extractSentenceContext(fullText: string, start: number, end: number): SelectionContextResult {
  const safeStart = Math.max(0, Math.min(start, fullText.length));
  const safeEnd = Math.max(safeStart, Math.min(end, fullText.length));

  const spans = sentenceSpans(fullText);
  const selectedSpanIndex = spans.findIndex(
    (span) => span.start <= safeStart && span.start <= safeEnd && span.end >= safeEnd,
  );

  if (selectedSpanIndex === -1) {
    // Selection spans a sentence boundary (or there is no usable sentence); fall
    // back to no context rather than producing a misleading window.
    return {};
  }

  const before = selectedSpanIndex > 0 ? spans[selectedSpanIndex - 1] : undefined;
  const after = selectedSpanIndex < spans.length - 1 ? spans[selectedSpanIndex + 1] : undefined;

  return {
    ...(before ? { contextBefore: fullText.slice(before.start, before.end).trim() || undefined } : {}),
    ...(after ? { contextAfter: fullText.slice(after.start, after.end).trim() || undefined } : {}),
  };
}
