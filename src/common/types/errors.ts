/**
 * Strongly-typed error types for send message operations.
 * This discriminated union allows the frontend to handle different error cases appropriately.
 */

import type z from "zod";
import type { SendMessageErrorSchema, StreamErrorTypeSchema } from "../orpc/schemas";

/**
 * Discriminated union for all possible sendMessage errors
 * The frontend is responsible for language and messaging for api_key_not_found and
 * provider_not_supported errors. Other error types include details needed for display.
 */
export type SendMessageError = z.infer<typeof SendMessageErrorSchema>;

/**
 * Stream error types - categorizes errors during AI streaming
 * Used across backend (StreamManager) and frontend (StreamErrorMessage)
 */
export type StreamErrorType = z.infer<typeof StreamErrorTypeSchema>;
