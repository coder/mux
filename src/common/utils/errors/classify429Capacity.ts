export type Capacity429Kind = "quota" | "rate_limit";

const BILLING_429_MARKERS = [
  "insufficient_quota",
  "insufficient quota",
  // Intentionally excludes bare "quota" — throttling 429s often reference per-minute/request quotas.
  "billing",
  "payment required",
  "insufficient balance",
  "add credits",
  "credit balance",
  "hard limit",
] as const;

function stringifyData(data: unknown): string {
  if (data == null) {
    return "";
  }

  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
}

/**
 * Distinguish billing/quota-exhausted 429s from transient throttling 429s.
 * Uses billing-specific markers to avoid treating generic per-minute quota wording as account quota exhaustion.
 */
export function classify429Capacity(input: {
  message?: string | null;
  data?: unknown;
  responseBody?: string | null;
}): Capacity429Kind {
  const corpus = [input.message ?? "", input.responseBody ?? "", stringifyData(input.data)]
    .join("\n")
    .toLowerCase();

  return BILLING_429_MARKERS.some((needle) => corpus.includes(needle)) ? "quota" : "rate_limit";
}
