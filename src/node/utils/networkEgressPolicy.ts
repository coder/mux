import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

const INSTALLED_FLAG = Symbol.for("mux.copilotOnlyEgressPolicyInstalled");
const DEFAULT_PORT_BY_PROTOCOL: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

const COPILOT_ALLOWED_HOSTS = new Set(["api.githubcopilot.com", "github.com"]);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const unwrapped = normalized.replace(/^\[|\]$/g, "");
  if (unwrapped === "localhost") return true;
  if (unwrapped === "::1") return true;

  const ipType = isIP(unwrapped);
  if (ipType === 4) {
    return unwrapped.startsWith("127.");
  }

  return false;
}

export function isAllowedEgressUrl(url: URL): boolean {
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return isLoopbackHostname(hostname) || COPILOT_ALLOWED_HOSTS.has(hostname);
}

function toUrlFromHttpRequestArgs(args: unknown[], defaultProtocol: "http:" | "https:"): URL | null {
  const first = args[0];
  if (first instanceof URL) {
    return first;
  }
  if (typeof first === "string") {
    try {
      return new URL(first);
    } catch {
      try {
        return new URL(first, `${defaultProtocol}//localhost`);
      } catch {
        return null;
      }
    }
  }
  if (typeof first === "object" && first != null) {
    const requestOptions = first as {
      socketPath?: string;
      protocol?: string;
      hostname?: string;
      host?: string;
      port?: number | string;
      path?: string;
    };

    if (typeof requestOptions.socketPath === "string" && requestOptions.socketPath.length > 0) {
      return null;
    }

    const protocol = requestOptions.protocol ?? defaultProtocol;
    const hostname = requestOptions.hostname ?? requestOptions.host ?? "localhost";
    const port =
      requestOptions.port != null ? String(requestOptions.port) : DEFAULT_PORT_BY_PROTOCOL[protocol];
    const path = requestOptions.path ?? "/";

    try {
      return new URL(path, `${protocol}//${hostname}:${port}`);
    } catch {
      return null;
    }
  }
  return null;
}

function assertEgressAllowed(targetUrl: URL, requestType: string): void {
  if (isAllowedEgressUrl(targetUrl)) {
    return;
  }
  throw new Error(
    `Blocked outbound ${requestType} request to ${targetUrl.toString()} by Copilot-only egress policy`
  );
}

export function installCopilotOnlyEgressPolicy(): void {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  if (globalRecord[INSTALLED_FLAG] === true) {
    return;
  }
  globalRecord[INSTALLED_FLAG] = true;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const targetUrl =
      input instanceof URL
        ? input
        : typeof input === "string"
          ? new URL(input)
          : new URL(input.url);
    assertEgressAllowed(targetUrl, "fetch");
    return originalFetch(input, init);
  }) as typeof fetch;

  const originalHttpRequest = http.request.bind(http);
  const originalHttpGet = http.get.bind(http);
  const originalHttpsRequest = https.request.bind(https);
  const originalHttpsGet = https.get.bind(https);

  const guardedHttpRequest = ((...args: unknown[]) => {
    const targetUrl = toUrlFromHttpRequestArgs(args, "http:");
    if (targetUrl) {
      assertEgressAllowed(targetUrl, "http");
    }
    return originalHttpRequest(...(args as Parameters<typeof http.request>));
  }) as typeof http.request;

  const guardedHttpGet = ((...args: unknown[]) => {
    const targetUrl = toUrlFromHttpRequestArgs(args, "http:");
    if (targetUrl) {
      assertEgressAllowed(targetUrl, "http");
    }
    return originalHttpGet(...(args as Parameters<typeof http.get>));
  }) as typeof http.get;

  const guardedHttpsRequest = ((...args: unknown[]) => {
    const targetUrl = toUrlFromHttpRequestArgs(args, "https:");
    if (targetUrl) {
      assertEgressAllowed(targetUrl, "https");
    }
    return originalHttpsRequest(...(args as Parameters<typeof https.request>));
  }) as typeof https.request;

  const guardedHttpsGet = ((...args: unknown[]) => {
    const targetUrl = toUrlFromHttpRequestArgs(args, "https:");
    if (targetUrl) {
      assertEgressAllowed(targetUrl, "https");
    }
    return originalHttpsGet(...(args as Parameters<typeof https.get>));
  }) as typeof https.get;

  Object.assign(http, {
    request: guardedHttpRequest,
    get: guardedHttpGet,
  });
  Object.assign(https, {
    request: guardedHttpsRequest,
    get: guardedHttpsGet,
  });
}
