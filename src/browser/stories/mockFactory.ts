/**
 * Mock factory for full-app Storybook stories.
 *
 * Design philosophy:
 * - All visual states should be tested in context (full app), never in isolation
 * - Factory provides composable building blocks for different scenarios
 * - Keep mocks minimal but sufficient to exercise all visual paths
 */

import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceChatMessage, ChatMuxMessage } from "@/common/orpc/types";
import type {
  MuxTextPart,
  MuxReasoningPart,
  MuxImagePart,
  MuxToolPart,
} from "@/common/types/message";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";

/** Part type for message construction */
type MuxPart = MuxTextPart | MuxReasoningPart | MuxImagePart | MuxToolPart;
import type { RuntimeConfig } from "@/common/types/runtime";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

// ═══════════════════════════════════════════════════════════════════════════════
// STABLE TIMESTAMPS
// ═══════════════════════════════════════════════════════════════════════════════

/** Fixed timestamp for deterministic visual tests (Nov 14, 2023) */
export const NOW = 1700000000000;
/** Timestamp for messages - 1 minute ago from NOW */
export const STABLE_TIMESTAMP = NOW - 60000;

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export interface WorkspaceFixture {
  id: string;
  name: string;
  projectPath: string;
  projectName: string;
  runtimeConfig?: RuntimeConfig;
  createdAt?: string;
}

