/**
 * Chat command execution utilities
 * Handles executing workspace operations from slash commands
 *
 * These utilities are shared between ChatInput command handlers and UI components
 * to ensure consistent behavior and avoid duplication.
 */

import type { SendMessageOptions } from "@/common/types/ipc";
import type { MuxFrontendMetadata, CompactionRequestData } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { RUNTIME_MODE, SSH_RUNTIME_PREFIX } from "@/common/types/runtime";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import type { Toast } from "@/browser/components/ChatInputToast";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import { resolveCompactionModel } from "@/browser/utils/messages/compactionModelPreference";
import { getRuntimeKey } from "@/common/constants/storage";

// ============================================================================
// Workspace Creation
// ============================================================================

/**
 * Parse runtime string from -r flag into RuntimeConfig for backend
 * Supports formats:
 * - "ssh <host>" or "ssh <user@host>" -> SSH runtime
 * - "local" -> Local runtime (explicit)
 * - undefined -> Local runtime (default)
 */
export function parseRuntimeString(
  runtime: string | undefined,
  _workspaceName: string
): RuntimeConfig | undefined {
  if (!runtime) {
    return undefined; // Default to local (backend decides)
  }

  const trimmed = runtime.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  if (lowerTrimmed === RUNTIME_MODE.LOCAL) {
    return undefined; // Explicit local - let backend use default
  }

  // Parse "ssh <host>" or "ssh <user@host>" format
  if (lowerTrimmed === RUNTIME_MODE.SSH || lowerTrimmed.startsWith(SSH_RUNTIME_PREFIX)) {
    const hostPart = trimmed.slice(SSH_RUNTIME_PREFIX.length - 1).trim(); // Preserve original case for host
    if (!hostPart) {
      throw new Error("SSH runtime requires host (e.g., 'ssh hostname' or 'ssh user@host')");
    }

    // Accept both "hostname" and "user@hostname" formats
    // SSH will use current user or ~/.ssh/config if user not specified
    // Use tilde path - backend will resolve it via runtime.resolvePath()
    return {
      type: RUNTIME_MODE.SSH,
      host: hostPart,
      srcBaseDir: "~/mux", // Default remote base directory (tilde will be resolved by backend)
    };
  }

  throw new Error(`Unknown runtime type: '${runtime}'. Use 'ssh <host>' or 'local'`);
}

export interface CreateWorkspaceOptions {
  projectPath: string;
  workspaceName: string;
  trunkBranch?: string;
  runtime?: string;
  startMessage?: string;
  sendMessageOptions?: SendMessageOptions;
}

export interface CreateWorkspaceResult {
  success: boolean;
  workspaceInfo?: FrontendWorkspaceMetadata;
  error?: string;
}

/**
 * Create a new workspace and switch to it
 * Handles backend creation, dispatching switch event, and optionally sending start message
 *
 * Shared between /new command and NewWorkspaceModal
 */
export async function createNewWorkspace(
  options: CreateWorkspaceOptions
): Promise<CreateWorkspaceResult> {
  // Get recommended trunk if not provided
  let effectiveTrunk = options.trunkBranch;
  if (!effectiveTrunk) {
    const { recommendedTrunk } = await window.api.projects.listBranches(options.projectPath);
    effectiveTrunk = recommendedTrunk ?? "main";
  }

  // Use saved runtime preference if not explicitly provided
  let effectiveRuntime = options.runtime;
  if (effectiveRuntime === undefined) {
    const runtimeKey = getRuntimeKey(options.projectPath);
    const savedRuntime = localStorage.getItem(runtimeKey);
    if (savedRuntime) {
      effectiveRuntime = savedRuntime;
    }
  }

  // Parse runtime config if provided
  const runtimeConfig = parseRuntimeString(effectiveRuntime, options.workspaceName);

  const result = await window.api.workspace.create(
    options.projectPath,
    options.workspaceName,
    effectiveTrunk,
    runtimeConfig
  );

  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to create workspace" };
  }

  // Get workspace info for switching
  const workspaceInfo = await window.api.workspace.getInfo(result.metadata.id);
  if (!workspaceInfo) {
    return { success: false, error: "Failed to get workspace info after creation" };
  }

  // Dispatch event to switch workspace
  dispatchWorkspaceSwitch(workspaceInfo);

  // If there's a start message, defer until React finishes rendering and WorkspaceStore subscribes
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
 * Format /new command string for display
 */
