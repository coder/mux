/**
 * Mock ORPC client factory for Storybook stories.
 *
 * Creates a client that matches the AppRouter interface with configurable mock data.
 */
import type { APIClient } from "@/browser/contexts/API";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/node/config";
import type {
  WorkspaceChatMessage,
  ProvidersConfigMap,
  WorkspaceStatsSnapshot,
} from "@/common/orpc/types";
import type { Secret } from "@/common/types/secrets";
import type { ChatStats } from "@/common/types/chatStats";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import {
  DEFAULT_TASK_SETTINGS,
  normalizeSubagentAiDefaults,
  normalizeTaskSettings,
  type SubagentAiDefaults,
  type TaskSettings,
} from "@/common/types/tasks";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { isWorkspaceArchived } from "@/common/utils/archive";

/** Session usage data structure matching SessionUsageFileSchema */
export interface MockSessionUsage {
  byModel: Record<
    string,
    {
      input: { tokens: number; cost_usd?: number };
      cached: { tokens: number; cost_usd?: number };
      cacheCreate: { tokens: number; cost_usd?: number };
      output: { tokens: number; cost_usd?: number };
      reasoning: { tokens: number; cost_usd?: number };
      model?: string;
    }
  >;
  lastRequest?: {
    model: string;
    usage: {
      input: { tokens: number; cost_usd?: number };
      cached: { tokens: number; cost_usd?: number };
      cacheCreate: { tokens: number; cost_usd?: number };
      output: { tokens: number; cost_usd?: number };
      reasoning: { tokens: number; cost_usd?: number };
      model?: string;
    };
    timestamp: number;
  };
  version: 1;
}

export interface MockORPCClientOptions {
  projects?: Map<string, ProjectConfig>;
  workspaces?: FrontendWorkspaceMetadata[];
  /** Initial task settings for config.getConfig (e.g., Settings → Tasks section) */
  taskSettings?: Partial<TaskSettings>;
  /** Initial per-subagent AI defaults for config.getConfig (e.g., Settings → Tasks section) */
  subagentAiDefaults?: SubagentAiDefaults;
  /** Per-workspace chat callback. Return messages to emit, or use the callback for streaming. */
  onChat?: (workspaceId: string, emit: (msg: WorkspaceChatMessage) => void) => (() => void) | void;
  /** Mock for executeBash per workspace */
  executeBash?: (
    workspaceId: string,
    script: string
  ) => Promise<{ success: true; output: string; exitCode: number; wall_duration_ms: number }>;
  /** Provider configuration (API keys, base URLs, etc.) */
  providersConfig?: ProvidersConfigMap;
  /** List of available provider names */
  providersList?: string[];
  /** Mock for projects.remove - return error string to simulate failure */
  onProjectRemove?: (projectPath: string) => { success: true } | { success: false; error: string };
  /** Background processes per workspace */
  backgroundProcesses?: Map<
    string,
    Array<{
      id: string;
      pid: number;
      script: string;
      displayName?: string;
      startTime: number;
      status: "running" | "exited" | "killed" | "failed";
      exitCode?: number;
    }>
  >;
  /** Session usage data per workspace (for Costs tab) */
  workspaceStatsSnapshots?: Map<string, WorkspaceStatsSnapshot>;
  statsTabVariant?: "control" | "stats";
  /** Project secrets per project */
  projectSecrets?: Map<string, Secret[]>;
  sessionUsage?: Map<string, MockSessionUsage>;
  /** MCP server configuration per project */
  mcpServers?: Map<
    string,
    Record<string, { command: string; disabled: boolean; toolAllowlist?: string[] }>
  >;
  /** MCP workspace overrides per workspace */
  mcpOverrides?: Map<
    string,
    { disabledServers?: string[]; enabledServers?: string[]; toolAllowlist?: Record<string, string[]> }
  >;
  /** MCP test results - maps server name to tools list or error */
  mcpTestResults?: Map<string, { success: true; tools: string[] } | { success: false; error: string }>;
}

/**
 * Creates a mock ORPC client for Storybook.
 *
 * Usage:
 * ```tsx
 * const client = createMockORPCClient({
 *   projects: new Map([...]),
 *   workspaces: [...],
 *   onChat: (wsId, emit) => {
 *     emit({ type: "caught-up" });
 *     // optionally return cleanup function
 *   },
 * });
 *
 * return <AppLoader client={client} />;
 * ```
 */