/** Create a workspace with sensible defaults */
export function createWorkspace(
  opts: Partial<WorkspaceFixture> & { id: string; name: string; projectName: string }
): FrontendWorkspaceMetadata {
  const projectPath = opts.projectPath ?? `/home/user/projects/${opts.projectName}`;
  const safeName = opts.name.replace(/\//g, "-");
  return {
    id: opts.id,
    name: opts.name,
    projectPath,
    projectName: opts.projectName,
    namedWorkspacePath: `/home/user/.mux/src/${opts.projectName}/${safeName}`,
    runtimeConfig: opts.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
    // Default to current time so workspaces aren't filtered as "old" by age-based UI
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

/** Create SSH workspace */
export function createSSHWorkspace(
  opts: Partial<WorkspaceFixture> & { id: string; name: string; projectName: string; host: string }
): FrontendWorkspaceMetadata {
  return createWorkspace({
    ...opts,
    runtimeConfig: {
      type: "ssh",
      host: opts.host,
      srcBaseDir: "/home/user/.mux/src",
    },
  });
}

/** Create local project-dir workspace (no isolation, uses project path directly) */
export function createLocalWorkspace(
  opts: Partial<WorkspaceFixture> & { id: string; name: string; projectName: string }
): FrontendWorkspaceMetadata {
  return createWorkspace({
    ...opts,
    runtimeConfig: { type: "local" },
  });
}

/** Create workspace with incompatible runtime (for downgrade testing) */
export function createIncompatibleWorkspace(
  opts: Partial<WorkspaceFixture> & {
    id: string;
    name: string;
    projectName: string;
    incompatibleReason?: string;
  }
): FrontendWorkspaceMetadata {
  return {
    ...createWorkspace(opts),
    incompatibleRuntime:
      opts.incompatibleReason ??
      "This workspace was created with a newer version of mux.\nPlease upgrade mux to use this workspace.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProjectFixture {
  path: string;
  workspaces: FrontendWorkspaceMetadata[];
}

/** Create project config from workspaces */
export function createProjectConfig(workspaces: FrontendWorkspaceMetadata[]): ProjectConfig {
  return {
    workspaces: workspaces.map((ws) => ({
      path: ws.namedWorkspacePath,
      id: ws.id,
      name: ws.name,
    })),
  };
}

/** Group workspaces into projects Map */
export function groupWorkspacesByProject(
  workspaces: FrontendWorkspaceMetadata[]
): Map<string, ProjectConfig> {
  const projects = new Map<string, ProjectConfig>();
  const byProject = new Map<string, FrontendWorkspaceMetadata[]>();

  for (const ws of workspaces) {
    const existing = byProject.get(ws.projectPath) ?? [];
    existing.push(ws);
    byProject.set(ws.projectPath, existing);
  }

  for (const [path, wsList] of byProject) {
    projects.set(path, createProjectConfig(wsList));
  }

  return projects;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export function createUserMessage(
  id: string,
  text: string,
  opts: { historySequence: number; timestamp?: number; images?: string[] }
): ChatMuxMessage {
  const parts: MuxPart[] = [{ type: "text", text }];
  if (opts.images) {
    for (const url of opts.images) {
      parts.push({ type: "file", mediaType: "image/png", url });
    }
  }
  return {
    type: "message",
    id,
    role: "user",
    parts,
    metadata: {
      historySequence: opts.historySequence,
      timestamp: opts.timestamp ?? STABLE_TIMESTAMP,
    },
  };
}

/** Create a compaction request user message (triggers shimmer effect on streaming response) */
export function createCompactionRequestMessage(
  id: string,
  opts: { historySequence: number; timestamp?: number; rawCommand?: string }
): ChatMuxMessage {
  const rawCommand = opts.rawCommand ?? "/compact";
  return {
    type: "message",
    id,
    role: "user",
    parts: [{ type: "text", text: rawCommand }],
    metadata: {
      historySequence: opts.historySequence,
      timestamp: opts.timestamp ?? STABLE_TIMESTAMP,
      muxMetadata: {
        type: "compaction-request",
        rawCommand,
        parsed: {},
      },
    },
  };
}

export function createAssistantMessage(
  id: string,
  text: string,
  opts: {
    historySequence: number;
    timestamp?: number;
    model?: string;
    reasoning?: string;
    toolCalls?: MuxPart[];
  }
): ChatMuxMessage {
  const parts: MuxPart[] = [];
  if (opts.reasoning) {
    parts.push({ type: "reasoning", text: opts.reasoning });
  }
  parts.push({ type: "text", text });
  if (opts.toolCalls) {
    parts.push(...opts.toolCalls);
  }
  return {
    type: "message",
    id,
    role: "assistant",
    parts,
    metadata: {
      historySequence: opts.historySequence,
      timestamp: opts.timestamp ?? STABLE_TIMESTAMP,
      model: opts.model ?? DEFAULT_MODEL,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      contextUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      duration: 1000,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL CALL FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export function createFileReadTool(toolCallId: string, filePath: string, content: string): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "read_file",
    state: "output-available",
    input: { target_file: filePath },
    output: { success: true, content },
  };
}

export function createFileEditTool(toolCallId: string, filePath: string, diff: string): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "file_edit_replace_string",
    state: "output-available",
    input: { file_path: filePath, old_string: "...", new_string: "..." },
    output: { success: true, diff, edits_applied: 1 },
  };
}

export function createBashTool(
  toolCallId: string,
  script: string,
  output: string,
  exitCode = 0,
  timeoutSecs = 3,
  durationMs = 50,
  displayName = "Bash"
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash",
    state: "output-available",
    input: {
      script,
      run_in_background: false,
      timeout_secs: timeoutSecs,
      display_name: displayName,
    },
    output: { success: exitCode === 0, output, exitCode, wall_duration_ms: durationMs },
  };
}

export function createTerminalTool(
  toolCallId: string,
  command: string,
  output: string,
  exitCode = 0
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "run_terminal_cmd",
    state: "output-available",
    input: { command, explanation: "Running command" },
    output: { success: exitCode === 0, stdout: output, exitCode },
  };
}

export function createStatusTool(
  toolCallId: string,
  emoji: string,
  message: string,
  url?: string
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "status_set",
    state: "output-available",
    input: { emoji, message, url },
    output: { success: true, emoji, message, url },
  };
}

export function createPendingTool(toolCallId: string, toolName: string, args: object): MuxPart {
  // Note: "input-available" is used for in-progress tool calls that haven't completed yet
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    state: "input-available",
    input: args,
  };
}

