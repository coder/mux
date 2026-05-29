const CODER_PORT_PREFIX_PATTERN = /^\d+$/;

interface ResolveBrowserLocalhostProxyTemplateOptions {
  injectedTemplate?: string | null;
  browserProtocol?: string | null;
  browserHostname?: string | null;
  browserPort?: string | null;
}

function normalizeInjectedTemplate(injectedTemplate?: string | null): string | null {
  const normalizedTemplate = injectedTemplate?.trim();
  return normalizedTemplate && normalizedTemplate.length > 0 ? normalizedTemplate : null;
}

function isHttpProtocol(protocol: string): protocol is "http:" | "https:" {
  return protocol === "http:" || protocol === "https:";
}

function deriveCoderTemplateFromBrowserHost(
  browserProtocol?: string | null,
  browserHostname?: string | null,
  browserPort?: string | null
): string | null {
  const normalizedProtocol = browserProtocol?.trim().toLowerCase();
  if (normalizedProtocol == null || !isHttpProtocol(normalizedProtocol)) {
    return null;
  }

  const normalizedHostname = browserHostname?.trim().toLowerCase();
  if (normalizedHostname == null || normalizedHostname.length === 0) {
    return null;
  }

  const hostLabels = normalizedHostname.split(".");
  if (hostLabels.length < 2) {
    return null;
  }

  const [firstLabel, ...remainingLabels] = hostLabels;
  const [portPrefix, ...suffixSegments] = firstLabel.split("--");
  if (suffixSegments.length === 0 || !CODER_PORT_PREFIX_PATTERN.test(portPrefix)) {
    return null;
  }

  const normalizedPort = browserPort?.trim();
  const portSuffix =
    normalizedPort != null && normalizedPort.length > 0 ? `:${normalizedPort}` : "";
  const templateHost = [`{{port}}--${suffixSegments.join("--")}`, ...remainingLabels].join(".");
  return `${normalizedProtocol}//${templateHost}${portSuffix}`;
}

/**
 * Resolve a localhost proxy template for browser mode.
 *
 * We prefer a server-injected template when available. In Coder-style wildcard subdomain
 * deployments, plain browser dev runs may not inject one, so we derive `{{port}}--...`
 * from the current hostname (e.g. `5173--workspace--user--apps.example.com`).
 */
export function resolveBrowserLocalhostProxyTemplate(
  options: ResolveBrowserLocalhostProxyTemplateOptions
): string | null {
  return (
    normalizeInjectedTemplate(options.injectedTemplate) ??
    deriveCoderTemplateFromBrowserHost(
      options.browserProtocol,
      options.browserHostname,
      options.browserPort
    )
  );
}
