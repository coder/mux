import { getMuxHome } from "@/common/constants/paths";
import assert from "@/common/utils/assert";
import { log } from "@/node/services/log";
import { ServerLockfile } from "@/node/services/serverLockfile";
import { startEmbeddedServer } from "./embeddedServer";

export type ResolvedBackend =
  | { kind: "remote"; baseUrl: string; wsUrl: string; token: string }
  | { kind: "existing"; baseUrl: string; wsUrl: string; token: string }
  | { kind: "embedded"; baseUrl: string; wsUrl: string; token: string; close: () => Promise<void> };

export interface ResolveBackendOpts {
  serverUrl?: string;
  authToken?: string;
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

interface NormalizedUrl {
  baseUrl: string;
  /** Token extracted from `?token=…` query parameter, if present. */
  queryToken: string | undefined;
}

function normalizeBaseUrl(rawBaseUrl: string): NormalizedUrl {
  const parsedUrl = new URL(rawBaseUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(
      `Unsupported --server-url protocol "${parsedUrl.protocol}". Expected http:// or https://.`
    );
  }

  // Preserve the ?token= query parameter before stripping search/hash.
  // The WS auth layer supports ?token= as a connection path
  // (see src/node/orpc/authMiddleware.ts), so we must not silently discard it.
  const queryToken = parsedUrl.searchParams.get("token") ?? undefined;

  parsedUrl.hash = "";
  parsedUrl.search = "";

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, "");
  const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const baseUrl = normalizedPath.length > 0 ? `${origin}${normalizedPath}` : origin;

  return { baseUrl, queryToken };
}

function toWsUrl(baseUrl: string): string {
  const parsedUrl = new URL(baseUrl);
  assert(
    parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:",
    "baseUrl must be http(s)"
  );

  parsedUrl.protocol = parsedUrl.protocol === "https:" ? "wss:" : "ws:";
  parsedUrl.pathname = `${parsedUrl.pathname.replace(/\/+$/, "")}/orpc/ws`;
  parsedUrl.search = "";
  parsedUrl.hash = "";

  return parsedUrl.toString();
}

function makeResolvedToken(...values: Array<string | undefined>): string {
  return pickFirstNonEmpty(...values) ?? "";
}

export async function resolveBackend(opts: ResolveBackendOpts): Promise<ResolvedBackend> {
  const explicitServerUrl = pickFirstNonEmpty(opts.serverUrl, process.env.MUX_SERVER_URL);
  if (explicitServerUrl) {
    const { baseUrl, queryToken } = normalizeBaseUrl(explicitServerUrl);
    return {
      kind: "remote",
      baseUrl,
      wsUrl: toWsUrl(baseUrl),
      token: makeResolvedToken(opts.authToken, process.env.MUX_SERVER_AUTH_TOKEN, queryToken),
    };
  }

  const lockfile = new ServerLockfile(getMuxHome());
  const lockData = await lockfile.read();
  if (lockData) {
    const { baseUrl, queryToken } = normalizeBaseUrl(lockData.baseUrl);
    return {
      kind: "existing",
      baseUrl,
      wsUrl: toWsUrl(baseUrl),
      token: makeResolvedToken(
        opts.authToken,
        process.env.MUX_SERVER_AUTH_TOKEN,
        queryToken,
        lockData.token
      ),
    };
  }

  log.debug("[acp] No explicit or lockfile backend found; starting embedded oRPC server");
  const embeddedServer = await startEmbeddedServer();
  assert(embeddedServer.baseUrl.length > 0, "Embedded backend returned an empty baseUrl");
  assert(embeddedServer.wsUrl.length > 0, "Embedded backend returned an empty wsUrl");

  return {
    kind: "embedded",
    baseUrl: embeddedServer.baseUrl,
    wsUrl: embeddedServer.wsUrl,
    token: embeddedServer.token,
    close: embeddedServer.close,
  };
}
