/**
 * Mock ORPC client factory for Storybook stories.
 *
 * Creates a client that matches the AppRouter interface with configurable mock data.
 */
import type { APIClient } from "@/browser/contexts/API";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/node/config";
import type { WorkspaceChatMessage, ProvidersConfigMap } from "@/common/orpc/types";
import type { ChatStats } from "@/common/types/chatStats";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";

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
  sessionUsage?: Map<string, MockSessionUsage>;
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
  } = options;

  const workspaceMap = new Map(workspaces.map((w) => [w.id, w]));

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
    server: {
      getLaunchProject: async () => null,
      getSshHost: async () => null,
      setSshHost: async () => undefined,
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
        get: async () => [],
        update: async () => ({ success: true, data: undefined }),
      },
    },
    workspace: {
      list: async () => workspaces,
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
      onChat: async function* (input: { workspaceId: string }) {
        if (!onChat) {
          yield { type: "caught-up" } as WorkspaceChatMessage;
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
        await new Promise(() => {}); // Never resolves, keeps stream open
      },
      activity: {
        list: async () => ({}),
        subscribe: async function* () {
          await new Promise(() => {}); // Never resolves
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
      getSessionUsage: async (input: { workspaceId: string }) => sessionUsage.get(input.workspaceId),
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
