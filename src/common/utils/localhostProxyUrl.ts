export type LocalhostLoopbackHost = "localhost" | "127.0.0.1" | "0.0.0.0" | "::1";

export interface NormalizeLocalhostProxyUrlOptions {
  url: string;
  localhostProxyTemplate?: string | null;
  browserHost?: string | null;
}

const PORT_TEMPLATE_VARIABLE = "{{port}}";
const HOST_TEMPLATE_VARIABLE = "{{host}}";
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isLoopbackHost(hostname: string): hostname is LocalhostLoopbackHost {
  const normalizedHost = stripIpv6Brackets(hostname.trim().toLowerCase());
  return LOOPBACK_HOSTS.has(normalizedHost);
}

function isHttpProtocol(protocol: string): protocol is "http:" | "https:" {
  return protocol === "http:" || protocol === "https:";
}

function getTemplatePort(url: URL): string {
  if (url.port.length > 0) {
    return url.port;
  }

  return url.protocol === "https:" ? "443" : "80";
}

export function normalizeLocalhostProxyUrl(options: NormalizeLocalhostProxyUrlOptions): string {
  const template = options.localhostProxyTemplate?.trim();
  if (!template?.includes(PORT_TEMPLATE_VARIABLE)) {
    return options.url;
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(options.url);
  } catch {
    return options.url;
  }

  if (!isHttpProtocol(sourceUrl.protocol) || !isLoopbackHost(sourceUrl.hostname)) {
    return options.url;
  }

  const normalizedBrowserHost = options.browserHost?.trim();
  const hostReplacement =
    normalizedBrowserHost != null && normalizedBrowserHost.length > 0
      ? normalizedBrowserHost
      : sourceUrl.hostname;

  const templatedUrl = template
    .replaceAll(PORT_TEMPLATE_VARIABLE, getTemplatePort(sourceUrl))
    .replaceAll(HOST_TEMPLATE_VARIABLE, hostReplacement);

  let rewrittenUrl: URL;
  try {
    rewrittenUrl = new URL(templatedUrl);
  } catch {
    return options.url;
  }

  // Preserve proxy base path from template (e.g. /proxy/3000/) and
  // append clicked request target path.
  const templatePathBase = rewrittenUrl.pathname.replace(/\/+$/, "");
  rewrittenUrl.pathname = templatePathBase + sourceUrl.pathname;
  rewrittenUrl.search = sourceUrl.search;
  rewrittenUrl.hash = sourceUrl.hash;

  return rewrittenUrl.toString();
}
