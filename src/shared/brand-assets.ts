const BRAND_MARK_PATH = {
  dark: "icons/icon-32.png",
  light: "icons/icon-light-32.png",
} as const;

const FALLBACK_BRAND_MARK_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23192345'/%3E%3Cpath d='M9 8l15 16M23 8L8 24' fill='none' stroke='%2333d6ff' stroke-linecap='round' stroke-width='4'/%3E%3Cpath d='M10 8l14 16M22 8L8 24' fill='none' stroke='%23a78bfa' stroke-linecap='round' stroke-width='2'/%3E%3C/svg%3E";

export type BrandMarkVariant = keyof typeof BRAND_MARK_PATH;

function resolveBrandMarkUrl(path: string): string | null {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(path);
    }
    return path;
  } catch {
    // A content script can outlive an extension reload. In that state the
    // runtime API throws instead of returning a URL; the caller will use an
    // inline fallback and keep the surrounding action usable.
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
  const useFallback = (): void => {
    if (image.dataset.fallbackApplied === "true") {
      return;
    }
    image.dataset.fallbackApplied = "true";
    image.src = FALLBACK_BRAND_MARK_URL;
  };
  image.addEventListener("error", useFallback, { once: true });
  image.src = url ?? FALLBACK_BRAND_MARK_URL;
  image.alt = "";
  image.width = size;
  image.height = size;
  image.setAttribute("aria-hidden", "true");
  return image;
}
