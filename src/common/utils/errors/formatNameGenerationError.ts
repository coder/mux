/**
 * Format a NameGenerationError into user-friendly actionable messages.
 * Follows the pattern of formatSendMessageError in formatSendError.ts.
 */

import { PROVIDER_DISPLAY_NAMES, type ProviderName } from "@/common/constants/providers";
import type { NameGenerationError } from "@/common/types/errors";

const getProviderDisplayName = (provider: string): string =>
  PROVIDER_DISPLAY_NAMES[provider as ProviderName] ?? provider;

export interface FormattedNameError {
  title: string;
  message: string;
  hint?: string;
  docsPath?: string;
}

export function formatNameGenerationError(error: NameGenerationError): FormattedNameError {
  switch (error.type) {
    case "authentication": {
      const provider = error.provider ? getProviderDisplayName(error.provider) : null;
      return {
        title: "Authentication failed",
        message: provider
          ? `Could not authenticate with ${provider}.`
          : "API key is missing or invalid.",
        hint: "Check your API key in Settings → Providers.",
        docsPath: "/config/providers",
      };
    }
    case "permission_denied": {
      const provider = error.provider ? getProviderDisplayName(error.provider) : null;
      return {
        title: "Access denied",
        message: provider
          ? `Permission denied by ${provider}.`
          : "The API key does not have permission for this operation.",
        hint: "Verify your API key has the required permissions.",
        docsPath: "/config/providers",
      };
    }
    case "rate_limit":
      return {
        title: "Rate limited",
        message: "Too many requests — the provider is throttling requests.",
        hint: "Wait a moment and try again.",
      };
    case "quota":
      return {
        title: "Quota exceeded",
        message: "Your usage quota or billing limit has been reached.",
        hint: "Check your billing dashboard for the provider.",
        docsPath: "/config/providers",
      };
    case "service_unavailable":
      return {
        title: "Service unavailable",
        message: "The AI provider is temporarily unavailable.",
        hint: "Try again in a few moments.",
      };
    case "network":
      return {
        title: "Network error",
        message: "Could not reach the AI provider.",
        hint: "Check your internet connection.",
      };
    case "configuration":
      return {
        title: "Configuration issue",
        message: error.raw ?? "No working model is configured for name generation.",
        hint: "Ensure at least one provider is enabled in Settings → Providers.",
        docsPath: "/config/providers",
      };
    case "unknown": {
      return {
        title: "Name generation failed",
        message: error.raw || "An unexpected error occurred during name generation.",
      };
    }
  }
}
