import { getAppProxyBasePathFromPathname, stripAppProxyBasePath } from "@/common/appProxyBasePath";

// window.location can be missing in some test, SSR, or embed contexts even when
// window itself exists. Guard both so module initialization cannot throw and leave
// downstream importers with a TDZ-poisoned export.
function readInitialAppProxyBasePath(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const location = (window as { location?: { pathname?: string } }).location;
  if (!location || typeof location.pathname !== "string") {
    return null;
  }

  return getAppProxyBasePathFromPathname(location.pathname);
}

export const INITIAL_APP_PROXY_BASE_PATH = readInitialAppProxyBasePath();

function normalizeRootRelativePath(pathname: string): string {
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

export function stripInitialAppProxyBasePathFromPathname(pathname: string): string {
  if (!INITIAL_APP_PROXY_BASE_PATH) {
    return pathname;
  }

  const strippedPathname = stripAppProxyBasePath(pathname);
  return strippedPathname.basePath === INITIAL_APP_PROXY_BASE_PATH
    ? strippedPathname.routePathname
    : pathname;
}

export function prependInitialAppProxyBasePath(pathname: string): string {
  const rootRelativePathname = normalizeRootRelativePath(pathname);
  return INITIAL_APP_PROXY_BASE_PATH
    ? `${INITIAL_APP_PROXY_BASE_PATH}${rootRelativePathname}`
    : rootRelativePathname;
}

export function resolveBrowserAssetUrl(pathname: string): string {
  const proxiedPathname = prependInitialAppProxyBasePath(pathname);
  return typeof document === "undefined"
    ? proxiedPathname
    : new URL(proxiedPathname, document.baseURI).toString();
}
