/**
 * Browser/server mode backend URL helpers.
 *
 * When Mux is served behind a path-based app proxy (e.g. Coder with subdomain=false),
 * the app is mounted under a prefix like:
 *
 *   /@user/<workspace>/apps/<slug>
 *
 * In those cases, backend routes (ORPC WebSocket + /auth/*) also live under that
 * prefix, so the frontend must include it when constructing URLs.
 */

// Non-greedy so we match the *first* "/apps/<slug>" segment in nested routes.
const APP_PROXY_BASE_PATH_RE = /(.*?\/apps\/[^/]+)(?:\/|$)/;

/**
 * Returns the path prefix up to and including `/apps/<slug>`.
 *
 * Examples:
 * - "/@u/ws/apps/mux/" -> "/@u/ws/apps/mux"
 * - "/@u/ws/apps/mux/settings" -> "/@u/ws/apps/mux"
 */
export function getAppProxyBasePathFromPathname(pathname: string): string | null {
  const match = APP_PROXY_BASE_PATH_RE.exec(pathname);
  if (!match) {
    return null;
  }

  const basePath = match[1];
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Returns the backend base URL for browser/server mode.
 *
 * - Respects VITE_BACKEND_URL if set.
 * - Otherwise uses window.location.origin, and (when detected) appends the
 *   Coder-style app proxy base path.
 *
 * Always returns a string with no trailing slash.
 */
export function getBrowserBackendBaseUrl(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  const envUrl = import.meta.env.VITE_BACKEND_URL;

  if (typeof envUrl === "string" && envUrl.trim().length > 0) {
    return stripTrailingSlashes(envUrl.trim());
  }

  const origin = window.location.origin;
  const appProxyBasePath = getAppProxyBasePathFromPathname(window.location.pathname);

  return stripTrailingSlashes(appProxyBasePath ? `${origin}${appProxyBasePath}` : origin);
}
