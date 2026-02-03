import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createClient } from "@/common/orpc/client";
import assert from "@/common/utils/assert";
import type { AppRouter } from "@/node/orpc/router";

export interface CreateRemoteClientOptions {
  baseUrl: string;
  authToken?: string;
}

/**
 * Creates a typed oRPC client for talking to a remote mux server over HTTP.
 */
export function createRemoteClient({
  baseUrl,
  authToken,
}: CreateRemoteClientOptions): RouterClient<AppRouter> {
  assert(typeof baseUrl === "string", "createRemoteClient: baseUrl must be a string");

  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/g, "");
  assert(normalizedBaseUrl.length > 0, "createRemoteClient: baseUrl must be non-empty");

  const orpcUrl = `${normalizedBaseUrl}/orpc`;

  let headers: Record<string, string> | undefined;
  if (authToken !== undefined) {
    assert(typeof authToken === "string", "createRemoteClient: authToken must be a string");
    const token = authToken.trim();
    assert(token.length > 0, "createRemoteClient: authToken must be non-empty");
    headers = { Authorization: `Bearer ${token}` };
  }

  const link = new HTTPRPCLink({ url: orpcUrl, headers });
  return createClient(link);
}
