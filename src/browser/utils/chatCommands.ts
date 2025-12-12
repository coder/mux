/**
 * Chat command execution utilities
 * Handles executing workspace operations from slash commands
 *
 * These utilities are shared between ChatInput command handlers and UI components
 * to ensure consistent behavior and avoid duplication.
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { SendMessageOptions, ImagePart } from "@/common/orpc/types";
import type {
  MuxFrontendMetadata,
  CompactionRequestData,
  ContinueMessage,
} from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { RUNTIME_MODE, SSH_RUNTIME_PREFIX } from "@/common/types/runtime";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { WORKSPACE_ONLY_COMMANDS } from "@/constants/slashCommands";
import type { Toast } from "@/browser/components/ChatInputToast";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import { resolveCompactionModel } from "@/browser/utils/messages/compactionModelPreference";
import type { ImageAttachment } from "../components/ImageAttachments";
import { dispatchWorkspaceSwitch } from "./workspaceEvents";
import { getRuntimeKey, copyWorkspaceStorage } from "@/common/constants/storage";
import {
  DEFAULT_COMPACTION_WORD_TARGET,
  WORDS_TO_TOKENS_RATIO,
  buildCompactionPrompt,
} from "@/common/constants/ui";
import { openInEditor } from "@/browser/utils/openInEditor";

// ============================================================================
// Workspace Creation
// ============================================================================

import { createCommandToast } from "@/browser/components/ChatInputToasts";
import { trackCommandUsed, trackProviderConfigured } from "@/common/telemetry";
import { addEphemeralMessage } from "@/browser/stores/WorkspaceStore";

export interface ForkOptions {
  client: RouterClient<AppRouter>;
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
  const { client } = options;
  const result = await client.workspace.fork({
    sourceWorkspaceId: options.sourceWorkspaceId,
    newName: options.newName,
  });

  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to fork workspace" };
  }

  // Copy UI state to the new workspace
  copyWorkspaceStorage(options.sourceWorkspaceId, result.metadata.id);

  // Get workspace info for switching
  const workspaceInfo = await client.workspace.getInfo({ workspaceId: result.metadata.id });
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
      void client.workspace.sendMessage({
        workspaceId: result.metadata.id,
        message: options.startMessage!,
        options: options.sendMessageOptions,
      });
    });
  }

  return { success: true, workspaceInfo };
}

export interface SlashCommandContext extends Omit<CommandHandlerContext, "workspaceId"> {
  workspaceId?: string;
  variant: "workspace" | "creation";

  // Global Actions
  onProviderConfig?: (provider: string, keyPath: string[], value: string) => Promise<void>;
  onModelChange?: (model: string) => void;
  setPreferredModel: (model: string) => void;
  setVimEnabled: (cb: (prev: boolean) => boolean) => void;

  // Workspace Actions
  onTruncateHistory?: (percentage?: number) => Promise<void>;
  resetInputHeight: () => void;
}

// ============================================================================
// Command Dispatcher
// ============================================================================

/**
 * Process any slash command
 * Returns true if the command was handled (even if it failed)
 * Returns false if it's not a command (should be sent as message) - though parsed usually implies it is a command
 */
