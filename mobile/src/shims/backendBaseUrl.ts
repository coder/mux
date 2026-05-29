/**
 * Web-safe shim for the desktop backend URL helper.
 *
 * Expo web emits classic scripts, so evaluating `import.meta.env` from the
 * Vite-oriented implementation crashes before the app can render.
 */

// Non-greedy so we match the *first* "/apps/<slug>" segment in nested routes.
const APP_PROXY_BASE_PATH_RE = /(.*?\/apps\/[^/]+)(?:\/|$)/;

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Returns the path prefix up to and including `/apps/<slug>`.
 */
export function getAppProxyBasePathFromPathname(pathname: string): string | null {
  const match = APP_PROXY_BASE_PATH_RE.exec(pathname);
  if (!match) {
    return null;
  }

  const basePath = match[1];
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

function getExpoBackendEnvUrl(): string | null {
  const envUrl = process.env.EXPO_PUBLIC_BACKEND_URL ?? process.env.VITE_BACKEND_URL;
  if (typeof envUrl !== "string") {
    return null;
  }

  const trimmed = envUrl.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Returns a backend base URL without relying on `import.meta.env`.
 */
export function getBrowserBackendBaseUrl(): string {
  const envUrl = getExpoBackendEnvUrl();
  if (envUrl) {
    return stripTrailingSlashes(envUrl);
  }

  if (typeof window === "undefined") {
    return "";
  }

  const origin = window.location.origin;
  const appProxyBasePath = getAppProxyBasePathFromPathname(window.location.pathname);
  return stripTrailingSlashes(appProxyBasePath ? `${origin}${appProxyBasePath}` : origin);
}
