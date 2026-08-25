import { describe, expect, it } from "vitest";
import { extractSentenceContext } from "../src/shared/selection/selection-context";

describe("selection sentence context", () => {
  it("returns the preceding and following sentence for a mid-document selection", () => {
    const full = "Hello world. This is the target. Goodbye world.";
    const start = full.indexOf("the target");
    const end = start + "the target".length;
    const result = extractSentenceContext(full, start, end);
    expect(result.contextBefore).toBe("Hello world.");
    expect(result.contextAfter).toBe("Goodbye world.");
  });

  it("omits the preceding sentence for a selection in the first sentence", () => {
    const full = "First sentence here. Second sentence.";
    const start = full.indexOf("sentence");
    const end = start + "sentence".length;
    const result = extractSentenceContext(full, start, end);
    expect(result.contextBefore).toBeUndefined();
    expect(result.contextAfter).toBe("Second sentence.");
  });

  it("omits the trailing sentence for a selection in the last sentence", () => {
    const full = "First sentence. Last sentence.";
    const start = full.indexOf("Last");
    const end = start + "Last sentence".length;
    const result = extractSentenceContext(full, start, end);
    expect(result.contextBefore).toBe("First sentence.");
    expect(result.contextAfter).toBeUndefined();
  });

  it("handles CJK terminators", () => {
    const full = "你好。这是目标。再见。";
    const start = full.indexOf("这是目标");
    const end = start + "这是目标".length;
    const result = extractSentenceContext(full, start, end);
    expect(result.contextBefore).toBe("你好。");
    expect(result.contextAfter).toBe("再见。");
  });

  it("returns no context when the selection spans a sentence boundary", () => {
    const full = "One. Two. Three.";
    // A range crossing from sentence 2 into sentence 3 has no single containing
    // sentence, so no context window is returned.
    const start = full.indexOf("Two");
    const end = full.length;
    expect(extractSentenceContext(full, start, end)).toEqual({});
  });
});
