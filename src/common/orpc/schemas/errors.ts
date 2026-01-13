import { z } from "zod";

/**
 * Discriminated union for all possible sendMessage errors
 * The frontend is responsible for language and messaging for api_key_not_found and
 * provider_not_supported errors. Other error types include details needed for display.
 */
export const SendMessageErrorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api_key_not_found"), provider: z.string() }),
  z.object({ type: z.literal("provider_not_supported"), provider: z.string() }),
  z.object({ type: z.literal("invalid_model_string"), message: z.string() }),
  z.object({ type: z.literal("incompatible_workspace"), message: z.string() }),
  z.object({ type: z.literal("runtime_not_ready"), message: z.string() }),
  z.object({ type: z.literal("runtime_start_failed"), message: z.string() }), // Transient - retryable
  z.object({ type: z.literal("unknown"), raw: z.string() }),
]);

/**
 * Stream error types - categorizes errors during AI streaming
 * Used across backend (StreamManager) and frontend (StreamErrorMessage)
 */
export const StreamErrorTypeSchema = z.enum([
  "authentication", // API key issues, 401 errors
  "rate_limit", // 429 rate limiting
  "server_error", // 5xx server errors
  "api", // Generic API errors
  "retry_failed", // Retry exhausted
  "aborted", // User aborted
  "network", // Network/fetch errors
  "context_exceeded", // Context length/token limit exceeded
  "quota", // Usage quota/billing limits
  "model_not_found", // Model does not exist
  "runtime_not_ready", // Container/runtime doesn't exist or failed to start (permanent)
  "runtime_start_failed", // Runtime is starting or temporarily unavailable (retryable)
  "unknown", // Catch-all
]);
