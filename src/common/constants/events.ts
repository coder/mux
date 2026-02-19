/**
 * Custom Event Constants & Types
 * These are window-level custom events used for cross-component communication
 *
 * Each event has a corresponding type in CustomEventPayloads for type safety
 */

import type { ThinkingLevel } from "@/common/types/thinking";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { FilePart } from "@/common/orpc/schemas";

export const CUSTOM_EVENTS = {
  /**
   * Event to show a toast notification when thinking level changes
   * Detail: { workspaceId: string, level: ThinkingLevel }
   */
  THINKING_LEVEL_TOAST: "mux:thinkingLevelToast",

  /**
   * Event to insert text into the chat input
   * Detail: { text: string, mode?: "replace" | "append", fileParts?: FilePart[], reviews?: ReviewNoteDataForDisplay[] }
   */
  UPDATE_CHAT_INPUT: "mux:updateChatInput",

  /**
   * Event to open the model selector
   * No detail
   */
  OPEN_MODEL_SELECTOR: "mux:openModelSelector",

  /**
   * Event to open the agent picker (AgentModePicker)
   * No detail
   */
  OPEN_AGENT_PICKER: "mux:openAgentPicker",

  /**
   * Event to close the agent picker (AgentModePicker)
   * No detail
   */
  CLOSE_AGENT_PICKER: "mux:closeAgentPicker",

  /**
   * Event to request a refresh of the agent definition list (AgentContext).
   * No detail.
   */
  AGENTS_REFRESH_REQUESTED: "mux:agentsRefreshRequested",

  /**
   * Event to trigger resume check for a workspace
   * Detail: { workspaceId: string }
   *
   * Emitted when:
   * - Stream error occurs
   * - Stream aborted
   * - App startup (for all workspaces with interrupted streams)
   *
   * useResumeManager handles this idempotently - safe to emit multiple times
   */
  RESUME_CHECK_REQUESTED: "mux:resumeCheckRequested",

  /**
   * Event emitted when the mux gateway session expires.
   * No detail
   */
  MUX_GATEWAY_SESSION_EXPIRED: "mux:muxGatewaySessionExpired",

  /**
   * Event to switch to a different workspace after fork
   * Detail: { workspaceId: string, projectPath: string, projectName: string, workspacePath: string, branch: string }
   */
  WORKSPACE_FORK_SWITCH: "mux:workspaceForkSwitch",

  /**
   * Event to request AI title regeneration for a workspace.
   * Detail: { workspaceId: string }
   */
  WORKSPACE_GENERATE_TITLE_REQUESTED: "mux:workspaceGenerateTitleRequested",

  /**
   * Event to execute a command from the command palette
   * Detail: { commandId: string }
   */
  EXECUTE_COMMAND: "mux:executeCommand",
  /**
   * Event to enter the chat-based workspace creation experience.
   * Detail: { projectPath: string, startMessage?: string, model?: string, trunkBranch?: string, runtime?: string }
   */
  START_WORKSPACE_CREATION: "mux:startWorkspaceCreation",

  /**
   * Event to toggle voice input (dictation) mode
   * No detail
   */
  TOGGLE_VOICE_INPUT: "mux:toggleVoiceInput",

  /**
   * Event to open the debug LLM request modal
   * No detail
   */
  OPEN_DEBUG_LLM_REQUEST: "mux:openDebugLlmRequest",
} as const;

/**
 * Payload types for custom events
 * Maps event names to their detail payload structure
 */
export interface CustomEventPayloads {
  [CUSTOM_EVENTS.THINKING_LEVEL_TOAST]: {
    workspaceId: string;
    level: ThinkingLevel;
  };
  [CUSTOM_EVENTS.UPDATE_CHAT_INPUT]: {
    text: string;
    mode?: "replace" | "append";
    fileParts?: FilePart[];
    reviews?: ReviewNoteDataForDisplay[];
  };
  [CUSTOM_EVENTS.OPEN_AGENT_PICKER]: never; // No payload
  [CUSTOM_EVENTS.CLOSE_AGENT_PICKER]: never; // No payload
  [CUSTOM_EVENTS.AGENTS_REFRESH_REQUESTED]: never; // No payload
  [CUSTOM_EVENTS.OPEN_MODEL_SELECTOR]: never; // No payload
  [CUSTOM_EVENTS.RESUME_CHECK_REQUESTED]: {
    workspaceId: string;
    isManual?: boolean; // true when user explicitly clicks retry (bypasses eligibility checks)
  };
  [CUSTOM_EVENTS.MUX_GATEWAY_SESSION_EXPIRED]: never; // No payload
  [CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH]: {
    workspaceId: string;
    projectPath: string;
    projectName: string;
    workspacePath: string;
    branch: string;
  };
  [CUSTOM_EVENTS.WORKSPACE_GENERATE_TITLE_REQUESTED]: {
    workspaceId: string;
  };
  [CUSTOM_EVENTS.EXECUTE_COMMAND]: {
    commandId: string;
  };
  [CUSTOM_EVENTS.START_WORKSPACE_CREATION]: {
    projectPath: string;
    startMessage?: string;
    model?: string;
    trunkBranch?: string;
    runtime?: string;
  };
  [CUSTOM_EVENTS.TOGGLE_VOICE_INPUT]: never; // No payload
  [CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST]: never; // No payload
}

/**
 * Type-safe custom event type
 * Usage: CustomEventType<typeof CUSTOM_EVENTS.RESUME_CHECK_REQUESTED>
 */
export type CustomEventType<K extends keyof CustomEventPayloads> = CustomEvent<
  CustomEventPayloads[K]
>;

/**
 * Helper to create a typed custom event
 *
 * @example
 * ```typescript
 * const event = createCustomEvent(CUSTOM_EVENTS.RESUME_CHECK_REQUESTED, {
 *   workspaceId: 'abc123',
 *   isManual: true
 * });
 * window.dispatchEvent(event);
 * ```
 */
export function createCustomEvent<K extends keyof CustomEventPayloads>(
  eventName: K,
  ...args: CustomEventPayloads[K] extends never ? [] : [detail: CustomEventPayloads[K]]
): CustomEvent<CustomEventPayloads[K]> {
  const [detail] = args;
  return new CustomEvent(eventName, { detail } as CustomEventInit<CustomEventPayloads[K]>);
}

/**
 * Helper to create a storage change event name for a specific key
 * Used by usePersistedState for same-tab synchronization
 */
export const getStorageChangeEvent = (key: string): string => `storage-change:${key}`;
