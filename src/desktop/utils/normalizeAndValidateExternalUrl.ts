import {
  normalizeLocalhostProxyUrl,
  type NormalizeLocalhostProxyUrlOptions,
} from "@/common/utils/localhostProxyUrl";

const ALLOWED_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

export function normalizeAndValidateExternalUrl(
  options: NormalizeLocalhostProxyUrlOptions
): string | null {
  const normalizedUrl = normalizeLocalhostProxyUrl(options);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return null;
  }

  // Normalize loopback URLs before checking the final scheme so the desktop shell
  // never receives rewritten file:/javascript:/etc targets.
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsedUrl.protocol)) {
    return null;
  }

  return normalizedUrl;
}
