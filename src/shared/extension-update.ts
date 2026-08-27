export const UPDATE_MANIFEST_URL = "https://cdn.jsdelivr.net/gh/LZKDreamer/xTranslator@latest/public/updates/latest.json";

export interface ExtensionUpdate {
  version: string;
  downloadUrl: string;
}

export type ExtensionUpdateCheck =
  | { state: "available"; update: ExtensionUpdate }
  | { state: "up-to-date" }
  | { state: "unavailable" };

function parseVersion(version: string): number[] | null {
  const parts = version.split(".");
  if (parts.length === 0 || parts.length > 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,4})$/u.test(part))) {
    return null;
  }

  const values = parts.map(Number);
  return values.every((part) => part <= 65535) ? values : null;
}

export function compareExtensionVersions(left: string, right: string): number | null {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) {
    return null;
  }

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function getAvailableUpdate(value: unknown, installedVersion: string): ExtensionUpdate | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const { version, downloadUrl } = value as Partial<ExtensionUpdate>;
  if (typeof version !== "string" || typeof downloadUrl !== "string") {
    return null;
  }

  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "cdn.jsdelivr.net" ||
    !url.pathname.startsWith("/gh/LZKDreamer/xTranslator@v") ||
    !url.pathname.endsWith(".zip")
  ) {
    return null;
  }

  const comparison = compareExtensionVersions(version, installedVersion);
  return comparison !== null && comparison > 0 ? { version, downloadUrl } : null;
}

export async function checkForExtensionUpdate(
  installedVersion: string,
  request: typeof fetch = fetch,
): Promise<ExtensionUpdateCheck> {
  try {
    const response = await request(UPDATE_MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) {
      return { state: "unavailable" };
    }

    const update = getAvailableUpdate(await response.json(), installedVersion);
    return update ? { state: "available", update } : { state: "up-to-date" };
  } catch {
    return { state: "unavailable" };
  }
}