export function createMockORPCClient(options: MockORPCClientOptions = {}): APIClient {
  const {
    projects = new Map(),
    workspaces = [],
    onChat,
    executeBash,
    providersConfig = {},
    providersList = [],
    onProjectRemove,
    backgroundProcesses = new Map(),
    sessionUsage = new Map(),
    workspaceStatsSnapshots = new Map<string, WorkspaceStatsSnapshot>(),
    statsTabVariant = "control",
    projectSecrets = new Map<string, Secret[]>(),
    mcpServers = new Map(),
    mcpOverrides = new Map(),
    mcpTestResults = new Map(),
    taskSettings: initialTaskSettings,
    subagentAiDefaults: initialSubagentAiDefaults,
  } = options;

  // Feature flags
  let statsTabOverride: "default" | "on" | "off" = "default";

  const getStatsTabState = () => {
    const enabled =
      statsTabOverride === "on"
        ? true
        : statsTabOverride === "off"
          ? false
          : statsTabVariant === "stats";

    return { enabled, variant: statsTabVariant, override: statsTabOverride } as const;
  };

  const workspaceMap = new Map(workspaces.map((w) => [w.id, w]));
  let taskSettings = normalizeTaskSettings(initialTaskSettings ?? DEFAULT_TASK_SETTINGS);
  let subagentAiDefaults = normalizeSubagentAiDefaults(initialSubagentAiDefaults ?? {});

  const mockStats: ChatStats = {
    consumers: [],
    totalTokens: 0,
    model: "mock-model",
    tokenizerName: "mock-tokenizer",
    usageHistory: [],
  };

  // Cast to ORPCClient - TypeScript can't fully validate the proxy structure
  return {
    tokenizer: {
      countTokens: async () => 0,
      countTokensBatch: async (_input: { model: string; texts: string[] }) =>
        _input.texts.map(() => 0),
      calculateStats: async () => mockStats,
    },
    features: {
      getStatsTabState: async () => getStatsTabState(),
      setStatsTabOverride: async (input: { override: "default" | "on" | "off" }) => {
        statsTabOverride = input.override;
        return getStatsTabState();
      },
    },
    telemetry: {
      track: async () => undefined,
    },
    server: {
      getLaunchProject: async () => null,
      getSshHost: async () => null,
      setSshHost: async () => undefined,
    },
    config: {
      getConfig: async () => ({ taskSettings, subagentAiDefaults }),
      saveConfig: async (input: { taskSettings: unknown; subagentAiDefaults?: unknown }) => {
        taskSettings = normalizeTaskSettings(input.taskSettings);
        if (input.subagentAiDefaults !== undefined) {
          subagentAiDefaults = normalizeSubagentAiDefaults(input.subagentAiDefaults);
        }
        return undefined;
      },
    },
    providers: {
      list: async () => providersList,
      getConfig: async () => providersConfig,
      setProviderConfig: async () => ({ success: true, data: undefined }),
      setModels: async () => ({ success: true, data: undefined }),
    },
    general: {
      listDirectory: async () => ({ entries: [], hasMore: false }),
      ping: async (input: string) => `Pong: ${input}`,
      tick: async function* () {
        // No-op generator
      },
    },
    projects: {
      list: async () => Array.from(projects.entries()),
      create: async () => ({
        success: true,
        data: { projectConfig: { workspaces: [] }, normalizedPath: "/mock/project" },
      }),
      pickDirectory: async () => null,
      listBranches: async () => ({
        branches: ["main", "develop", "feature/new-feature"],
        recommendedTrunk: "main",
      }),
      remove: async (input: { projectPath: string }) => {
        if (onProjectRemove) {
          return onProjectRemove(input.projectPath);
        }
        return { success: true, data: undefined };
      },
      secrets: {
        get: async (input: { projectPath: string }) =>
          projectSecrets.get(input.projectPath) ?? [],
        update: async (input: { projectPath: string; secrets: Secret[] }) => {
          projectSecrets.set(input.projectPath, input.secrets);
          return { success: true, data: undefined };
        },
      },
      mcp: {
        list: async (input: { projectPath: string }) => mcpServers.get(input.projectPath) ?? {},
        add: async () => ({ success: true, data: undefined }),
        remove: async () => ({ success: true, data: undefined }),
        test: async (input: { projectPath: string; name?: string }) => {
          if (input.name && mcpTestResults.has(input.name)) {
            return mcpTestResults.get(input.name)!;
          }
          // Default: return empty tools
          return { success: true, tools: [] };
        },
        setEnabled: async () => ({ success: true, data: undefined }),
        setToolAllowlist: async () => ({ success: true, data: undefined }),
      },
      idleCompaction: {
        get: async () => ({ success: true, hours: null }),
        set: async () => ({ success: true }),
      },
    },
    workspace: {
      list: async (input?: { archived?: boolean }) => {
        if (input?.archived) {
          return workspaces.filter((w) => isWorkspaceArchived(w.archivedAt, w.unarchivedAt));
        }
        return workspaces.filter((w) => !isWorkspaceArchived(w.archivedAt, w.unarchivedAt));
      },
      archive: async () => ({ success: true }),
      unarchive: async () => ({ success: true }),
      create: async (input: { projectPath: string; branchName: string }) => ({
        success: true,
        metadata: {
          id: Math.random().toString(36).substring(2, 12),
          name: input.branchName,
          projectPath: input.projectPath,
          projectName: input.projectPath.split("/").pop() ?? "project",
          namedWorkspacePath: `/mock/workspace/${input.branchName}`,
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        },
      }),
      remove: async () => ({ success: true }),
      rename: async (input: { workspaceId: string }) => ({
        success: true,
        data: { newWorkspaceId: input.workspaceId },
      }),
      fork: async () => ({ success: false, error: "Not implemented in mock" }),
      sendMessage: async () => ({ success: true, data: undefined }),
      resumeStream: async () => ({ success: true, data: undefined }),
      interruptStream: async () => ({ success: true, data: undefined }),
      clearQueue: async () => ({ success: true, data: undefined }),
      truncateHistory: async () => ({ success: true, data: undefined }),
      replaceChatHistory: async () => ({ success: true, data: undefined }),
      getInfo: async (input: { workspaceId: string }) =>
        workspaceMap.get(input.workspaceId) ?? null,
      executeBash: async (input: { workspaceId: string; script: string }) => {
        if (executeBash) {
          const result = await executeBash(input.workspaceId, input.script);
          return { success: true, data: result };
        }
        return {
          success: true,
          data: { success: true, output: "", exitCode: 0, wall_duration_ms: 0 },
        };
      },
      onChat: async function* (
        input: { workspaceId: string },
        options?: { signal?: AbortSignal }
      ) {
        if (!onChat) {
          // Default mock behavior: subscriptions should remain open.
          // If this ends, WorkspaceStore will retry and reset state, which flakes stories.
          yield { type: "caught-up" } as WorkspaceChatMessage;

          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) {
              resolve();
              return;
            }
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }

        const { push, iterate, end } = createAsyncMessageQueue<WorkspaceChatMessage>();

        // Call the user's onChat handler
        const cleanup = onChat(input.workspaceId, push);

        try {
          yield* iterate();
        } finally {
          end();
          cleanup?.();
        }
      },
      onMetadata: async function* () {
        // Empty generator - no metadata updates in mock
        return;
      },
      activity: {
        list: async () => ({}),
        subscribe: async function* () {
          return;
        },
      },
      backgroundBashes: {
        subscribe: async function* (input: { workspaceId: string }) {
          // Yield initial state
          yield {
            processes: backgroundProcesses.get(input.workspaceId) ?? [],
            foregroundToolCallIds: [],
          };
          // Then hang forever (like a real subscription)
          await new Promise(() => {});
        },
        terminate: async () => ({ success: true, data: undefined }),
        sendToBackground: async () => ({ success: true, data: undefined }),
      },
      stats: {
        subscribe: async function* (input: { workspaceId: string }) {
          const snapshot = workspaceStatsSnapshots.get(input.workspaceId);
          if (snapshot) {
            yield snapshot;
          }
        },
        clear: async (input: { workspaceId: string }) => {
          workspaceStatsSnapshots.delete(input.workspaceId);
          return { success: true, data: undefined };
        },
      },
      getSessionUsage: async (input: { workspaceId: string }) => sessionUsage.get(input.workspaceId),
      getSessionUsageBatch: async (input: { workspaceIds: string[] }) => {
        const result: Record<string, MockSessionUsage | undefined> = {};
        for (const id of input.workspaceIds) {
          result[id] = sessionUsage.get(id);
        }
        return result;
      },
      mcp: {
        get: async (input: { workspaceId: string }) => mcpOverrides.get(input.workspaceId) ?? {},
        set: async () => ({ success: true, data: undefined }),
      },
    },
    window: {
      setTitle: async () => undefined,
    },
    terminal: {
      create: async () => ({
        sessionId: "mock-session",
        workspaceId: "mock-workspace",
        cols: 80,
        rows: 24,
      }),
      close: async () => undefined,
      resize: async () => undefined,
      sendInput: () => undefined,
      onOutput: async function* () {
        await new Promise(() => {});
      },
      onExit: async function* () {
        await new Promise(() => {});
      },
      openWindow: async () => undefined,
      closeWindow: async () => undefined,
      openNative: async () => undefined,
    },
    update: {
      check: async () => undefined,
      download: async () => undefined,
      install: () => undefined,
      onStatus: async function* () {
        await new Promise(() => {});
      },
    },
  } as unknown as APIClient;
}