export function formatNewCommand(
  workspaceName: string,
  trunkBranch?: string,
  runtime?: string,
  startMessage?: string
): string {
  let cmd = `/new ${workspaceName}`;
  if (trunkBranch) {
    cmd += ` -t ${trunkBranch}`;
  }
  if (runtime) {
    cmd += ` -r '${runtime}'`;
  }
  if (startMessage) {
    cmd += `\n${startMessage}`;
  }
  return cmd;
}

// ============================================================================
// Workspace Forking (re-exported from workspaceFork for convenience)
// ============================================================================

export { forkWorkspace } from "./workspaceFork";

// ============================================================================
// Compaction
// ============================================================================

export interface CompactionOptions {
  workspaceId: string;
  maxOutputTokens?: number;
  continueMessage?: string;
  model?: string;
  sendMessageOptions: SendMessageOptions;
  editMessageId?: string;
}

export interface CompactionResult {
  success: boolean;
  error?: string;
}

/**
 * Prepare compaction message from options
 * Returns the actual message text (summarization request), metadata, and options
 */
export function prepareCompactionMessage(options: CompactionOptions): {
  messageText: string;
  metadata: MuxFrontendMetadata;
  sendOptions: SendMessageOptions;
} {
  const targetWords = options.maxOutputTokens ? Math.round(options.maxOutputTokens / 1.3) : 2000;

  // Build compaction message with optional continue context
  let messageText = `Summarize this conversation into a compact form for a new Assistant to continue helping the user. Use approximately ${targetWords} words.`;

  if (options.continueMessage) {
    messageText += `\n\nThe user wants to continue with: ${options.continueMessage}`;
  }

  // Handle model preference (sticky globally)
  const effectiveModel = resolveCompactionModel(options.model);

  // Create compaction metadata (will be stored in user message)
  const compactData: CompactionRequestData = {
    model: effectiveModel,
    maxOutputTokens: options.maxOutputTokens,
    continueMessage: options.continueMessage,
    resumeModel: options.sendMessageOptions.model,
  };

  const metadata: MuxFrontendMetadata = {
    type: "compaction-request",
    rawCommand: formatCompactionCommand(options),
    parsed: compactData,
  };

  // Apply compaction overrides
  const sendOptions = applyCompactionOverrides(options.sendMessageOptions, compactData);

  return { messageText, metadata, sendOptions };
}

/**
 * Execute a compaction command
 */
export async function executeCompaction(options: CompactionOptions): Promise<CompactionResult> {
  const { messageText, metadata, sendOptions } = prepareCompactionMessage(options);

  const result = await window.api.workspace.sendMessage(options.workspaceId, messageText, {
    ...sendOptions,
    muxMetadata: metadata,
    editMessageId: options.editMessageId,
  });

  if (!result.success) {
    // Convert SendMessageError to string for error display
    const errorString = result.error
      ? typeof result.error === "string"
        ? result.error
        : "type" in result.error
          ? result.error.type
          : "Failed to compact"
      : undefined;
    return { success: false, error: errorString };
  }

  return { success: true };
}

/**
 * Format compaction command string for display
 */
function formatCompactionCommand(options: CompactionOptions): string {
  let cmd = "/compact";
  if (options.maxOutputTokens) {
    cmd += ` -t ${options.maxOutputTokens}`;
  }
  if (options.model) {
    cmd += ` -m ${options.model}`;
  }
  if (options.continueMessage) {
    cmd += `\n${options.continueMessage}`;
  }
  return cmd;
}

// ============================================================================
// Command Handler Types
// ============================================================================

export interface CommandHandlerContext {
  workspaceId: string;
  sendMessageOptions: SendMessageOptions;
  editMessageId?: string;
  setInput: (value: string) => void;
  setIsSending: (value: boolean) => void;
  setToast: (toast: Toast) => void;
  onCancelEdit?: () => void;
}