export async function processSlashCommand(
  parsed: ParsedCommand,
  context: SlashCommandContext
): Promise<CommandHandlerResult> {
  if (!parsed) return { clearInput: false, toastShown: false };
  const {
    api: client,
    setInput,
    setIsSending,
    setToast,
    variant,
    setVimEnabled,
    setPreferredModel,
    onModelChange,
  } = context;

  // 1. Global Commands
  if (parsed.type === "providers-set") {
    if (context.onProviderConfig) {
      setIsSending(true);
      setInput(""); // Clear input immediately

      try {
        await context.onProviderConfig(parsed.provider, parsed.keyPath, parsed.value);
        // Track successful provider configuration
        trackCommandUsed("providers");
        trackProviderConfigured(parsed.provider, parsed.keyPath[0] ?? "unknown");
        setToast({
          id: Date.now().toString(),
          type: "success",
          message: `Provider ${parsed.provider} updated`,
        });
      } catch (error) {
        console.error("Failed to update provider config:", error);
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: error instanceof Error ? error.message : "Failed to update provider",
        });
        return { clearInput: false, toastShown: true }; // Input restored by caller if clearInput is false?
        // Actually caller restores if we return clearInput: false.
        // But here we cleared it proactively?
        // The caller (ChatInput) pattern is: if (!result.clearInput) setInput(original).
        // So we should return clearInput: false on error.
      } finally {
        setIsSending(false);
      }
      return { clearInput: true, toastShown: true };
    }
    return { clearInput: false, toastShown: false };
  }

  if (parsed.type === "model-set") {
    const modelString = parsed.modelString;

    // Validate provider:model format
    if (!modelString.includes(":")) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: `Invalid model format: expected "provider:model"`,
      });
      return { clearInput: false, toastShown: true };
    }

    const [provider, modelId] = modelString.split(":", 2);
    if (!provider || !modelId) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: `Invalid model format: expected "provider:model"`,
      });
      return { clearInput: false, toastShown: true };
    }

    // Validate provider is supported
    const { isValidProvider } = await import("@/common/constants/providers");
    if (!isValidProvider(provider)) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: `Unknown provider "${provider}"`,
      });
      return { clearInput: false, toastShown: true };
    }

    // Check if model needs to be added to provider's custom models
    const config = await client.providers.getConfig();
    const existingModels = config[provider]?.models ?? [];
    if (!existingModels.includes(modelId)) {
      // Add model via the same API as settings
      await client.providers.setModels({ provider, models: [...existingModels, modelId] });
    }

    setInput("");
    setPreferredModel(modelString);
    onModelChange?.(modelString);
    trackCommandUsed("model");
    setToast({
      id: Date.now().toString(),
      type: "success",
      message: `Model changed to ${modelString}`,
    });
    return { clearInput: true, toastShown: true };
  }

  if (parsed.type === "vim-toggle") {
    setInput("");
    setVimEnabled((prev) => !prev);
    trackCommandUsed("vim");
    return { clearInput: true, toastShown: false };
  }

  // 2. Workspace Commands
  const isWorkspaceCommand = WORKSPACE_ONLY_COMMANDS.has(parsed.type);

  if (isWorkspaceCommand) {
    if (variant !== "workspace") {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: "Command not available during workspace creation",
      });
      return { clearInput: false, toastShown: true };
    }

    // Dispatch workspace commands
    switch (parsed.type) {
      case "clear":
        return handleClearCommand(parsed, context);
      case "truncate":
        return handleTruncateCommand(parsed, context);
      case "compact":
        // handleCompactCommand expects workspaceId in context
        if (!context.workspaceId) throw new Error("Workspace ID required");
        return handleCompactCommand(parsed, {
          ...context,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "fork":
        return handleForkCommand(parsed, context);
      case "new":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        return handleNewCommand(parsed, {
          ...context,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "plan-show":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        return handlePlanShowCommand({
          ...context,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "plan-open":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        return handlePlanOpenCommand({
          ...context,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
    }
  }

  // 3. Fallback / Help / Unknown
  const commandToast = createCommandToast(parsed);
  if (commandToast) {
    setToast(commandToast);
    return { clearInput: false, toastShown: true };
  }

  return { clearInput: false, toastShown: false };
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleClearCommand(
  _parsed: Extract<ParsedCommand, { type: "clear" }>,
  context: SlashCommandContext
): Promise<CommandHandlerResult> {
  const { setInput, onTruncateHistory, resetInputHeight, setToast } = context;

  setInput("");
  resetInputHeight();

  if (!onTruncateHistory) return { clearInput: true, toastShown: false };

  try {
    await onTruncateHistory(1.0);
    trackCommandUsed("clear");
    setToast({
      id: Date.now().toString(),
      type: "success",
      message: "Chat history cleared",
    });
    return { clearInput: true, toastShown: true };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Failed to clear history");
    console.error("Failed to clear history:", normalized);
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: normalized.message,
    });
    return { clearInput: false, toastShown: true };
  }
}

async function handleTruncateCommand(
  parsed: Extract<ParsedCommand, { type: "truncate" }>,
  context: SlashCommandContext
): Promise<CommandHandlerResult> {
  const { setInput, onTruncateHistory, resetInputHeight, setToast } = context;

  setInput("");
  resetInputHeight();

  if (!onTruncateHistory) return { clearInput: true, toastShown: false };

  try {
    await onTruncateHistory(parsed.percentage);
    setToast({
      id: Date.now().toString(),
      type: "success",
      message: `Chat history truncated by ${Math.round(parsed.percentage * 100)}%`,
    });
    return { clearInput: true, toastShown: true };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Failed to truncate history");
    console.error("Failed to truncate history:", normalized);
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: normalized.message,
    });
    return { clearInput: false, toastShown: true };
  }
}

async function handleForkCommand(
  parsed: Extract<ParsedCommand, { type: "fork" }>,
  context: SlashCommandContext
): Promise<CommandHandlerResult> {
  const {
    api: client,
    workspaceId,
    sendMessageOptions,
    setInput,
    setIsSending,
    setToast,
  } = context;

  setInput(""); // Clear input immediately
  setIsSending(true);

  try {
    // Note: workspaceId is required for fork, but SlashCommandContext allows undefined workspaceId.
    // If we are here, variant === "workspace", so workspaceId should be defined.
    if (!workspaceId) throw new Error("Workspace ID required for fork");

    if (!client) throw new Error("Client required for fork");
    const forkResult = await forkWorkspace({
      client,
      sourceWorkspaceId: workspaceId,
      newName: parsed.newName,
      startMessage: parsed.startMessage,
      sendMessageOptions,
    });

    if (!forkResult.success) {
      const errorMsg = forkResult.error ?? "Failed to fork workspace";
      console.error("Failed to fork workspace:", errorMsg);
      setToast({
        id: Date.now().toString(),
        type: "error",
        title: "Fork Failed",
        message: errorMsg,
      });
      return { clearInput: false, toastShown: true };
    } else {
      trackCommandUsed("fork");
      setToast({
        id: Date.now().toString(),
        type: "success",
        message: `Forked to workspace "${parsed.newName}"`,
      });
      return { clearInput: true, toastShown: true };
    }
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Failed to fork workspace");
    console.error("Fork error:", normalized);
    setToast({
      id: Date.now().toString(),
      type: "error",
      title: "Fork Failed",
      message: normalized.message,
    });
    return { clearInput: false, toastShown: true };
  } finally {
    setIsSending(false);
  }
}

/**
 * Parse runtime string from -r flag into RuntimeConfig for backend
 * Supports formats:
 * - "ssh <host>" or "ssh <user@host>" -> SSH runtime
 * - "worktree" -> Worktree runtime (git worktrees)
 * - "local" -> Local runtime (project-dir, no isolation)
 * - undefined -> Worktree runtime (default)
 */
export function parseRuntimeString(
  runtime: string | undefined,
  _workspaceName: string
): RuntimeConfig | undefined {
  if (!runtime) {
    return undefined; // Default to worktree (backend decides)
  }

  const trimmed = runtime.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  // Worktree runtime (explicit or default)
  if (lowerTrimmed === RUNTIME_MODE.WORKTREE) {
    return undefined; // Explicit worktree - let backend use default
  }

  // Local runtime (project-dir, no isolation)
  if (lowerTrimmed === RUNTIME_MODE.LOCAL) {
    // Return "local" type without srcBaseDir to indicate project-dir runtime
    return { type: RUNTIME_MODE.LOCAL };
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

  throw new Error(`Unknown runtime type: '${runtime}'. Use 'ssh <host>', 'worktree', or 'local'`);
}

export interface CreateWorkspaceOptions {
  client: RouterClient<AppRouter>;
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
    const { recommendedTrunk } = await options.client.projects.listBranches({
      projectPath: options.projectPath,
    });
    effectiveTrunk = recommendedTrunk ?? "main";
  }

  // Use saved default runtime preference if not explicitly provided
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

  const result = await options.client.workspace.create({
    projectPath: options.projectPath,
    branchName: options.workspaceName,
    trunkBranch: effectiveTrunk,
    runtimeConfig,
  });

  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to create workspace" };
  }

  // Get workspace info for switching
  const workspaceInfo = await options.client.workspace.getInfo({ workspaceId: result.metadata.id });
  if (!workspaceInfo) {
    return { success: false, error: "Failed to get workspace info after creation" };
  }

  // Dispatch event to switch workspace
  dispatchWorkspaceSwitch(workspaceInfo);

  // If there's a start message, defer until React finishes rendering and WorkspaceStore subscribes
  if (options.startMessage && options.sendMessageOptions) {
    requestAnimationFrame(() => {
      void options.client.workspace.sendMessage({
        workspaceId: result.metadata.id,
        message: options.startMessage!,
        options: options.sendMessageOptions,
      });
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
// Workspace Forking (Inline implementation)
// ============================================================================

// ============================================================================
// Compaction
// ============================================================================

export interface CompactionOptions {
  api?: RouterClient<AppRouter>;
  workspaceId: string;
  maxOutputTokens?: number;
  continueMessage?: ContinueMessage;
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
  const targetWords = options.maxOutputTokens
    ? Math.round(options.maxOutputTokens / WORDS_TO_TOKENS_RATIO)
    : DEFAULT_COMPACTION_WORD_TARGET;

  // Build compaction message with optional continue context
  let messageText = buildCompactionPrompt(targetWords);

  if (options.continueMessage) {
    messageText += `\n\nThe user wants to continue with: ${options.continueMessage.text}`;
  }

  // Handle model preference (sticky globally)
  const effectiveModel = resolveCompactionModel(options.model);

  // Create compaction metadata (will be stored in user message)
  // Only include continueMessage if there's text, images, or reviews to queue after compaction
  const hasText = options.continueMessage?.text;
  const hasImages =
    options.continueMessage?.imageParts && options.continueMessage.imageParts.length > 0;
  const hasReviews = options.continueMessage?.reviews && options.continueMessage.reviews.length > 0;
  const compactData: CompactionRequestData = {
    model: effectiveModel,
    maxOutputTokens: options.maxOutputTokens,
    continueMessage:
      hasText || hasImages || hasReviews
        ? {
            text: options.continueMessage?.text ?? "",
            imageParts: options.continueMessage?.imageParts,
            model: options.continueMessage?.model ?? options.sendMessageOptions.model,
            reviews: options.continueMessage?.reviews,
          }
        : undefined,
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
export async function executeCompaction(
  options: CompactionOptions & { api: RouterClient<AppRouter> }
): Promise<CompactionResult> {
  const { messageText, metadata, sendOptions } = prepareCompactionMessage(options);

  const result = await options.api.workspace.sendMessage({
    workspaceId: options.workspaceId,
    message: messageText,
    options: {
      ...sendOptions,
      muxMetadata: metadata,
      editMessageId: options.editMessageId,
    },
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
    cmd += `\n${options.continueMessage.text}`;
  }
  return cmd;
}

// ============================================================================
// Command Handler Types
// ============================================================================

export interface CommandHandlerContext {
  api: RouterClient<AppRouter>;
  workspaceId: string;
  sendMessageOptions: SendMessageOptions;
  imageParts?: ImagePart[];
  editMessageId?: string;
  setInput: (value: string) => void;
  setImageAttachments: (images: ImageAttachment[]) => void;
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
  const {
    api: client,
    workspaceId,
    sendMessageOptions,
    setInput,
    setIsSending,
    setToast,
  } = context;

  // Open modal if no workspace name provided
  if (!parsed.workspaceName) {
    setInput("");

    // Get workspace info to extract projectPath for the modal
    const workspaceInfo = await client.workspace.getInfo({ workspaceId });
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
    const workspaceInfo = await client.workspace.getInfo({ workspaceId });
    if (!workspaceInfo) {
      throw new Error("Failed to get workspace info");
    }

    const createResult = await createNewWorkspace({
      client,
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

    trackCommandUsed("new");
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
    api,
    workspaceId,
    sendMessageOptions,
    editMessageId,
    setInput,
    setImageAttachments,
    setIsSending,
    setToast,
    onCancelEdit,
  } = context;

  setInput("");
  setImageAttachments([]);
  setIsSending(true);

  try {
    const result = await executeCompaction({
      api,
      workspaceId,
      maxOutputTokens: parsed.maxOutputTokens,
      continueMessage:
        parsed.continueMessage || (context.imageParts && context.imageParts.length > 0)
          ? {
              text: parsed.continueMessage ?? "",
              imageParts: context.imageParts,
              model: sendMessageOptions.model,
            }
          : undefined,
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

    trackCommandUsed("compact");
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
// Plan Command Handlers
// ============================================================================

export async function handlePlanShowCommand(
  context: CommandHandlerContext
): Promise<CommandHandlerResult> {
  const { api, workspaceId, setInput, setToast } = context;

  setInput("");

  const result = await api.workspace.getPlanContent({ workspaceId });
  if (!result.success) {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "No plan found for this workspace",
    });
    return { clearInput: true, toastShown: true };
  }

  // Create ephemeral plan-display message (not persisted to history)
  // Uses addEphemeralMessage to properly trigger React re-render via store bump
  // Use a very high historySequence so it appears at the end of the chat
  const planMessage = {
    id: `plan-display-${Date.now()}`,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: result.data.content }],
    metadata: {
      historySequence: Number.MAX_SAFE_INTEGER, // Appear at end of chat
      muxMetadata: { type: "plan-display" as const, path: result.data.path },
    },
  };
  addEphemeralMessage(workspaceId, planMessage);

  trackCommandUsed("plan");
  return { clearInput: true, toastShown: false };
}

export async function handlePlanOpenCommand(
  context: CommandHandlerContext
): Promise<CommandHandlerResult> {
  const { api, workspaceId, setInput, setToast } = context;

  setInput("");

  // First get the plan path
  const planResult = await api.workspace.getPlanContent({ workspaceId });
  if (!planResult.success) {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "No plan found for this workspace",
    });
    return { clearInput: true, toastShown: true };
  }

  const workspaceInfo = await api.workspace.getInfo({ workspaceId });
  const openResult = await openInEditor({
    api,
    workspaceId,
    targetPath: planResult.data.path,
    runtimeConfig: workspaceInfo?.runtimeConfig,
  });

  if (!openResult.success) {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: openResult.error ?? "Failed to open editor",
    });
    return { clearInput: true, toastShown: true };
  }

  trackCommandUsed("plan");
  setToast({
    id: Date.now().toString(),
    type: "success",
    message: "Opened plan in editor",
  });
  return { clearInput: true, toastShown: true };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Dispatch a custom event to switch workspaces
 */
