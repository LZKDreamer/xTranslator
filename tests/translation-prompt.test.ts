import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from "../src/shared/translation/prompt";
import type { TranslationBlockInput } from "../src/shared/translation/translation-types";

const blocks: TranslationBlockInput[] = [
  { id: "blk-aa", segmentIds: ["a"], startMs: 0, endMs: 2000, sourceText: "first\nsecond", isSilent: false },
  { id: "blk-bb", segmentIds: ["b"], startMs: 2000, endMs: 4000, sourceText: "next [music]", isSilent: false },
];

describe("translation prompt", () => {
  it("exposes a versioned prompt contract for cache versioning", () => {
    expect(PROMPT_VERSION).toMatch(/^prompt-/);
  });

  it("instructs the model about languages, merging and non-verbal markers", () => {
    const system = buildSystemPrompt("en", "zh-Hans");
    expect(system).toContain("from en to zh-Hans");
    expect(system).toContain("JSON object per line");
    expect(system).toContain("untrusted data");
    expect(system).toContain("merge");
    expect(system).toContain("non-verbal");
    expect(system).toContain("newline character");
    expect(system).toContain("natural, conversational voice");
    expect(system).toContain("Avoid stiff, literal, literary, news-like or overly formal phrasing");
    expect(system).toContain("exactly one concise subtitle line");
    expect(system).toContain("Preserve every clause, instruction, qualifier and trailing phrase");
    expect(system).toContain("preserve natural sentence punctuation");
    expect(system).toContain("empty spoken fillers");
    expect(system).toContain("at most two natural lines");
    expect(system).toContain("raw cue boundaries as timing hints");
  });

  it("numbers blocks and escapes newlines in the user prompt", () => {
    const user = buildUserPrompt(blocks);
    expect(user).toContain("1. [blk-aa]");
    expect(user).toContain("[blk-bb]");
    expect(user).toContain("first\\nsecond");
    expect(user.indexOf("1.")).toBeLessThan(user.indexOf("2."));
  });

  it("includes video metadata without including neighboring caption text", () => {
    const user = buildUserPrompt([blocks[0]!], { title: "Video title", description: "Video description" });
    expect(user).toContain('title "Video title"');
    expect(user).toContain('description "Video description"');
    expect(user).not.toContain("context-before");
    expect(user).not.toContain("context-after");
  });

  it("forbids the model from changing timing or borrowing adjacent content", () => {
    const system = buildSystemPrompt("en", "zh-Hans");
    expect(system).toContain("Do not return, infer or modify timestamps");
    expect(system).toContain("Do not complete it with neighboring blocks");
    expect(system).toContain("preserve that incomplete ending");
  });
});
