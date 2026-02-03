import { createORPCClient } from "@orpc/client";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import assert from "@/common/utils/assert";

export interface CreateRemoteClientOptions {
  baseUrl: string;
  authToken?: string;
}

/**
 * Creates a typed oRPC client for talking to a remote mux server over HTTP.
 */
export function createRemoteClient<TClient = unknown>({
  baseUrl,
  authToken,
}: CreateRemoteClientOptions): TClient {
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

  // Type assertion is safe: createORPCClient returns a runtime client object. The caller chooses
  // the type parameter based on the procedures they intend to call.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return createORPCClient(link) as unknown as TClient;
}
