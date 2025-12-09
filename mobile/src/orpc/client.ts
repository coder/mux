import { RPCLink } from "@orpc/client/fetch";
import { createClient } from "@/common/orpc/client";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";

export type ORPCClient = RouterClient<AppRouter>;

export interface MobileClientConfig {
  baseUrl: string;
  authToken?: string | null;
}

export function createMobileORPCClient(config: MobileClientConfig): ORPCClient {
  const link = new RPCLink({
    url: `${config.baseUrl}/orpc`,
    async fetch(request, init, _options, _path, _input) {
      // Use expo/fetch for Event Iterator (SSE) support
      const { fetch } = await import("expo/fetch");

      // Inject auth token via Authorization header
      const headers = new Headers(request.headers);
      if (config.authToken) {
        headers.set("Authorization", `Bearer ${config.authToken}`);
      }

      const resp = await fetch(request.url, {
        body: await request.blob(),
        headers,
        method: request.method,
        signal: request.signal,
        ...init,
      });

      return resp;
    },
  });

  return createClient(link);
}
