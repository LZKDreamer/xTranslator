import { describe, expect, it } from "vitest";
import { batchTextItems } from "../src/shared/translation/text-batch";

describe("batchTextItems", () => {
  it("keeps all items in one batch when the budget allows", () => {
    const items = [
      { id: "a", sourceText: "hi" },
      { id: "b", sourceText: "there" },
    ];
    const batches = batchTextItems(items, 64_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(items);
  });

  it("splits into multiple batches and never splits an item", () => {
    // A tiny context window caps the budget near 1 token, so every item gets its
    // own batch.
    const items = [
      { id: "a", sourceText: "hello world" },
      { id: "b", sourceText: "goodbye world" },
    ];
    const batches = batchTextItems(items, 100);
    expect(batches.length).toBeGreaterThan(1);
    const flattened = batches.flat();
    expect(flattened).toEqual(items);
  });

  it("accounts for surrounding context token cost", () => {
    const light = { id: "a", sourceText: "target" };
    const heavy = { id: "b", sourceText: "target", contextBefore: "A ".repeat(200), contextAfter: "B ".repeat(200) };
    // Window ~700 -> input budget ~50 tokens. The light item (~18 tokens) fits,
    // but the heavy item (~218 tokens) never shares a batch with it.
    const batches = batchTextItems([light, heavy], 700);
    expect(batches).toEqual([[light], [heavy]]);
  });

  it("reserves request context and output capacity", () => {
    const items = [
      { id: "a", sourceText: "x".repeat(1200) },
      { id: "b", sourceText: "y".repeat(1200) },
    ];
    const batches = batchTextItems(items, 64_000, { inputContextTokens: 100, maxOutputTokens: 512 });
    expect(batches).toEqual([[items[0]], [items[1]]]);
  });
});
