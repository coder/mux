import assert from "@/common/utils/assert";
import type { SendMessageError } from "@/common/types/errors";

/**
 * Helper to wrap arbitrary errors into SendMessageError structures.
 * Enforces that the raw string is non-empty for defensive debugging.
 */
export const createUnknownSendMessageError = (raw: string): SendMessageError => {
  assert(typeof raw === "string", "Expected raw error to be a string");
  const trimmed = raw.trim();
  assert(trimmed.length > 0, "createUnknownSendMessageError requires a non-empty message");

  return {
    type: "unknown",
    raw: trimmed,
  };
};
