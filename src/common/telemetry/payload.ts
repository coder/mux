/**
 * Telemetry Payload Definitions
 *
 * This file defines all data structures sent to PostHog for user transparency.
 * Users can inspect this file to understand exactly what telemetry data is collected.
 *
 * PRIVACY GUIDELINES:
 * - Randomly generated IDs (e.g., workspace IDs, session IDs) can be sent verbatim
 *   as they contain no user information and are not guessable.
 * - Display names, project names, file paths, or anything that could reveal the
 *   nature of the user's work MUST NOT be sent, even if hashed.
 *   Hashing is vulnerable to rainbow table attacks and brute-force, especially
 *   for common project names or predictable patterns.
 * - For numerical metrics that could leak information (like message lengths), use
 *   base-2 rounding (e.g., 128, 256, 512) to preserve privacy while enabling analysis.
 * - When in doubt, don't send it. Privacy is paramount.
 *
 * NOTE: Base properties (version, platform, electronVersion) are automatically
 * added by the backend TelemetryService. Frontend code only needs to provide
 * event-specific properties.
 */

/**
 * Base properties included with all telemetry events
 * These are added by the backend, not the frontend
 */
export interface BaseTelemetryProperties {
  /** Application version */
  version: string;
  /** Operating system platform (darwin, win32, linux) */
  platform: NodeJS.Platform | "unknown";
  /** Electron version */
  electronVersion: string;
}

/**
 * Application lifecycle events
 */
export interface AppStartedPayload {
  /** Whether this is the first app launch */
  isFirstLaunch: boolean;
}

/**
 * Workspace events
 */
export interface WorkspaceCreatedPayload {
  /** Workspace ID (randomly generated, safe to send) */
  workspaceId: string;
}

export interface WorkspaceSwitchedPayload {
  /** Previous workspace ID (randomly generated, safe to send) */
  fromWorkspaceId: string;
  /** New workspace ID (randomly generated, safe to send) */
  toWorkspaceId: string;
}

/**
 * Chat/AI interaction events
 */
export interface MessageSentPayload {
  /** Full model identifier (e.g., 'anthropic/claude-3-5-sonnet-20241022') */
  model: string;
  /** UI mode (e.g., 'plan', 'exec', 'edit') */
  mode: string;
  /** Message length rounded to nearest power of 2 (e.g., 128, 256, 512, 1024) */
  message_length_b2: number;
}

/**
 * Error tracking context types (explicit enum for transparency)
 */
export type ErrorContext =
  | "workspace-creation"
  | "workspace-deletion"
  | "workspace-switch"
  | "message-send"
  | "message-stream"
  | "project-add"
  | "project-remove"
  | "git-operation";

/**
 * Error tracking events
 */
export interface ErrorOccurredPayload {
  /** Error type/name */
  errorType: string;
  /** Error context - where the error occurred */
  context: ErrorContext;
}

/**
 * Union type of all telemetry event payloads
 * Frontend sends these; backend adds BaseTelemetryProperties before forwarding to PostHog
 */
export type TelemetryEventPayload =
  | { event: "app_started"; properties: AppStartedPayload }
  | { event: "workspace_created"; properties: WorkspaceCreatedPayload }
  | { event: "workspace_switched"; properties: WorkspaceSwitchedPayload }
  | { event: "message_sent"; properties: MessageSentPayload }
  | { event: "error_occurred"; properties: ErrorOccurredPayload };
