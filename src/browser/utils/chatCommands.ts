/**
 * Chat command execution utilities
 * Handles executing workspace operations from slash commands
 *
 * These utilities are shared between ChatInput command handlers and UI components
 * to ensure consistent behavior and avoid duplication.
 */

import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { FilePart, ProviderModelEntry, SendMessageOptions } from "@/common/orpc/types";
import {
  type MuxMessageMetadata,
  type CompactionRequestData,
  type CompactionFollowUpRequest,
  type CompactionFollowUpInput,
  pickPreservedSendOptions,
} from "@/common/types/message";
import type { ReviewNoteData } from "@/common/types/review";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig } from "@/common/types/runtime";
import { RUNTIME_MODE, parseRuntimeModeAndHost } from "@/common/types/runtime";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import {
  WORKSPACE_ONLY_COMMAND_KEYS,
  WORKSPACE_ONLY_COMMAND_TYPES,
} from "@/constants/slashCommands";
import type { Toast } from "@/browser/components/ChatInputToast";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import {
  formatCompactionCommandLine,
  getFollowUpContentText,
} from "@/browser/utils/compaction/format";
import { applyCompactionOverrides } from "@/browser/utils/messages/compactionOptions";
import { resolveCompactionModel } from "@/browser/utils/messages/compactionModelPreference";
import { normalizeModelInput } from "@/browser/utils/models/normalizeModelInput";
import type { QueueDispatchMode } from "@/browser/components/ChatInput/types";
import type { ChatAttachment } from "../components/ChatAttachments";
import { dispatchWorkspaceSwitch } from "./workspaceEvents";
import { getRuntimeKey, copyWorkspaceStorage } from "@/common/constants/storage";
import { buildCompactionMessageText } from "@/common/utils/compaction/compactionPrompt";
import { getProviderModelEntryId } from "@/common/utils/providers/modelEntries";
import { openInEditor } from "@/browser/utils/openInEditor";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

// ============================================================================
// Workspace Creation
// ============================================================================

import {
  createCommandToast,
  createInvalidCompactModelToast,
} from "@/browser/components/ChatInputToasts";
import { trackCommandUsed } from "@/common/telemetry";
import { addEphemeralMessage } from "@/browser/stores/WorkspaceStore";

const BUILT_IN_MODEL_SET = new Set<string>(Object.values(KNOWN_MODELS).map((model) => model.id));

export interface ForkOptions {
  client: RouterClient<AppRouter>;
  sourceWorkspaceId: string;
  newName?: string;
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
  const startMessage = options.startMessage;
  const sendMessageOptions = options.sendMessageOptions;
  if (startMessage && sendMessageOptions) {
    requestAnimationFrame(() => {
      client.workspace
        .sendMessage({
          workspaceId: result.metadata.id,
          message: startMessage,
          options: sendMessageOptions,
        })
        .catch(() => {
          // Best-effort: the user can send the message manually if this fails.
        });
    });
  }

  return { success: true, workspaceInfo };
}

export interface SlashCommandContext extends Omit<CommandHandlerContext, "workspaceId" | "api"> {
  api: RouterClient<AppRouter> | null;
  workspaceId?: string;
  variant: "workspace" | "creation";
  projectPath?: string | null;
  openSettings?: (section?: string) => void;

  // Global Actions
  setPreferredModel: (model: string) => void;
  setVimEnabled: (cb: (prev: boolean) => boolean) => void;

  // Workspace Actions
  onTruncateHistory?: (percentage?: number) => Promise<void>;
  resetInputHeight: () => void;
  /** Callback to trigger message-sent side effects (auto-scroll, auto-background) */
  onMessageSent?: (dispatchMode: QueueDispatchMode) => void;
  /** Callback to mark review IDs as checked after successful send */
  onCheckReviews?: (reviewIds: string[]) => void;
  /** Review IDs that are attached (for marking as checked on success) */
  attachedReviewIds?: string[];
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
  const { api: client, setInput, setToast, variant, setVimEnabled, setPreferredModel } = context;

