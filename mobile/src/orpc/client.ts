import { RPCLink } from "@orpc/client/fetch";
import { createClient } from "@/common/orpc/client";
import type { RouterClient } from "@orpc/server";
import { Platform } from "react-native";
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
      // expo/fetch provides SSE support on native; on web, global fetch
      // already supports streaming via ReadableStream.
      const fetchFn = Platform.OS === "web" ? globalThis.fetch : (await import("expo/fetch")).fetch;

      // Inject auth token via Authorization header
      const headers = new Headers(request.headers);
      if (config.authToken) {
        headers.set("Authorization", `Bearer ${config.authToken}`);
      }

      const resp = await fetchFn(request.url, {
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
