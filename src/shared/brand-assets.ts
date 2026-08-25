const BRAND_MARK_PATH = {
  dark: "icons/icon-32.png",
  light: "icons/icon-light-32.png",
} as const;

export type BrandMarkVariant = keyof typeof BRAND_MARK_PATH;

function resolveBrandMarkUrl(path: string): string | null {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(path);
    }
    return path;
  } catch {
    // A content script can outlive an extension reload. In that state the
    // runtime API throws instead of returning a URL; hide only the decorative
    // mark and keep the surrounding action usable.
    return null;
  }
}

/** Create the selected xTranslator logo mark for extension-page surfaces. */
export function createBrandMark(
  documentNode: Document,
  variant: BrandMarkVariant,
  size: number,
): HTMLImageElement {
  const image = documentNode.createElement("img");
  image.className = "xtranslator-brand-mark";
  const url = resolveBrandMarkUrl(BRAND_MARK_PATH[variant]);
  if (url) {
    image.src = url;
  } else {
    image.hidden = true;
  }
  image.alt = "";
  image.width = size;
  image.height = size;
  image.setAttribute("aria-hidden", "true");
  return image;
}