export interface CommandHandlerResult {
  /** Whether the input should be cleared */
  clearInput: boolean;
  /** Whether to show a toast (already set via context.setToast) */
  toastShown: boolean;
}

/**
 * Handle /new command execution
 */
export async function handleNewCommand(
  parsed: Extract<ParsedCommand, { type: "new" }>,
  context: CommandHandlerContext
): Promise<CommandHandlerResult> {
  const { workspaceId, sendMessageOptions, setInput, setIsSending, setToast } = context;

  // Open modal if no workspace name provided
  if (!parsed.workspaceName) {
    setInput("");

    // Get workspace info to extract projectPath for the modal
    const workspaceInfo = await window.api.workspace.getInfo(workspaceId);
    if (!workspaceInfo) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        title: "Error",
        message: "Failed to get workspace info",
      });
      return { clearInput: false, toastShown: true };
    }

    // Dispatch event with start message, model, and optional preferences
    const event = createCustomEvent(CUSTOM_EVENTS.START_WORKSPACE_CREATION, {
      projectPath: workspaceInfo.projectPath,
      startMessage: parsed.startMessage ?? "",
      model: sendMessageOptions.model,
      trunkBranch: parsed.trunkBranch,
      runtime: parsed.runtime,
    });
    window.dispatchEvent(event);
    return { clearInput: true, toastShown: false };
  }

  setInput("");
  setIsSending(true);

  try {
    // Get workspace info to extract projectPath
    const workspaceInfo = await window.api.workspace.getInfo(workspaceId);
    if (!workspaceInfo) {
      throw new Error("Failed to get workspace info");
    }

    const createResult = await createNewWorkspace({
      projectPath: workspaceInfo.projectPath,
      workspaceName: parsed.workspaceName,
      trunkBranch: parsed.trunkBranch,
      runtime: parsed.runtime,
      startMessage: parsed.startMessage,
      sendMessageOptions,
    });

    if (!createResult.success) {
      const errorMsg = createResult.error ?? "Failed to create workspace";
      console.error("Failed to create workspace:", errorMsg);
      setToast({
        id: Date.now().toString(),
        type: "error",
        title: "Create Failed",
        message: errorMsg,
      });
      return { clearInput: false, toastShown: true };
    }

    setToast({
      id: Date.now().toString(),
      type: "success",
      message: `Created workspace "${parsed.workspaceName}"`,
    });
    return { clearInput: true, toastShown: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Failed to create workspace";
    console.error("Create error:", error);
    setToast({
      id: Date.now().toString(),
      type: "error",
      title: "Create Failed",
      message: errorMsg,
    });
    return { clearInput: false, toastShown: true };
  } finally {
    setIsSending(false);
  }
}

/**
 * Handle /compact command execution
 */
export async function handleCompactCommand(
  parsed: Extract<ParsedCommand, { type: "compact" }>,
  context: CommandHandlerContext
): Promise<CommandHandlerResult> {
  const {
    workspaceId,
    sendMessageOptions,
    editMessageId,
    setInput,
    setIsSending,
    setToast,
    onCancelEdit,
  } = context;

  setInput("");
  setIsSending(true);

  try {
    const result = await executeCompaction({
      workspaceId,
      maxOutputTokens: parsed.maxOutputTokens,
      continueMessage: parsed.continueMessage,
      model: parsed.model,
      sendMessageOptions,
      editMessageId,
    });

    if (!result.success) {
      console.error("Failed to initiate compaction:", result.error);
      const errorMsg = result.error ?? "Failed to start compaction";
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: errorMsg,
      });
      return { clearInput: false, toastShown: true };
    }

    setToast({
      id: Date.now().toString(),
      type: "success",
      message: parsed.continueMessage
        ? "Compaction started. Will continue automatically after completion."
        : "Compaction started. AI will summarize the conversation.",
    });

    // Clear editing state on success
    if (editMessageId && onCancelEdit) {
      onCancelEdit();
    }

    return { clearInput: true, toastShown: true };
  } catch (error) {
    console.error("Compaction error:", error);
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: error instanceof Error ? error.message : "Failed to start compaction",
    });
    return { clearInput: false, toastShown: true };
  } finally {
    setIsSending(false);
  }
}

// ============================================================================
// Utilities
// ============================================================================

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
