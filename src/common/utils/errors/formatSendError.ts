/**
 * Centralized error message formatting for SendMessageError types
 * Used by both RetryBarrier and ChatInputToasts
 */

import type { SendMessageError } from "@/common/types/errors";

export interface FormattedError {
  message: string;
  resolutionHint?: string; // e.g., "Open Settings → Providers and add an API key"
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
        resolutionHint: `Open Settings → Providers and add an API key for ${error.provider}.`,
      };

    case "oauth_not_connected":
      return {
        message: `OAuth not connected for ${error.provider}.`,
        resolutionHint: `Open Settings → Providers and connect your ${error.provider} account.`,
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

    case "policy_denied":
      return {
        message: error.message,
      };

    case "unknown": {
      const raw = typeof error.raw === "string" ? error.raw.trim() : "";
      return {
        message: raw || "An unexpected error occurred",
      };
    }
  }
}
