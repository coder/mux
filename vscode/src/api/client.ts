import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import assert from "node:assert";

import { createClient } from "mux/common/orpc/client";
import type { AppRouter } from "mux/node/orpc/router";

export type ApiClient = RouterClient<AppRouter>;

export interface ApiClientConfig {
  baseUrl: string;
  authToken?: string | undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  assert(baseUrl.length > 0, "baseUrl must be non-empty");

  const parsed = new URL(baseUrl);
  assert(
    parsed.protocol === "http:" || parsed.protocol === "https:",
    `Unsupported baseUrl protocol: ${parsed.protocol}`
  );

  // URL.toString() includes a trailing slash for naked origins.
  return parsed.toString().replace(/\/$/, "");
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  assert(typeof config.baseUrl === "string", "baseUrl must be a string");

  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);

  const link = new RPCLink({
    url: `${normalizedBaseUrl}/orpc`,
    async fetch(request, init) {
      const headers = new Headers(request.headers);
      if (config.authToken) {
        headers.set("Authorization", `Bearer ${config.authToken}`);
      }

      return fetch(request.url, {
        body: await request.blob(),
        headers,
        method: request.method,
        signal: request.signal,
        ...init,
      });
    },
  });

  return createClient(link);
}
