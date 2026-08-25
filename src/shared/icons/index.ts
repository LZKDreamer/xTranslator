// Vendored icon set.
//
// The engineering standards let us either depend on an icon library or inline the
// icons we actually need. This project does not hard-depend on `lucide`: the
// icons below (plus `createElement`/`createIcons`) are vendored from lucide
// (ISC-licensed) into this repo so the extension bundle carries no icon runtime
// dependency. Only add an icon here if it is actually used, and keep its `name`
// matching the `data-lucide` / icon usage in markup.

export interface IconDefinition {
  name: string;
  elementMarkup: string;
}

const SVG_ATTRIBUTES =
  'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

function svgFromIcon(icon: IconDefinition): SVGElement {
  const container = document.createElement("div");
  container.innerHTML = `<svg ${SVG_ATTRIBUTES}>${icon.elementMarkup}</svg>`;
  const svg = container.firstElementChild;
  if (!(svg instanceof SVGElement)) {
    throw new Error(`Invalid icon definition: ${icon.name}`);
  }
  return svg;
}

export function createElement(icon: IconDefinition): SVGElement {
  return svgFromIcon(icon);
}

export function createIcons(options: { icons: Record<string, IconDefinition> }): void {
  for (const icon of Object.values(options.icons)) {
    const elements = document.querySelectorAll<Element>(`[data-lucide="${icon.name}"]`);
    for (const element of elements) {
      element.replaceWith(svgFromIcon(icon));
    }
  }
}

export const Settings: IconDefinition = {
  name: "settings",
  elementMarkup:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};

export const Check: IconDefinition = {
  name: "check",
  elementMarkup: '<path d="M20 6 9 17l-5-5"/>',
};

export const CircleAlert: IconDefinition = {
  name: "circle-alert",
  elementMarkup:
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
};

export const MousePointer2: IconDefinition = {
  name: "mouse-pointer-2",
  elementMarkup: '<path d="m4 4 7.07 17 2.51-7.39L21 11.07z"/>',
};

export const Copy: IconDefinition = {
  name: "copy",
  elementMarkup:
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
};

export const X: IconDefinition = {
  name: "x",
  elementMarkup: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

export const LoaderCircle: IconDefinition = {
  name: "loader-circle",
  elementMarkup: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
};
