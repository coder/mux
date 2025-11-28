import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import type { RuntimeConfig } from "@/common/types/runtime";
import { RUNTIME_MODE, SSH_RUNTIME_PREFIX } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "../types";
import type { MuxMobileClient, SendMessageOptions } from "../api/client";
import { buildMobileCompactionPayload } from "./slashCommandHelpers";

export interface SlashCommandRunnerContext {
  api: Pick<MuxMobileClient, "workspace" | "providers" | "projects">;
  workspaceId?: string | null;
  metadata?: FrontendWorkspaceMetadata | null;
  sendMessageOptions: SendMessageOptions;
  editingMessageId?: string;
  onClearTimeline: () => void;
  onCancelEdit: () => void;
  onNavigateToWorkspace: (workspaceId: string) => void;
  onSelectModel: (modelId: string) => void | Promise<void>;
  showInfo: (title: string, message: string) => void;
  showError: (title: string, message: string) => void;
}

export async function executeSlashCommand(
  parsed: ParsedCommand | null,
  ctx: SlashCommandRunnerContext
): Promise<boolean> {
  if (!parsed) {
    return false;
  }

  switch (parsed.type) {
    case "clear":
      return handleTruncate(ctx, 1);
    case "compact":
      return handleCompaction(ctx, parsed);
    case "model-set":
      await ctx.onSelectModel(parsed.modelString);
      ctx.showInfo("Model updated", `Switched to ${parsed.modelString}`);
      return true;
    case "model-help":
      ctx.showInfo(
        "/model",
        "Usage: /model <model-id>. Example: /model anthropic:claude-sonnet-4-5"
      );
      return true;
    case "providers-set":
      return handleProviderSet(ctx, parsed);
    case "providers-help":
      ctx.showInfo("/providers", "Usage: /providers set <provider> <keyPath> <value>");
      return true;
    case "providers-missing-args":
      ctx.showError(
        "/providers",
        "Missing required arguments. Usage: /providers set <provider> <keyPath> <value>"
      );
      return true;
    case "providers-invalid-subcommand":
      ctx.showError("/providers", `Unknown subcommand: ${parsed.subcommand}`);
      return true;
    case "fork":
      return handleFork(ctx, parsed);
    case "fork-help":
      ctx.showInfo(
        "/fork",
        "Usage: /fork <new-workspace-name>. Optionally add text on new lines to send as the first message."
      );
      return true;
    case "new":
      return handleNew(ctx, parsed);
    case "unknown-command":
      return false;
    case "telemetry-set":
    case "telemetry-help":
    case "vim-toggle":
      ctx.showInfo("Not supported", "This command is only available on the desktop app.");
      return true;
    default:
      return false;
  }
}

function ensureWorkspaceId(ctx: SlashCommandRunnerContext): string {
  if (!ctx.workspaceId) {
    throw new Error("Workspace required for this command");
  }
  return ctx.workspaceId;
}

async function handleTruncate(
  ctx: SlashCommandRunnerContext,
  percentage: number
): Promise<boolean> {
  try {
    const workspaceId = ensureWorkspaceId(ctx);
    const result = await ctx.api.workspace.truncateHistory(workspaceId, percentage);
    if (!result.success) {
      ctx.showError("History", result.error ?? "Failed to truncate history");
      return true;
    }
    ctx.onClearTimeline();
    ctx.onCancelEdit();
    ctx.showInfo(
      "History",
      percentage >= 1 ? "Cleared conversation" : `Truncated to ${(percentage * 100).toFixed(0)}%`
    );
    return true;
  } catch (error) {
    ctx.showError("History", getErrorMessage(error));
    return true;
  }
}

async function handleCompaction(
  ctx: SlashCommandRunnerContext,
  parsed: Extract<ParsedCommand, { type: "compact" }>
): Promise<boolean> {
  try {
    const workspaceId = ensureWorkspaceId(ctx);
    const { messageText, metadata, sendOptions } = buildMobileCompactionPayload(
      parsed,
      ctx.sendMessageOptions
    );

    const result = (await ctx.api.workspace.sendMessage(workspaceId, messageText, {
      ...sendOptions,
      muxMetadata: metadata,
      editMessageId: ctx.editingMessageId,
    })) as { success: boolean; error?: string };

    if (!result.success) {
      ctx.showError("Compaction", result.error ?? "Failed to start compaction");
      return true;
    }

    ctx.showInfo(
      "Compaction",
      "Summarization started. You will see the summary when it completes."
    );
    ctx.onCancelEdit();
    return true;
  } catch (error) {
    ctx.showError("Compaction", getErrorMessage(error));
    return true;
  }
}

