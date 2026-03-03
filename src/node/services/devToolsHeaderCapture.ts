import assert from "@/common/utils/assert";

/**
 * Correlates DevTools middleware steps with HTTP request headers.
 *
 * The middleware injects a synthetic header (x-mux-devtools-step-id) into
 * AI SDK call params. The default fetch function calls captureAndStripDevToolsHeader()
 * after building final headers (including the Mux user-agent), which captures
 * all real request headers keyed by step ID and strips the synthetic header
 * before the request is sent.
 */
export const DEVTOOLS_STEP_ID_HEADER = "x-mux-devtools-step-id";

/** Captured request headers keyed by step ID. */
const capturedRequestHeaders = new Map<string, Record<string, string>>();

/**
 * Header names (lowercased) whose values must be redacted before persistence.
 * Matches common auth/credential headers across AI providers.
 */
const SENSITIVE_HEADER_NAMES = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);

/** Prefix-match for bearer/token patterns that may appear under custom names. */
function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(lower) || lower.includes("secret") || lower.includes("token");
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = isSensitiveHeaderName(key) ? "[REDACTED]" : value;
  }
  return redacted;
}

/** Called by the middleware to retrieve (and clean up) captured headers for a step. */
export function consumeCapturedRequestHeaders(stepId: string): Record<string, string> | null {
  assert(stepId.trim().length > 0, "consumeCapturedRequestHeaders requires a stepId");

  const headers = capturedRequestHeaders.get(stepId) ?? null;
  capturedRequestHeaders.delete(stepId);
  return headers;
}

/**
 * Inspects a Headers object for the synthetic DevTools step ID header.
 * If present, captures all remaining headers into the shared map and
 * strips the synthetic header. Mutates the Headers object in place.
 *
 * Called inside defaultFetchWithUnlimitedTimeout after buildAIProviderRequestHeaders
 * so captured headers include the Mux user-agent and all provider-added headers.
 * No-op when the synthetic header is absent (i.e., devtools middleware is not active).
 */
export function captureAndStripDevToolsHeader(headers: Headers): void {
  const rawStepId = headers.get(DEVTOOLS_STEP_ID_HEADER);
  if (rawStepId == null) return;

  // Strip synthetic header — must never reach the provider API
  headers.delete(DEVTOOLS_STEP_ID_HEADER);

  const stepId = rawStepId.trim();
  if (stepId.length > 0) {
    capturedRequestHeaders.set(stepId, redactHeaders(Object.fromEntries(headers.entries())));
  }
}
