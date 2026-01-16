/**
 * Mock ORPC client factory for Storybook stories.
 *
 * Creates a client that matches the AppRouter interface with configurable mock data.
 */
import type { APIClient } from "@/browser/contexts/API";
import type {
  AgentDefinitionDescriptor,
  AgentDefinitionPackage,
} from "@/common/types/agentDefinition";
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
import { normalizeModeAiDefaults, type ModeAiDefaults } from "@/common/types/modeAiDefaults";
import { normalizeAgentAiDefaults, type AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import type {
  CoderInfo,
  CoderTemplate,
  CoderPreset,
  CoderWorkspace,
} from "@/common/orpc/schemas/coder";
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
  /** Initial mode AI defaults for config.getConfig (e.g., Settings → Modes section) */
  modeAiDefaults?: ModeAiDefaults;
  /** Initial unified AI defaults for agents (plan/exec/compact + subagents) */
  agentAiDefaults?: AgentAiDefaults;
  /** Agent definitions to expose via agents.list */
  agentDefinitions?: AgentDefinitionDescriptor[];
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
    {
      disabledServers?: string[];
      enabledServers?: string[];
      toolAllowlist?: Record<string, string[]>;
    }
  >;
  /** MCP test results - maps server name to tools list or error */
  mcpTestResults?: Map<
    string,
    { success: true; tools: string[] } | { success: false; error: string }
  >;
  /** Custom listBranches implementation (for testing non-git repos) */
  listBranches?: (input: {
    projectPath: string;
  }) => Promise<{ branches: string[]; recommendedTrunk: string | null }>;
  /** Custom runtimeAvailability response (for testing non-git repos) */
  runtimeAvailability?: {
    local: { available: true } | { available: false; reason: string };
    worktree: { available: true } | { available: false; reason: string };
    ssh: { available: true } | { available: false; reason: string };
    docker: { available: true } | { available: false; reason: string };
  };
  /** Custom gitInit implementation (for testing git init flow) */
  gitInit?: (input: {
    projectPath: string;
  }) => Promise<{ success: true } | { success: false; error: string }>;
  /** Idle compaction hours per project (null = disabled) */
  idleCompactionHours?: Map<string, number | null>;
  /** Override signing capabilities response */
  signingCapabilities?: {
    publicKey: string | null;
    githubUser: string | null;
    error: { message: string; hasEncryptedKey: boolean } | null;
  };
  /** Coder CLI availability info */
  coderInfo?: CoderInfo;
  /** Coder templates available for workspace creation */
  coderTemplates?: CoderTemplate[];
  /** Coder presets per template name */
  coderPresets?: Map<string, CoderPreset[]>;
  /** Existing Coder workspaces */
  coderWorkspaces?: CoderWorkspace[];
}

interface MockBackgroundProcess {
  id: string;
  pid: number;
  script: string;
  displayName?: string;
  startTime: number;
  status: "running" | "exited" | "killed" | "failed";
  exitCode?: number;
}

type MockMcpServers = Record<
  string,
  { command: string; disabled: boolean; toolAllowlist?: string[] }
>;

interface MockMcpOverrides {
  disabledServers?: string[];
  enabledServers?: string[];
  toolAllowlist?: Record<string, string[]>;
}