async function handleProviderSet(
  ctx: SlashCommandRunnerContext,
  parsed: Extract<ParsedCommand, { type: "providers-set" }>
): Promise<boolean> {
  try {
    const result = await ctx.api.providers.setProviderConfig(
      parsed.provider,
      parsed.keyPath,
      parsed.value
    );
    if (!result.success) {
      ctx.showError("Providers", result.error ?? "Failed to update provider");
      return true;
    }
    ctx.showInfo("Providers", `Updated ${parsed.provider}`);
    return true;
  } catch (error) {
    ctx.showError("Providers", getErrorMessage(error));
    return true;
  }
}

async function handleFork(
  ctx: SlashCommandRunnerContext,
  parsed: Extract<ParsedCommand, { type: "fork" }>
): Promise<boolean> {
  try {
    const workspaceId = ensureWorkspaceId(ctx);
    const result = await ctx.api.workspace.fork(workspaceId, parsed.newName);
    if (!result.success) {
      ctx.showError("Fork", result.error ?? "Failed to fork workspace");
      return true;
    }

    ctx.onNavigateToWorkspace(result.metadata.id);
    ctx.showInfo("Fork", `Switched to ${result.metadata.name}`);

    if (parsed.startMessage) {
      await ctx.api.workspace.sendMessage(
        result.metadata.id,
        parsed.startMessage,
        ctx.sendMessageOptions
      );
    }
    return true;
  } catch (error) {
    ctx.showError("Fork", getErrorMessage(error));
    return true;
  }
}

async function handleNew(
  ctx: SlashCommandRunnerContext,
  parsed: Extract<ParsedCommand, { type: "new" }>
): Promise<boolean> {
  if (!parsed.workspaceName) {
    ctx.showError("New workspace", "Please provide a name, e.g. /new feature-branch");
    return true;
  }

  const projectPath = ctx.metadata?.projectPath;
  if (!projectPath) {
    ctx.showError("New workspace", "Current workspace project path unknown");
    return true;
  }

  try {
    const trunkBranch = await resolveTrunkBranch(ctx, projectPath, parsed.trunkBranch);
    const runtimeConfig = parseRuntimeStringForMobile(parsed.runtime);
    const result = await ctx.api.workspace.create(
      projectPath,
      parsed.workspaceName,
      trunkBranch,
      runtimeConfig
    );
    if (!result.success) {
      ctx.showError("New workspace", result.error ?? "Failed to create workspace");
      return true;
    }

    ctx.onNavigateToWorkspace(result.metadata.id);
    ctx.showInfo("New workspace", `Created ${result.metadata.name}`);

    if (parsed.startMessage) {
      await ctx.api.workspace.sendMessage(
        result.metadata.id,
        parsed.startMessage,
        ctx.sendMessageOptions
      );
    }

    return true;
  } catch (error) {
    ctx.showError("New workspace", getErrorMessage(error));
    return true;
  }
}

async function resolveTrunkBranch(
  ctx: SlashCommandRunnerContext,
  projectPath: string,
  explicit?: string
): Promise<string> {
  if (explicit) {
    return explicit;
  }
  try {
    const { recommendedTrunk, branches } = await ctx.api.projects.listBranches(projectPath);
    return recommendedTrunk ?? branches?.[0] ?? "main";
  } catch (error) {
    ctx.showInfo(
      "Branches",
      `Failed to load branches (${getErrorMessage(error)}). Defaulting to main.`
    );
    return "main";
  }
}

export function parseRuntimeStringForMobile(runtime?: string): RuntimeConfig | undefined {
  if (!runtime) {
    return undefined;
  }
  const trimmed = runtime.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === RUNTIME_MODE.LOCAL) {
    return undefined;
  }
  if (lower === RUNTIME_MODE.SSH || lower.startsWith(SSH_RUNTIME_PREFIX)) {
    const hostPart = trimmed.slice(SSH_RUNTIME_PREFIX.length - 1).trim();
    if (!hostPart) {
      throw new Error("SSH runtime requires host (e.g., 'ssh hostname' or 'ssh user@host')");
    }
    return {
      type: RUNTIME_MODE.SSH,
      host: hostPart,
      srcBaseDir: "~/mux",
    };
  }
  throw new Error(`Unknown runtime: ${runtime}`);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error";
}
