export const BROWSER_URL_MAX_LENGTH = 2048;

const UNSAFE_BROWSER_URL_PROTOCOLS = ["javascript:", "data:", "file:", "vbscript:"] as const;
const ALLOWED_BROWSER_URL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

export type NormalizeBrowserUrlResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false; error: string };

export function normalizeBrowserUrl(raw: string): NormalizeBrowserUrlResult {
  const trimmedUrl = raw.trim();
  if (trimmedUrl.length === 0) {
    return { ok: false, error: "URL is required" };
  }

  // about:blank is the browser-session default, but manual navigation to it would
  // trip BrowserSessionBackend.refreshNavigationMetadata's external-close detector,
  // which treats a real-page -> about:blank transition as the browser closing.
  if (trimmedUrl.toLowerCase() === "about:blank") {
    return { ok: false, error: "Cannot navigate to about:blank" };
  }

  const lowercasedUrl = trimmedUrl.toLowerCase();
  if (UNSAFE_BROWSER_URL_PROTOCOLS.some((protocol) => lowercasedUrl.startsWith(protocol))) {
    return {
      ok: false,
      error: "Unsupported URL protocol. Only http:// and https:// URLs are allowed.",
    };
  }

  const candidateUrl = trimmedUrl.includes("://") ? trimmedUrl : `https://${trimmedUrl}`;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (!ALLOWED_BROWSER_URL_PROTOCOLS.has(parsedUrl.protocol)) {
    return {
      ok: false,
      error: "Unsupported URL protocol. Only http:// and https:// URLs are allowed.",
    };
  }

  const normalizedUrl = parsedUrl.href;
  if (normalizedUrl.length > BROWSER_URL_MAX_LENGTH) {
    return {
      ok: false,
      error: `URL must be ${BROWSER_URL_MAX_LENGTH} characters or fewer`,
    };
  }

  return { ok: true, normalizedUrl };
}
