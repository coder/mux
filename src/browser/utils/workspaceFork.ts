/**
 * Workspace forking utilities
 * Handles forking workspaces and switching UI state
 */

import type { SendMessageOptions } from "@/common/types/ipc";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { copyWorkspaceStorage } from "@/common/constants/storage";

export interface ForkOptions {
  sourceWorkspaceId: string;
  newName: string;
  startMessage?: string;
  sendMessageOptions?: SendMessageOptions;
}

export interface ForkResult {
  success: boolean;
  workspaceInfo?: FrontendWorkspaceMetadata;
  error?: string;
}

/**
 * Fork a workspace and switch to it
 * Handles copying storage, dispatching switch event, and optionally sending start message
 *
 * Caller is responsible for error handling, logging, and showing toasts
 */
export async function forkWorkspace(options: ForkOptions): Promise<ForkResult> {
  const result = await window.api.workspace.fork(options.sourceWorkspaceId, options.newName);

  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to fork workspace" };
  }

  // Copy UI state to the new workspace
  copyWorkspaceStorage(options.sourceWorkspaceId, result.metadata.id);

  // Get workspace info for switching
  const workspaceInfo = await window.api.workspace.getInfo(result.metadata.id);
  if (!workspaceInfo) {
    return { success: false, error: "Failed to get workspace info after fork" };
  }

  // Dispatch event to switch workspace
  dispatchWorkspaceSwitch(workspaceInfo);

  // If there's a start message, defer until React finishes rendering and WorkspaceStore subscribes
  // Using requestAnimationFrame ensures we wait for:
  // 1. React to process the workspace switch and update state
  // 2. Effects to run (workspaceStore.syncWorkspaces in App.tsx)
  // 3. WorkspaceStore to subscribe to the new workspace's IPC channel
  if (options.startMessage && options.sendMessageOptions) {
    requestAnimationFrame(() => {
      void window.api.workspace.sendMessage(
        result.metadata.id,
        options.startMessage!,
        options.sendMessageOptions
      );
    });
  }

  return { success: true, workspaceInfo };
}

/**
 * Dispatch a custom event to switch workspaces
 */
export function dispatchWorkspaceSwitch(workspaceInfo: FrontendWorkspaceMetadata): void {
  window.dispatchEvent(
    new CustomEvent(CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH, {
      detail: workspaceInfo,
    })
  );
}

/**
 * Type guard for workspace fork switch events
 */
export function isWorkspaceForkSwitchEvent(
  event: Event
): event is CustomEvent<FrontendWorkspaceMetadata> {
  return event.type === CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH;
}