/** Create a generic tool call with custom name, args, and output - falls back to GenericToolCall */
export function createGenericTool(
  toolCallId: string,
  toolName: string,
  input: object,
  output: object
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    state: "output-available",
    input,
    output,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKGROUND BASH TOOL FACTORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a bash tool that spawns a background process */
export function createBackgroundBashTool(
  toolCallId: string,
  script: string,
  processId: string,
  displayName = "Background",
  timeoutSecs = 60
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash",
    state: "output-available",
    input: {
      script,
      run_in_background: true,
      display_name: displayName,
      timeout_secs: timeoutSecs,
    },
    output: {
      success: true,
      output: `Background process started with ID: ${processId}`,
      exitCode: 0,
      wall_duration_ms: 50,
      backgroundProcessId: processId,
    },
  };
}

/** Create a foreground bash that was migrated to background (user clicked "Background" button) */
export function createMigratedBashTool(
  toolCallId: string,
  script: string,
  processId: string,
  displayName = "Bash",
  capturedOutput?: string,
  timeoutSecs = 30
): MuxPart {
  const outputLines = capturedOutput?.split("\n") ?? [];
  const outputSummary =
    outputLines.length > 20
      ? `${outputLines.slice(-20).join("\n")}\n...(showing last 20 lines)`
      : (capturedOutput ?? "");
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash",
    state: "output-available",
    // No run_in_background flag - this started as foreground
    input: {
      script,
      run_in_background: false,
      display_name: displayName,
      timeout_secs: timeoutSecs,
    },
    output: {
      success: true,
      output: `Process sent to background with ID: ${processId}\n\nOutput so far (${outputLines.length} lines):\n${outputSummary}`,
      exitCode: 0,
      wall_duration_ms: 5000,
      backgroundProcessId: processId, // This triggers the "backgrounded" status
    },
  };
}

/** Create a bash_output tool call showing process output */
export function createBashOutputTool(
  toolCallId: string,
  processId: string,
  output: string,
  status: "running" | "exited" | "killed" | "failed" = "running",
  exitCode?: number,
  filter?: string,
  timeoutSecs = 5,
  filterExclude?: boolean
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash_output",
    state: "output-available",
    input: {
      process_id: processId,
      timeout_secs: timeoutSecs,
      filter,
      filter_exclude: filterExclude,
    },
    output: { success: true, status, output, exitCode },
  };
}

/** Create a bash_output tool call with error */
export function createBashOutputErrorTool(
  toolCallId: string,
  processId: string,
  error: string,
  timeoutSecs = 5
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash_output",
    state: "output-available",
    input: { process_id: processId, timeout_secs: timeoutSecs },
    output: { success: false, error },
  };
}

/** Create a bash_background_list tool call */
export function createBashBackgroundListTool(
  toolCallId: string,
  processes: Array<{
    process_id: string;
    status: "running" | "exited" | "killed" | "failed";
    script: string;
    uptime_ms: number;
    exitCode?: number;
    display_name?: string;
  }>
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash_background_list",
    state: "output-available",
    input: {},
    output: { success: true, processes },
  };
}

