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
 * NOTE: Base properties (version, backend_platform, electronVersion, nodeVersion,
 * bunVersion) are automatically added by the backend TelemetryService. Frontend
 * code only needs to provide event-specific properties.
 */

/**
 * Base properties included with all telemetry events
 * These are added by the backend, not the frontend
 */
export interface BaseTelemetryProperties {
  /** Application version */
  version: string;
  /** Backend operating system platform (darwin, win32, linux) - where Node.js/backend runs */
  backend_platform: NodeJS.Platform | "unknown";
  /** Electron version (if running in Electron) */
  electronVersion: string;
  /** Node.js version */
  nodeVersion: string;
  /** Bun version (if running in Bun) */
  bunVersion: string;
}

/**
 * Application lifecycle events
 */
export interface AppStartedPayload {
  /** Whether this is the first app launch */
  isFirstLaunch: boolean;
  /** Whether vim mode is enabled at startup */
  vimModeEnabled: boolean;
}

/**
 * Runtime type for telemetry - normalized from RuntimeConfig
 * Values: 'local' (project-dir), 'worktree' (git worktree isolation), 'ssh' (remote execution)
 */
export type TelemetryRuntimeType = "local" | "worktree" | "ssh";

/**
 * Frontend platform info - browser/client environment
 * Useful when backend runs on different machine (e.g., mux server mode)
 */
export interface FrontendPlatformInfo {
  /** Browser user agent string (safe, widely shared) */
  userAgent: string;
  /** Client platform from navigator.platform */
  platform: string;
}

/**
 * Workspace events
 */
export interface WorkspaceCreatedPayload {
  /** Workspace ID (randomly generated, safe to send) */
  workspaceId: string;
  /** Runtime type for the workspace */
  runtimeType: TelemetryRuntimeType;
  /** Frontend platform info */
  frontendPlatform: FrontendPlatformInfo;
}

export interface WorkspaceSwitchedPayload {
  /** Previous workspace ID (randomly generated, safe to send) */
  fromWorkspaceId: string;
  /** New workspace ID (randomly generated, safe to send) */
  toWorkspaceId: string;
}

/**
 * Thinking level for extended thinking feature
 */
export type TelemetryThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

/**
 * Chat/AI interaction events
 */
export interface MessageSentPayload {
  /** Workspace ID (randomly generated, safe to send) */
  workspaceId: string;
  /** Full model identifier (e.g., 'anthropic/claude-3-5-sonnet-20241022') */
  model: string;
  /** UI mode (e.g., 'plan', 'exec', 'edit') */
  mode: string;
  /** Message length rounded to nearest power of 2 (e.g., 128, 256, 512, 1024) */
  message_length_b2: number;
  /** Runtime type for the workspace */
  runtimeType: TelemetryRuntimeType;
  /** Frontend platform info */
  frontendPlatform: FrontendPlatformInfo;
  /** Extended thinking level */
  thinkingLevel: TelemetryThinkingLevel;
}

/**
 * Stream completion event - tracks when AI responses finish
 */
export interface StreamCompletedPayload {
  /** Model used for generation */
  model: string;
  /** Whether the stream was interrupted by user vs natural completion */
  wasInterrupted: boolean;
  /** Duration in seconds, rounded to nearest power of 2 */
  duration_b2: number;
  /** Output tokens, rounded to nearest power of 2 */
  output_tokens_b2: number;
}

/**
 * Provider configuration event - tracks when users set up providers
 * Note: Only tracks that a key was set, never the actual value
 */
export interface ProviderConfiguredPayload {
  /** Provider name (e.g., 'anthropic', 'openai', 'mux-gateway') */
  provider: string;
  /** Key type that was configured (e.g., 'apiKey', 'couponCode', 'baseUrl') */
  keyType: string;
}

/**
 * Slash command types for telemetry (no arguments/values)
 */
export type TelemetryCommandType =
  | "clear"
  | "compact"
  | "new"
  | "fork"
  | "vim"
  | "model"
  | "mode"
  | "plan"
  | "providers";

/**
 * Command usage event - tracks slash command usage patterns
 */
export interface CommandUsedPayload {
  /** Command type (without arguments for privacy) */
  command: TelemetryCommandType;
}

/**
 * Voice transcription event - tracks voice input usage
 */
export interface VoiceTranscriptionPayload {
  /** Duration of audio in seconds, rounded to nearest power of 2 */
  audio_duration_b2: number;
  /** Whether the transcription succeeded */
  success: boolean;
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
  | { event: "stream_completed"; properties: StreamCompletedPayload }
  | { event: "provider_configured"; properties: ProviderConfiguredPayload }
  | { event: "command_used"; properties: CommandUsedPayload }
  | { event: "voice_transcription"; properties: VoiceTranscriptionPayload }
  | { event: "error_occurred"; properties: ErrorOccurredPayload };
