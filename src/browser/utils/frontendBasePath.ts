import { getAppProxyBasePathFromPathname, stripAppProxyBasePath } from "@/common/appProxyBasePath";

export const INITIAL_APP_PROXY_BASE_PATH =
  typeof window === "undefined" ? null : getAppProxyBasePathFromPathname(window.location.pathname);

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
