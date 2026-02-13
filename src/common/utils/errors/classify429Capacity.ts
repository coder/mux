export type Capacity429Kind = "quota" | "rate_limit";

const QUOTA_INDICATORS = [
  "insufficient_quota",
  "insufficient quota",
  "quota",
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
 * Distinguish quota/billing 429s from transient throttling 429s.
 * Providers commonly encode quota failures as 429 with structured payload hints.
 */
export function classify429Capacity(input: {
  message?: string | null;
  data?: unknown;
  responseBody?: string | null;
}): Capacity429Kind {
  const corpus = [input.message ?? "", input.responseBody ?? "", stringifyData(input.data)]
    .join("\n")
    .toLowerCase();

  return QUOTA_INDICATORS.some((needle) => corpus.includes(needle)) ? "quota" : "rate_limit";
}
