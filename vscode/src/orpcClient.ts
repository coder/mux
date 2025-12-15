import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { getMuxHome } from "mux/common/constants/paths";
import { createClient } from "mux/common/orpc/client";
import type { AppRouter } from "mux/node/orpc/router";
import { ServerLockfile } from "mux/node/services/serverLockfile";

export interface DiscoveredMuxServer {
  baseUrl: string;
  authToken?: string;
}

export type OrpcApiClient = RouterClient<AppRouter>;

function normalizeBaseUrl(baseUrl: string): string {
  // Avoid double slashes when constructing `${baseUrl}/orpc`.
  return baseUrl.replace(/\/+$/, "");
}

export async function discoverMuxServer(): Promise<DiscoveredMuxServer | null> {
  // Priority 1: Explicit env vars override everything
  if (process.env.MUX_SERVER_URL) {
    const authToken = process.env.MUX_SERVER_AUTH_TOKEN?.trim();
    return {
      baseUrl: normalizeBaseUrl(process.env.MUX_SERVER_URL),
      authToken: authToken ? authToken : undefined,
    };
  }

  // Priority 2: Try lockfile discovery (running Electron or mux server)
  const lockfile = new ServerLockfile(getMuxHome());
  const data = await lockfile.read();
  if (!data) {
    return null;
  }

  const authToken = data.token.trim();
  return {
    baseUrl: normalizeBaseUrl(data.baseUrl),
    authToken: authToken ? authToken : undefined,
  };
}

export function createOrpcHttpClient(server: DiscoveredMuxServer): OrpcApiClient {
  const link = new HTTPRPCLink({
    url: `${server.baseUrl}/orpc`,
    headers: server.authToken ? { Authorization: `Bearer ${server.authToken}` } : undefined,
  });

  return createClient(link);
}