  const requireClient = (): RouterClient<AppRouter> | null => {
    if (client) return client;
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "Not connected to server",
    });
    return null;
  };

  // 1. Global Commands
  if (parsed.type === "model-set") {
    const modelString = parsed.modelString;

    const activeClient = client;
    const normalized = normalizeModelInput(modelString);

    if (!normalized.model) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: `Invalid model format: expected "provider:model"`,
      });
      return { clearInput: false, toastShown: true };
    }

    const canonicalModel = normalized.model;
    const separatorIndex = canonicalModel.indexOf(":");
    const provider = canonicalModel.slice(0, separatorIndex);
    const modelId = canonicalModel.slice(separatorIndex + 1);

    try {
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

      // Align with settings behavior: only persist non-built-in, non-gateway models.
      if (activeClient && !BUILT_IN_MODEL_SET.has(canonicalModel) && provider !== "mux-gateway") {
        try {
          const config = await activeClient.providers.getConfig();
          const existingModels: ProviderModelEntry[] = config[provider]?.models ?? [];
          if (!existingModels.some((entry) => getProviderModelEntryId(entry) === modelId)) {
            // Add model via the same API as settings
            await activeClient.providers.setModels({
              provider,
              models: [...existingModels, modelId],
            });
          }
        } catch (error) {
          console.error("Failed to sync model settings:", error);
        }
      }

      setInput("");
      setPreferredModel(canonicalModel);
      trackCommandUsed("model");
      setToast({
        id: Date.now().toString(),
        type: "success",
        message: `Model changed to ${canonicalModel}`,
      });
      return { clearInput: true, toastShown: true };
    } catch (error) {
      console.error("Failed to update model:", error);
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: error instanceof Error ? error.message : "Failed to update model",
      });
      return { clearInput: false, toastShown: true };
    }
  }

  // model-oneshot ("/<model-alias> ...") is handled directly in ChatInput.
  // This keeps the command parsing centralized, but routes actual sending through the
  // normal message-send flow (so side effects like review completion and last-read
  // tracking can't drift).

  if (parsed.type === "model-oneshot") {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "Model one-shot is handled in the chat input.",
    });
    return { clearInput: false, toastShown: true };
  }

  if (parsed.type === "debug-llm-request") {
    setInput("");
    window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST));
    return { clearInput: true, toastShown: false };
  }

  if (parsed.type === "idle-compaction") {
    const activeClient = requireClient();
    if (!activeClient) {
      return { clearInput: false, toastShown: true };
    }

    if (!context.projectPath) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: "No project selected",
      });
      return { clearInput: false, toastShown: true };
    }

    setInput("");

    try {
      const result = await activeClient.projects.idleCompaction.set({
        projectPath: context.projectPath,
        hours: parsed.hours,
      });

      if (!result.success) {
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: result.error ?? "Failed to update setting",
        });
        return { clearInput: false, toastShown: true };
      }

      setToast({
        id: Date.now().toString(),
        type: "success",
        message: parsed.hours
          ? `Idle compaction set to ${parsed.hours} hours`
          : "Idle compaction disabled",
      });
      return { clearInput: true, toastShown: true };
    } catch (error) {
      setToast({
        id: Date.now().toString(),
        type: "error",
        message: error instanceof Error ? error.message : "Failed to update setting",
      });
      return { clearInput: false, toastShown: true };
    }
  }
  if (parsed.type === "vim-toggle") {
    setInput("");
    setVimEnabled((prev) => !prev);
    trackCommandUsed("vim");
    return { clearInput: true, toastShown: false };
  }

  // 2. Workspace Commands
  // Use command keys for help/invalid variants so creation mode doesn't surface workspace-only help text.
  const workspaceOnlyKey = (() => {
    switch (parsed.type) {
      case "command-missing-args":
      case "command-invalid-args":
      case "unknown-command":
        return parsed.command;
      default:
        return null;
    }
  })();

  const isWorkspaceCommandType = WORKSPACE_ONLY_COMMAND_TYPES.has(parsed.type);
  const isWorkspaceOnlyCommand =
    isWorkspaceCommandType ||
    (workspaceOnlyKey ? WORKSPACE_ONLY_COMMAND_KEYS.has(workspaceOnlyKey) : false);

  if (isWorkspaceOnlyCommand && variant !== "workspace") {
    setToast({
      id: Date.now().toString(),
      type: "error",
      message: "Command not available during workspace creation",
    });
    return { clearInput: false, toastShown: true };
  }

  if (isWorkspaceCommandType) {
    // Dispatch workspace commands
    switch (parsed.type) {
      case "clear":
        return handleClearCommand(parsed, context);
      case "truncate":
        return handleTruncateCommand(parsed, context);
      case "compact":
        // handleCompactCommand expects workspaceId in context
        if (!context.workspaceId) throw new Error("Workspace ID required");
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handleCompactCommand(parsed, {
          ...context,
          api: client,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "fork":
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handleForkCommand(parsed, {
          ...context,
          api: client,
        });
      case "new":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handleNewCommand(parsed, {
          ...context,
          api: client,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "plan-show":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handlePlanShowCommand({
          ...context,
          api: client,
          workspaceId: context.workspaceId,
        } as CommandHandlerContext);
      case "plan-open":
        if (!context.workspaceId) throw new Error("Workspace ID required");
        if (!requireClient()) {
          return { clearInput: false, toastShown: true };
        }
        return handlePlanOpenCommand({
          ...context,
          api: client,
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
    setSendingState,
    setToast,
  } = context;

  setInput(""); // Clear input immediately
  setSendingState(true);

  try {
    // Note: workspaceId is required for fork, but SlashCommandContext allows undefined workspaceId.
    // If we are here, variant === "workspace", so workspaceId should be defined.
    if (!workspaceId) throw new Error("Workspace ID required for fork");

    if (!client) throw new Error("Client required for fork");
    const forkResult = await forkWorkspace({
      client,
      sourceWorkspaceId: workspaceId,
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
      const displayName =
        forkResult.workspaceInfo?.title ?? forkResult.workspaceInfo?.name ?? "new workspace";
      setToast({
        id: Date.now().toString(),
        type: "success",
        message: `Forked to workspace "${displayName}"`,
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
    setSendingState(false);
  }
}

/**
 * Parse runtime string from -r flag into RuntimeConfig for backend.
 * Uses shared parseRuntimeModeAndHost for parsing, then converts to RuntimeConfig.
 *
 * Supports formats:
 * - "ssh <host>" or "ssh <user@host>" -> SSH runtime
 * - "docker <image>" -> Docker container runtime
 * - "worktree" -> Worktree runtime (git worktrees)
 * - "local" -> Local runtime (project-dir, no isolation)
 * - "devcontainer <configPath>" -> Dev container runtime
 * - undefined -> Worktree runtime (default)
 */
export function parseRuntimeString(
  runtime: string | undefined,
  _workspaceName: string
): RuntimeConfig | undefined {
  // Use shared parser from common/types/runtime
  const parsed = parseRuntimeModeAndHost(runtime);

  // null means invalid input (e.g., "ssh" without host, "docker" without image)
  if (parsed === null) {
    // Determine which error to throw based on input
    const trimmed = runtime?.trim().toLowerCase() ?? "";
    if (trimmed === RUNTIME_MODE.SSH || trimmed.startsWith("ssh ")) {
      throw new Error("SSH runtime requires host (e.g., 'ssh hostname' or 'ssh user@host')");
    }
    if (trimmed === RUNTIME_MODE.DOCKER || trimmed.startsWith("docker ")) {
      throw new Error("Docker runtime requires image (e.g., 'docker ubuntu:22.04')");
    }
    if (trimmed === RUNTIME_MODE.DEVCONTAINER || trimmed.startsWith("devcontainer")) {
      throw new Error(
        "Dev container runtime requires a config path (e.g., 'devcontainer .devcontainer/devcontainer.json')"
      );
    }
    throw new Error(
      `Unknown runtime type: '${runtime ?? ""}'. Use 'ssh <host>', 'docker <image>', 'devcontainer <config>', 'worktree', or 'local'`
    );
  }

  // Convert ParsedRuntime to RuntimeConfig
  switch (parsed.mode) {
    case RUNTIME_MODE.WORKTREE:
      return undefined; // Let backend use default worktree config

    case RUNTIME_MODE.LOCAL:
      return { type: RUNTIME_MODE.LOCAL };

    case RUNTIME_MODE.SSH:
      return {
        type: RUNTIME_MODE.SSH,
        host: parsed.host,
        srcBaseDir: "~/mux", // Default remote base directory (tilde resolved by backend)
      };

    case RUNTIME_MODE.DEVCONTAINER: {
      const configPath = parsed.configPath.trim();
      if (!configPath) {
        throw new Error(
          "Dev container runtime requires a config path (e.g., 'devcontainer .devcontainer/devcontainer.json')"
        );
      }
      return {
        type: RUNTIME_MODE.DEVCONTAINER,
        configPath,
      };
    }
    case RUNTIME_MODE.DOCKER:
      return {
        type: RUNTIME_MODE.DOCKER,
        image: parsed.image,
      };
  }
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
  const startMessage = options.startMessage;
  const sendMessageOptions = options.sendMessageOptions;
  const client = options.client;
  if (startMessage && sendMessageOptions) {
    requestAnimationFrame(() => {
      client.workspace
        .sendMessage({
          workspaceId: result.metadata.id,
          message: startMessage,
          options: sendMessageOptions,
        })
        .catch(() => {
          // Best-effort: the user can send the message manually if this fails.
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

// Re-export buildContinueMessage from common/types for backward compatibility
export { buildContinueMessage } from "@/common/types/message";

export interface CompactionOptions {
  api?: RouterClient<AppRouter>;
  workspaceId: string;
  maxOutputTokens?: number;
  /**
   * Content to continue with after compaction.
   * Accepts CompactionFollowUpInput (without model/agentId) - prepareCompactionMessage
   * will add model/agentId from sendMessageOptions to produce CompactionFollowUpRequest.
   */
  followUpContent?: CompactionFollowUpInput;
  model?: string;
  sendMessageOptions: SendMessageOptions;
  editMessageId?: string;
  /** Source of compaction request (e.g., "idle-compaction" for auto-triggered) */
  source?: "idle-compaction";
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
  metadata: MuxMessageMetadata;
  sendOptions: SendMessageOptions;
} {
  // followUpContent is the content that will be auto-sent after compaction.
  // For forced compaction (no explicit follow-up), we inject a short resume sentinel ("Continue").
  // Keep that sentinel out of the *compaction prompt* (summarization request), otherwise the model can
  // misread it as a competing instruction. We still keep it in metadata so the backend resumes.
  // Only treat it as the default resume when there's no other queued content (images/reviews).
  //
  // Convert CompactionFollowUpInput to CompactionFollowUpRequest by adding model/agentId.
  // Compaction uses its own agentId ("compact") and potentially a different model for
  // summarization, so we capture the user's original settings for the follow-up message.
  //
  // In compaction recovery (retrying a failed /compact), followUpContent may already be
  // a CompactionFollowUpRequest with preserved model/agentId. Only fill in missing fields
  // to avoid overwriting the original settings when the user changes model/agent before retry.
  let fc: CompactionFollowUpRequest | undefined;
  if (options.followUpContent) {
    // Check if already a CompactionFollowUpRequest (has model/agentId from previous compaction)
    const existingModel =
      "model" in options.followUpContent &&
      typeof options.followUpContent.model === "string" &&
      options.followUpContent.model
        ? options.followUpContent.model
        : undefined;
    const existingAgentId =
      "agentId" in options.followUpContent &&
      typeof options.followUpContent.agentId === "string" &&
      options.followUpContent.agentId
        ? options.followUpContent.agentId
        : undefined;

    fc = {
      ...options.followUpContent,
      model: existingModel ?? options.sendMessageOptions.model,
      agentId: existingAgentId ?? options.sendMessageOptions.agentId ?? WORKSPACE_DEFAULTS.agentId,
      ...pickPreservedSendOptions(options.sendMessageOptions),
    };
  }

  // Build compaction message with optional continue context.
  // Shared helper is also used by backend-triggered idle compaction.
  const messageText = buildCompactionMessageText({
    maxOutputTokens: options.maxOutputTokens,
    followUpContent: fc,
  });

  // Handle model preference (sticky globally)
  const effectiveModel = resolveCompactionModel(options.model);

  const commandLine = formatCompactionCommandLine(options);
  const continueText = getFollowUpContentText(fc);
  const fullRawCommand = continueText ? `${commandLine}\n${continueText}` : commandLine;

  const compactData: CompactionRequestData = {
    model: effectiveModel,
    maxOutputTokens: options.maxOutputTokens,
    followUpContent: fc,
  };

  // Apply compaction overrides
  const sendOptions = applyCompactionOverrides(options.sendMessageOptions, compactData);

  const metadata: MuxMessageMetadata = {
    type: "compaction-request",
    rawCommand: fullRawCommand,
    commandPrefix: commandLine,
    parsed: compactData,
    // requestedModel keeps the "starting" banner aligned with compaction overrides.
    requestedModel: sendOptions.model,
    ...(options.source === "idle-compaction" && {
      source: options.source,
      displayStatus: { emoji: "💤", message: "Compacting idle workspace..." },
    }),
  };

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

// ============================================================================
// Command Handler Types
// ============================================================================

export interface CommandHandlerContext {
  api: RouterClient<AppRouter>;
  workspaceId: string;
  sendMessageOptions: SendMessageOptions;
  fileParts?: FilePart[];
  /** Reviews attached to the message (from code review panel) */
  reviews?: ReviewNoteData[];
  editMessageId?: string;
  setInput: (value: string) => void;
  setAttachments: (attachments: ChatAttachment[]) => void;
  /** Increment/decrement the sending counter. Pass true to increment, false to decrement. */
  setSendingState: (increment: boolean) => void;
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
    setSendingState,
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
  setSendingState(true);

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
    setSendingState(false);
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
    setAttachments,
    setSendingState,
    setToast,
    onCancelEdit,
  } = context;

  // normalizeModelInput handles null/empty — returns { model: null } for empty input
  const normalizedModel = normalizeModelInput(parsed.model);

  // Validate model format early - fail fast before sending to backend
  if (parsed.model && !normalizedModel.model) {
    setToast(createInvalidCompactModelToast(parsed.model));
    return { clearInput: false, toastShown: true };
  }

  setInput("");
  setAttachments([]);
  setSendingState(true);

  try {
    // Build followUpContent directly from parsed command + context
    const hasContent =
      parsed.continueMessage ?? context.fileParts?.length ?? context.reviews?.length;
    const followUpContent: CompactionFollowUpInput | undefined = hasContent
      ? {
          text: parsed.continueMessage ?? "",
          fileParts: context.fileParts,
          reviews: context.reviews,
        }
      : undefined;

    const resolvedModel = normalizedModel.model ?? undefined;

    const result = await executeCompaction({
      api,
      workspaceId,
      maxOutputTokens: parsed.maxOutputTokens,
      followUpContent,
      model: resolvedModel,
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
    setSendingState(false);
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
    isFile: true,
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
