import { createORPCClient } from "@orpc/client";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import assert from "@/common/utils/assert";

export interface CreateRemoteClientOptions {
  baseUrl: string;
  authToken?: string;
  /**
   * Optional per-request timeout in milliseconds. When set, each fetch call
   * will be aborted via `AbortSignal.timeout()` if it does not complete in time.
   * If the caller already provides an `AbortSignal`, the two are composed with
   * `AbortSignal.any()` so either can cancel the request.
   *
   * Do NOT set this for streaming subscriptions (onMetadata, onChat,
   * activity.subscribe) — they have their own stall detection.
   */
  timeoutMs?: number;
}

/**
 * Creates a typed oRPC client for talking to a remote mux server over HTTP.
 */
export function createRemoteClient<TClient = unknown>({
  baseUrl,
  authToken,
  timeoutMs,
}: CreateRemoteClientOptions): TClient {
  assert(typeof baseUrl === "string", "createRemoteClient: baseUrl must be a string");

  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/g, "");
  assert(normalizedBaseUrl.length > 0, "createRemoteClient: baseUrl must be non-empty");

  if (timeoutMs !== undefined) {
    assert(
      typeof timeoutMs === "number" && timeoutMs > 0,
      "createRemoteClient: timeoutMs must be a positive number"
    );
  }

  const orpcUrl = `${normalizedBaseUrl}/orpc`;

  let headers: Record<string, string> | undefined;
  if (authToken !== undefined) {
    assert(typeof authToken === "string", "createRemoteClient: authToken must be a string");
    const token = authToken.trim();
    assert(token.length > 0, "createRemoteClient: authToken must be non-empty");
    headers = { Authorization: `Bearer ${token}` };
  }

  // When timeoutMs is set, wrap the global fetch so every request is bounded.
  // Compose with any existing signal via AbortSignal.any() to honour caller cancellation too.
  let customFetch:
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined;
  if (timeoutMs !== undefined) {
    const timeout = timeoutMs;
    customFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const existingSignal = init?.signal;
      const composedSignal = existingSignal
        ? AbortSignal.any([existingSignal, timeoutSignal])
        : timeoutSignal;

      return fetch(input, { ...init, signal: composedSignal });
    };
  }

  const link = new HTTPRPCLink({ url: orpcUrl, headers, fetch: customFetch });

  // Type assertion is safe: createORPCClient returns a runtime client object. The caller chooses
  // the type parameter based on the procedures they intend to call.
  return createORPCClient(link) as unknown as TClient;
}
