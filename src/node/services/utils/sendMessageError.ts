import assert from "@/common/utils/assert";
import type { SendMessageError, StreamErrorType } from "@/common/types/errors";

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

/**
 * Formats a SendMessageError into a user-visible message and StreamErrorType
 * for display in the chat UI as a stream-error event.
 */
export const formatSendMessageError = (
  error: SendMessageError
): { message: string; errorType: StreamErrorType } => {
  switch (error.type) {
    case "api_key_not_found":
      return {
        message: `API key not configured for ${error.provider}. Please add your API key in settings.`,
        errorType: "authentication",
      };
    case "provider_not_supported":
      return {
        message: `Provider "${error.provider}" is not supported.`,
        errorType: "unknown",
      };
    case "invalid_model_string":
      return {
        message: error.message,
        errorType: "model_not_found",
      };
    case "incompatible_workspace":
      return {
        message: error.message,
        errorType: "unknown",
      };
    case "runtime_not_ready":
      return {
        message:
          `Workspace runtime unavailable: ${error.message}. ` +
          `The container/workspace may have been removed or does not exist.`,
        errorType: "runtime_not_ready",
      };
    case "runtime_start_failed":
      return {
        message: `Workspace is starting: ${error.message}`,
        errorType: "runtime_start_failed",
      };
    case "unknown":
      return {
        message: error.raw,
        errorType: "unknown",
      };
  }
};

/**
 * Build a stream-error payload for pre-stream failures so the UI can surface them immediately.
 */
export const buildStreamErrorEventData = (
  error: SendMessageError
): { messageId: string; error: string; errorType: StreamErrorType } => {
  const { message, errorType } = formatSendMessageError(error);
  const messageId = `assistant-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  return { messageId, error: message, errorType };
};