/** Create a bash_background_terminate tool call */
export function createBashBackgroundTerminateTool(
  toolCallId: string,
  processId: string,
  displayName?: string
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash_background_terminate",
    state: "output-available",
    input: { process_id: processId },
    output: {
      success: true,
      message: `Process ${processId} terminated`,
      display_name: displayName,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT STATUS MOCKS
// ═══════════════════════════════════════════════════════════════════════════════

export interface GitStatusFixture {
  ahead?: number;
  behind?: number;
  dirty?: number;
  headCommit?: string;
  originCommit?: string;

  // Optional overrides for line-delta display (additions/deletions)
  outgoingAdditions?: number;
  outgoingDeletions?: number;
  incomingAdditions?: number;
  incomingDeletions?: number;
}

export function createGitStatusOutput(fixture: GitStatusFixture): string {
  const { ahead = 0, behind = 0, dirty = 0 } = fixture;
  const headCommit = fixture.headCommit ?? "Latest commit";
  const originCommit = fixture.originCommit ?? "Latest commit";

  // Provide deterministic defaults so existing stories still show something
  // when the indicator switches to line-delta mode.
  const outgoingAdditions = fixture.outgoingAdditions ?? ahead * 12 + dirty * 2;
  const outgoingDeletions = fixture.outgoingDeletions ?? ahead * 4 + Math.max(0, dirty - 1);
  const incomingAdditions = fixture.incomingAdditions ?? behind * 10;
  const incomingDeletions = fixture.incomingDeletions ?? behind * 3;

  // Deterministic hex hashes (parseGitShowBranchForStatus expects [a-f0-9]+).
  let hashIndex = 0;
  const nextHash = () => {
    hashIndex++;
    return hashIndex.toString(16).padStart(7, "0");
  };

  const lines = ["---PRIMARY---", "main", "---SHOW_BRANCH---"];
  lines.push(`! [HEAD] ${headCommit}`);
  lines.push(` ! [origin/main] ${originCommit}`);
  lines.push("--");

  // Ahead commits (local only)
  for (let i = 0; i < ahead; i++) {
    lines.push(`-  [${nextHash()}] Local commit ${i + 1}`);
  }
  // Behind commits (origin only)
  for (let i = 0; i < behind; i++) {
    lines.push(` + [${nextHash()}] Origin commit ${i + 1}`);
  }
  // Synced commit
  if (ahead === 0 && behind === 0) {
    lines.push(`++ [${nextHash()}] ${headCommit}`);
  }

  lines.push("---DIRTY---");
  lines.push(String(dirty));
  lines.push("---LINE_DELTA---");
  lines.push(`${outgoingAdditions} ${outgoingDeletions} ${incomingAdditions} ${incomingDeletions}`);

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK API FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

/** Chat handler type for onChat callbacks */
type ChatHandler = (callback: (event: WorkspaceChatMessage) => void) => () => void;

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT SCENARIO BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Creates a chat handler that sends messages then caught-up */
export function createStaticChatHandler(messages: ChatMuxMessage[]): ChatHandler {
  return (callback) => {
    setTimeout(() => {
      for (const msg of messages) {
        callback(msg);
      }
      callback({ type: "caught-up" });
    }, 50);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {};
  };
}

/** Creates a chat handler with streaming state */
export function createStreamingChatHandler(opts: {
  messages: ChatMuxMessage[];
  streamingMessageId: string;
  model: string;
  historySequence: number;
  streamText?: string;
  pendingTool?: { toolCallId: string; toolName: string; args: object };
}): ChatHandler {
  return (callback) => {
    setTimeout(() => {
      // Send historical messages
      for (const msg of opts.messages) {
        callback(msg);
      }
      callback({ type: "caught-up" });

      // Start streaming
      callback({
        type: "stream-start",
        workspaceId: "mock",
        messageId: opts.streamingMessageId,
        model: opts.model,
        historySequence: opts.historySequence,
        startTime: Date.now(),
      });

      // Send text delta if provided
      if (opts.streamText) {
        callback({
          type: "stream-delta",
          workspaceId: "mock",
          messageId: opts.streamingMessageId,
          delta: opts.streamText,
          tokens: 10,
          timestamp: STABLE_TIMESTAMP,
        });
      }

      // Send tool call start if provided
      if (opts.pendingTool) {
        callback({
          type: "tool-call-start",
          workspaceId: "mock",
          messageId: opts.streamingMessageId,
          toolCallId: opts.pendingTool.toolCallId,
          toolName: opts.pendingTool.toolName,
          args: opts.pendingTool.args,
          tokens: 5,
          timestamp: STABLE_TIMESTAMP,
        });
      }
    }, 50);

    // Keep streaming state alive
    const intervalId = setInterval(() => {
      callback({
        type: "stream-delta",
        workspaceId: "mock",
        messageId: opts.streamingMessageId,
        delta: ".",
        tokens: 0,
        timestamp: NOW,
      });
    }, 2000);

    return () => clearInterval(intervalId);
  };
}
