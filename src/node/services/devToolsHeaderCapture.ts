import assert from "@/common/utils/assert";

/**
 * Correlates DevTools middleware steps with HTTP request headers.
 *
 * The middleware injects a synthetic header (x-mux-devtools-step-id) into
 * AI SDK call params. The fetch wrapper intercepts it, strips it before
 * sending, and captures all real request headers keyed by step ID.
 */
export const DEVTOOLS_STEP_ID_HEADER = "x-mux-devtools-step-id";

/** Captured request headers keyed by step ID. */
const capturedRequestHeaders = new Map<string, Record<string, string>>();

/** Called by the middleware to retrieve (and clean up) captured headers for a step. */
export function consumeCapturedRequestHeaders(stepId: string): Record<string, string> | null {
  assert(stepId.trim().length > 0, "consumeCapturedRequestHeaders requires a stepId");

  const headers = capturedRequestHeaders.get(stepId) ?? null;
  capturedRequestHeaders.delete(stepId);
  return headers;
}

/**
 * Wraps a fetch function to intercept the synthetic step ID header.
 * When present, strips it from the outgoing request and captures all
 * remaining request headers into the shared map.
 */
export function wrapFetchWithHeaderCapture(baseFetch: typeof fetch): typeof fetch {
  assert(typeof baseFetch === "function", "wrapFetchWithHeaderCapture requires a fetch function");

  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headerSource = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(headerSource);
    const rawStepId = headers.get(DEVTOOLS_STEP_ID_HEADER);

    if (rawStepId != null) {
      headers.delete(DEVTOOLS_STEP_ID_HEADER);

      const stepId = rawStepId.trim();
      if (stepId.length > 0) {
        capturedRequestHeaders.set(stepId, Object.fromEntries(headers.entries()));
      }

      const cleanedInit: RequestInit = {
        ...(init ?? {}),
        headers,
      };
      return baseFetch(input, cleanedInit);
    }

    return baseFetch(input, init);
  };

  return Object.assign(wrappedFetch, baseFetch) as typeof fetch;
}
