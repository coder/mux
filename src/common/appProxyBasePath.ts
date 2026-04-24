const APP_PROXY_BASE_PATH_RE = /^\/@[^/]+\/[^/]+(?:\/[^/]+)?\/apps\/[^/]+(?:\/|$)/;

function hasUnsafeLeadingDoubleSlash(pathname: string): boolean {
  return pathname.startsWith("//");
}

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function getAppProxyBasePathFromPathname(pathname: string): string | null {
  if (hasUnsafeLeadingDoubleSlash(pathname)) {
    return null;
  }

  const match = APP_PROXY_BASE_PATH_RE.exec(pathname);
  if (!match) {
    return null;
  }

  return stripTrailingSlash(match[0]);
}

export function stripAppProxyBasePath(pathname: string): {
  basePath: string | null;
  routePathname: string;
} {
  const basePath = getAppProxyBasePathFromPathname(pathname);
  if (!basePath) {
    return { basePath: null, routePathname: pathname };
  }

  const routePathname = pathname.slice(basePath.length);
  return {
    basePath,
    routePathname: routePathname.length === 0 ? "/" : routePathname,
  };
}
