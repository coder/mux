import type { SendMessageError } from "@/common/types/errors";

/**
 * Extract error message from SendMessageError or string
 * Handles both string errors and structured error objects
 */
export function extractErrorMessage(error: SendMessageError | string): string {
  if (typeof error === "string") {
    return error;
  }
  return "raw" in error ? error.raw : error.type;
}
