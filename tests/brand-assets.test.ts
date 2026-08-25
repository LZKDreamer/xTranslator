import { describe, expect, it } from "vitest";
import { createBrandMark } from "../src/shared/brand-assets";

describe("brand mark", () => {
  it("falls back to an inline mark when the extension image cannot load", () => {
    let onError: (() => void) | undefined;
    const image = {
      dataset: {} as Record<string, string>,
      addEventListener: (_type: string, listener: () => void) => {
        onError = listener;
      },
      setAttribute: () => undefined,
      src: "",
      className: "",
      alt: "",
      width: 0,
      height: 0,
    } as unknown as HTMLImageElement;
    const documentNode = { createElement: () => image } as unknown as Document;

    createBrandMark(documentNode, "dark", 20);
    expect(image.src).toBe("icons/icon-32.png");

    onError?.();

    expect(image.src).toMatch(/^data:image\/svg\+xml,/);
    expect(image.dataset.fallbackApplied).toBe("true");
  });
});