type MockMcpTestResult = { success: true; tools: string[] } | { success: false; error: string };

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
    projects = new Map<string, ProjectConfig>(),
    workspaces = [],
    onChat,
    executeBash,
    providersConfig = { anthropic: { apiKeySet: true, isConfigured: true } },
    providersList = [],
    onProjectRemove,
    backgroundProcesses = new Map<string, MockBackgroundProcess[]>(),
    sessionUsage = new Map<string, MockSessionUsage>(),
    workspaceStatsSnapshots = new Map<string, WorkspaceStatsSnapshot>(),
    statsTabVariant = "control",
    projectSecrets = new Map<string, Secret[]>(),
    mcpServers = new Map<string, MockMcpServers>(),
    mcpOverrides = new Map<string, MockMcpOverrides>(),
    mcpTestResults = new Map<string, MockMcpTestResult>(),
    taskSettings: initialTaskSettings,
    modeAiDefaults: initialModeAiDefaults,
    subagentAiDefaults: initialSubagentAiDefaults,
    agentAiDefaults: initialAgentAiDefaults,
    agentDefinitions: initialAgentDefinitions,
    listBranches: customListBranches,
    gitInit: customGitInit,
    runtimeAvailability: customRuntimeAvailability,
    signingCapabilities: customSigningCapabilities,
    coderInfo = { state: "unavailable" as const, reason: "missing" as const },
    coderTemplates = [],
    coderPresets = new Map<string, CoderPreset[]>(),
    coderWorkspaces = [],
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

  let createdWorkspaceCounter = 0;

  const agentDefinitions: AgentDefinitionDescriptor[] =
    initialAgentDefinitions ??
    ([
      {
        id: "plan",
        scope: "built-in",
        name: "Plan",
        description: "Create a plan before coding",
        uiSelectable: true,
        subagentRunnable: false,
        base: "plan",
      },
      {
        id: "exec",
        scope: "built-in",
        name: "Exec",
        description: "Implement changes in the repository",
        uiSelectable: true,
        subagentRunnable: true,
      },
      {
        id: "compact",
        scope: "built-in",
        name: "Compact",
        description: "History compaction (internal)",
        uiSelectable: false,
        subagentRunnable: false,
      },
      {
        id: "explore",
        scope: "built-in",
        name: "Explore",
        description: "Read-only repository exploration",
        uiSelectable: false,
        subagentRunnable: true,
        base: "exec",
      },
    ] satisfies AgentDefinitionDescriptor[]);

  let taskSettings = normalizeTaskSettings(initialTaskSettings ?? DEFAULT_TASK_SETTINGS);

  let agentAiDefaults = normalizeAgentAiDefaults(
    initialAgentAiDefaults ??
      ({
        ...(initialSubagentAiDefaults ?? {}),
        ...(initialModeAiDefaults ?? {}),
      } as const)
  );

  const deriveModeAiDefaults = () =>
    normalizeModeAiDefaults({
      plan: agentAiDefaults.plan,
      exec: agentAiDefaults.exec,
      compact: agentAiDefaults.compact,
    });

  const deriveSubagentAiDefaults = () => {
    const raw: Record<string, unknown> = {};
    for (const [agentId, entry] of Object.entries(agentAiDefaults)) {
      if (agentId === "plan" || agentId === "exec" || agentId === "compact") {
        continue;
      }
      raw[agentId] = entry;
    }
    return normalizeSubagentAiDefaults(raw);
  };

  let modeAiDefaults = deriveModeAiDefaults();
  let subagentAiDefaults = deriveSubagentAiDefaults();

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
      countTokens: () => Promise.resolve(0),
      countTokensBatch: (_input: { model: string; texts: string[] }) =>
        Promise.resolve(_input.texts.map(() => 0)),
      calculateStats: () => Promise.resolve(mockStats),
    },
    features: {
      getStatsTabState: () => Promise.resolve(getStatsTabState()),
      setStatsTabOverride: (input: { override: "default" | "on" | "off" }) => {
        statsTabOverride = input.override;
        return Promise.resolve(getStatsTabState());
      },
    },
    telemetry: {
      track: () => Promise.resolve(undefined),
      status: () => Promise.resolve({ enabled: true, explicit: false }),
    },
    splashScreens: {
      getViewedSplashScreens: () => Promise.resolve(["onboarding-wizard-v1"]),
      markSplashScreenViewed: () => Promise.resolve(undefined),
    },
    signing: {
      capabilities: () =>
        Promise.resolve(
          customSigningCapabilities ?? {
            publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKey",
            githubUser: "mockuser",
            error: null,
          }
        ),
      sign: () =>
        Promise.resolve({
          signature: "mockSignature==",
          publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKey",
          githubUser: "mockuser",
        }),
      clearIdentityCache: () => Promise.resolve({ success: true }),
    },
    server: {
      getLaunchProject: () => Promise.resolve(null),
      getSshHost: () => Promise.resolve(null),
      setSshHost: () => Promise.resolve(undefined),
    },
    config: {
      getConfig: () =>
        Promise.resolve({ taskSettings, agentAiDefaults, subagentAiDefaults, modeAiDefaults }),
      saveConfig: (input: {
        taskSettings: unknown;
        agentAiDefaults?: unknown;
        subagentAiDefaults?: unknown;
      }) => {
        taskSettings = normalizeTaskSettings(input.taskSettings);

        if (input.agentAiDefaults !== undefined) {
          agentAiDefaults = normalizeAgentAiDefaults(input.agentAiDefaults);
          modeAiDefaults = deriveModeAiDefaults();
          subagentAiDefaults = deriveSubagentAiDefaults();
        }

        if (input.subagentAiDefaults !== undefined) {
          subagentAiDefaults = normalizeSubagentAiDefaults(input.subagentAiDefaults);

          const nextAgentAiDefaults: Record<string, unknown> = { ...agentAiDefaults };
          for (const [agentType, entry] of Object.entries(subagentAiDefaults)) {
            nextAgentAiDefaults[agentType] = entry;
          }

          agentAiDefaults = normalizeAgentAiDefaults(nextAgentAiDefaults);
          modeAiDefaults = deriveModeAiDefaults();
        }

        return Promise.resolve(undefined);
      },
      updateAgentAiDefaults: (input: { agentAiDefaults: unknown }) => {
        agentAiDefaults = normalizeAgentAiDefaults(input.agentAiDefaults);
        modeAiDefaults = deriveModeAiDefaults();
        subagentAiDefaults = deriveSubagentAiDefaults();
        return Promise.resolve(undefined);
      },
      updateModeAiDefaults: (input: { modeAiDefaults: unknown }) => {
        modeAiDefaults = normalizeModeAiDefaults(input.modeAiDefaults);
        agentAiDefaults = normalizeAgentAiDefaults({ ...agentAiDefaults, ...modeAiDefaults });
        modeAiDefaults = deriveModeAiDefaults();
        subagentAiDefaults = deriveSubagentAiDefaults();
        return Promise.resolve(undefined);
      },
    },
    agents: {
      list: (_input: { workspaceId: string }) => Promise.resolve(agentDefinitions),
      get: (input: { workspaceId: string; agentId: string }) => {
        const descriptor =
          agentDefinitions.find((agent) => agent.id === input.agentId) ?? agentDefinitions[0];

        const agentPackage = {
          id: descriptor.id,
          scope: descriptor.scope,
          frontmatter: {
            name: descriptor.name,
            description: descriptor.description,
            base: descriptor.base,
            ui: { selectable: descriptor.uiSelectable },
            subagent: { runnable: descriptor.subagentRunnable },
            ai: descriptor.aiDefaults,
            tools: descriptor.tools,
          },
          body: "",
        } satisfies AgentDefinitionPackage;

        return Promise.resolve(agentPackage);
      },
    },
    providers: {
      list: () => Promise.resolve(providersList),
      getConfig: () => Promise.resolve(providersConfig),
      setProviderConfig: () => Promise.resolve({ success: true, data: undefined }),
      setModels: () => Promise.resolve({ success: true, data: undefined }),
    },
    general: {
      listDirectory: () => Promise.resolve({ entries: [], hasMore: false }),
      ping: (input: string) => Promise.resolve(`Pong: ${input}`),
      tick: async function* () {
        // No ticks in the mock, but keep the subscription open.
        yield* [];
        await new Promise<void>(() => undefined);
      },
    },
    projects: {
      list: () => Promise.resolve(Array.from(projects.entries())),
      create: () =>
        Promise.resolve({
          success: true,
          data: { projectConfig: { workspaces: [] }, normalizedPath: "/mock/project" },
        }),
      pickDirectory: () => Promise.resolve(null),
      listBranches: (input: { projectPath: string }) => {
        if (customListBranches) {
          return customListBranches(input);
        }
        return Promise.resolve({
          branches: ["main", "develop", "feature/new-feature"],
          recommendedTrunk: "main",
        });
      },
      runtimeAvailability: () =>
        Promise.resolve(
          customRuntimeAvailability ?? {
            local: { available: true },
            worktree: { available: true },
            ssh: { available: true },
            docker: { available: true },
          }
        ),
      gitInit: (input: { projectPath: string }) => {
        if (customGitInit) {
          return customGitInit(input);
        }
        return Promise.resolve({ success: true as const });
      },
      remove: (input: { projectPath: string }) => {
        if (onProjectRemove) {
          return Promise.resolve(onProjectRemove(input.projectPath));
        }
        return Promise.resolve({ success: true, data: undefined });
      },
      secrets: {
        get: (input: { projectPath: string }) =>
          Promise.resolve(projectSecrets.get(input.projectPath) ?? []),
        update: (input: { projectPath: string; secrets: Secret[] }) => {
          projectSecrets.set(input.projectPath, input.secrets);
          return Promise.resolve({ success: true, data: undefined });
        },
      },
      mcp: {
        list: (input: { projectPath: string }) =>
          Promise.resolve(mcpServers.get(input.projectPath) ?? {}),
        add: () => Promise.resolve({ success: true, data: undefined }),
        remove: () => Promise.resolve({ success: true, data: undefined }),
        test: (input: { projectPath: string; name?: string }) => {
          if (input.name && mcpTestResults.has(input.name)) {
            return Promise.resolve(mcpTestResults.get(input.name)!);
          }
          // Default: return empty tools
          return Promise.resolve({ success: true, tools: [] });
        },
        setEnabled: () => Promise.resolve({ success: true, data: undefined }),
        setToolAllowlist: () => Promise.resolve({ success: true, data: undefined }),
      },
      idleCompaction: {
        get: (input: { projectPath: string }) =>
          Promise.resolve({ hours: options.idleCompactionHours?.get(input.projectPath) ?? null }),
        set: (input: { projectPath: string; hours: number | null }) => {
          if (options.idleCompactionHours) {
            options.idleCompactionHours.set(input.projectPath, input.hours);
          }
          return Promise.resolve({ success: true, data: undefined });
        },
      },
    },
    workspace: {
      list: (input?: { archived?: boolean }) => {
        if (input?.archived) {
          return Promise.resolve(
            workspaces.filter((w) => isWorkspaceArchived(w.archivedAt, w.unarchivedAt))
          );
        }
        return Promise.resolve(
          workspaces.filter((w) => !isWorkspaceArchived(w.archivedAt, w.unarchivedAt))
        );
      },
      archive: () => Promise.resolve({ success: true }),
      unarchive: () => Promise.resolve({ success: true }),
      create: (input: { projectPath: string; branchName: string }) => {
        createdWorkspaceCounter += 1;

        return Promise.resolve({
          success: true,
          metadata: {
            id: `ws-created-${createdWorkspaceCounter}`,
            name: input.branchName,
            projectPath: input.projectPath,
            projectName: input.projectPath.split("/").pop() ?? "project",
            namedWorkspacePath: `/mock/workspace/${input.branchName}`,
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
          },
        });
      },
      remove: () => Promise.resolve({ success: true }),
      rename: (input: { workspaceId: string }) =>
        Promise.resolve({
          success: true,
          data: { newWorkspaceId: input.workspaceId },
        }),
      fork: () => Promise.resolve({ success: false, error: "Not implemented in mock" }),
      sendMessage: () => Promise.resolve({ success: true, data: undefined }),
      resumeStream: () => Promise.resolve({ success: true, data: undefined }),
      interruptStream: () => Promise.resolve({ success: true, data: undefined }),
      clearQueue: () => Promise.resolve({ success: true, data: undefined }),
      truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
      replaceChatHistory: () => Promise.resolve({ success: true, data: undefined }),
      getInfo: (input: { workspaceId: string }) =>
        Promise.resolve(workspaceMap.get(input.workspaceId) ?? null),
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
      onChat: async function* (input: { workspaceId: string }, options?: { signal?: AbortSignal }) {
        if (!onChat) {
          // Default mock behavior: subscriptions should remain open.
          // If this ends, WorkspaceStore will retry and reset state, which flakes stories.
          const caughtUp: WorkspaceChatMessage = { type: "caught-up" };
          yield caughtUp;

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
        // No metadata updates in the mock, but keep the subscription open.
        yield* [];
        await new Promise<void>(() => undefined);
      },
      activity: {
        list: () => Promise.resolve({}),
        subscribe: async function* () {
          yield* [];
          await new Promise<void>(() => undefined);
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
          await new Promise<void>(() => undefined);
        },
        terminate: () => Promise.resolve({ success: true, data: undefined }),
        sendToBackground: () => Promise.resolve({ success: true, data: undefined }),
      },
      stats: {
        subscribe: async function* (input: { workspaceId: string }) {
          const snapshot = workspaceStatsSnapshots.get(input.workspaceId);
          if (snapshot) {
            yield snapshot;
          }
          await new Promise<void>(() => undefined);
        },
        clear: (input: { workspaceId: string }) => {
          workspaceStatsSnapshots.delete(input.workspaceId);
          return Promise.resolve({ success: true, data: undefined });
        },
      },
      getSessionUsage: (input: { workspaceId: string }) =>
        Promise.resolve(sessionUsage.get(input.workspaceId)),
      getSessionUsageBatch: (input: { workspaceIds: string[] }) => {
        const result: Record<string, MockSessionUsage | undefined> = {};
        for (const id of input.workspaceIds) {
          result[id] = sessionUsage.get(id);
        }
        return Promise.resolve(result);
      },
      mcp: {
        get: (input: { workspaceId: string }) =>
          Promise.resolve(mcpOverrides.get(input.workspaceId) ?? {}),
        set: () => Promise.resolve({ success: true, data: undefined }),
      },
      getFileCompletions: (input: { workspaceId: string; query: string; limit?: number }) => {
        // Mock file paths for storybook - simulate typical project structure
        const mockPaths = [
          "src/browser/components/ChatInput/index.tsx",
          "src/browser/components/CommandSuggestions.tsx",
          "src/browser/components/App.tsx",
          "src/browser/hooks/usePersistedState.ts",
          "src/browser/contexts/WorkspaceContext.tsx",
          "src/common/utils/atMentions.ts",
          "src/common/orpc/types.ts",
          "src/node/services/workspaceService.ts",
          "package.json",
          "tsconfig.json",
          "README.md",
        ];
        const query = input.query.toLowerCase();
        const filtered = mockPaths.filter((p) => p.toLowerCase().includes(query));
        return Promise.resolve({ paths: filtered.slice(0, input.limit ?? 20) });
      },
    },
    window: {
      setTitle: () => Promise.resolve(undefined),
    },
    coder: {
      getInfo: () => Promise.resolve(coderInfo),
      listTemplates: () => Promise.resolve(coderTemplates),
      listPresets: (input: { template: string }) =>
        Promise.resolve(coderPresets.get(input.template) ?? []),
      listWorkspaces: () => Promise.resolve(coderWorkspaces),
    },
    nameGeneration: {
      generate: () =>
        Promise.resolve({
          success: true,
          data: { name: "generated-workspace", title: "Generated Workspace", modelUsed: "mock" },
        }),
    },
    terminal: {
      listSessions: (_input: { workspaceId: string }) => Promise.resolve([]),
      create: () =>
        Promise.resolve({
          sessionId: "mock-session",
          workspaceId: "mock-workspace",
          cols: 80,
          rows: 24,
        }),
      close: () => Promise.resolve(undefined),
      resize: () => Promise.resolve(undefined),
      sendInput: () => undefined,
      attach: async function* (_input: { sessionId: string }) {
        yield { type: "screenState", data: "" };
        yield* [];
        await new Promise<void>(() => undefined);
      },
      onExit: async function* () {
        yield* [];
        await new Promise<void>(() => undefined);
      },
      openWindow: () => Promise.resolve(undefined),
      closeWindow: () => Promise.resolve(undefined),
      openNative: () => Promise.resolve(undefined),
    },
    update: {
      check: () => Promise.resolve(undefined),
      download: () => Promise.resolve(undefined),
      install: () => Promise.resolve(undefined),
      onStatus: async function* () {
        yield* [];
        await new Promise<void>(() => undefined);
      },
    },
  } as unknown as APIClient;
}
