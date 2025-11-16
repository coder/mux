/**
 * Strongly-typed error types for send message operations.
 * This discriminated union allows the frontend to handle different error cases appropriately.
 */

/**
 * Discriminated union for all possible sendMessage errors
 * The frontend is responsible for language and messaging for api_key_not_found and
 * provider_not_supported errors. Other error types include details needed for display.
 */
export type SendMessageError =
  | { type: "api_key_not_found"; provider: string }
  | { type: "provider_not_supported"; provider: string }
  | { type: "invalid_model_string"; message: string }
  | { type: "unknown"; raw: string };

/**
 * Stream error types - categorizes errors during AI streaming
 * Used across backend (StreamManager) and frontend (StreamErrorMessage)
 */
export type StreamErrorType =
  | "authentication" // API key issues, 401 errors
  | "rate_limit" // 429 rate limiting
  | "server_error" // 5xx server errors
  | "api" // Generic API errors
  | "retry_failed" // Retry exhausted
  | "aborted" // User aborted
  | "network" // Network/fetch errors
  | "context_exceeded" // Context length/token limit exceeded
  | "quota" // Usage quota/billing limits
  | "model_not_found" // Model does not exist
  | "unknown"; // Catch-all
