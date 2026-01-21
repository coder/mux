/**
 * Centralized error message formatting for SendMessageError types
 * Used by both RetryBarrier and ChatInputToasts
 */

import type { SendMessageError } from "@/common/types/errors";

export interface FormattedError {
  message: string;
  providerCommand?: string; // e.g., "/providers set anthropic apiKey YOUR_KEY"
}

/**
 * Format a SendMessageError into a user-friendly message
 * Returns both the message and an optional command suggestion
 */
export function formatSendMessageError(error: SendMessageError): FormattedError {
  switch (error.type) {
    case "api_key_not_found":
      return {
        message: `API key not found for ${error.provider}.`,
        providerCommand: `/providers set ${error.provider} apiKey YOUR_API_KEY`,
      };

    case "provider_not_supported":
      return {
        message: `Provider ${error.provider} is not supported yet.`,
      };

    case "invalid_model_string":
      return {
        message: error.message,
      };

    case "incompatible_workspace":
      return {
        message: error.message,
      };

    case "runtime_not_ready":
      return {
        message: error.message,
      };

    case "runtime_start_failed":
      return {
        message: error.message,
      };

    case "unknown":
      return {
        message: error.raw || "An unexpected error occurred",
      };
  }
}
