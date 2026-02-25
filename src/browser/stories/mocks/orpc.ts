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
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/node/config";
import {
  DEFAULT_LAYOUT_PRESETS_CONFIG,
  normalizeLayoutPresetsConfig,
  type LayoutPresetsConfig,
} from "@/common/types/uiLayouts";
import type {
  WorkspaceChatMessage,
  ProvidersConfigMap,
  WorkspaceStatsSnapshot,
  ServerAuthSession,
} from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import type { NameGenerationError } from "@/common/types/errors";
import type { Secret } from "@/common/types/secrets";
import type { MCPHttpServerInfo, MCPServerInfo } from "@/common/types/mcp";
import type { MCPOAuthAuthStatus } from "@/common/types/mcpOauth";
import type { ChatStats } from "@/common/types/chatStats";
import {
  MUX_HELP_CHAT_AGENT_ID,
  MUX_HELP_CHAT_WORKSPACE_ID,
  MUX_HELP_CHAT_WORKSPACE_NAME,
  MUX_HELP_CHAT_WORKSPACE_TITLE,
} from "@/common/constants/muxChat";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getWorkspaceLastReadKey } from "@/common/constants/storage";
import {
  normalizeRuntimeEnablement,
  RUNTIME_ENABLEMENT_IDS,
  type RuntimeEnablementId,
} from "@/common/types/runtime";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import {
  DEFAULT_TASK_SETTINGS,
  normalizeSubagentAiDefaults,
  normalizeTaskSettings,
  type SubagentAiDefaults,
  type TaskSettings,
} from "@/common/types/tasks";
import { normalizeAgentAiDefaults, type AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import type {
  CoderInfo,
  CoderListPresetsResult,
  CoderListTemplatesResult,
  CoderListWorkspacesResult,
  CoderPreset,
  CoderTemplate,
  CoderWorkspace,
} from "@/common/orpc/schemas/coder";
import type { z } from "zod";
import type { ProjectRemoveErrorSchema } from "@/common/orpc/schemas/errors";
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

export interface MockTerminalSession {
  sessionId: string;
  workspaceId: string;
  cols: number;
  rows: number;
  /** Initial snapshot returned by terminal.attach ({ type: "screenState" }). */
  screenState: string;
  /** Optional live output chunks yielded after screenState ({ type: "output" }). */
  outputChunks?: string[];
}

type ProjectRemoveError = z.infer<typeof ProjectRemoveErrorSchema>;

export interface MockORPCClientOptions {
  /** Layout presets config for Settings → Layouts stories */
  layoutPresets?: LayoutPresetsConfig;
  projects?: Map<string, ProjectConfig>;
  workspaces?: FrontendWorkspaceMetadata[];
  /** Initial task settings for config.getConfig (e.g., Settings → Tasks section) */
  taskSettings?: Partial<TaskSettings>;
  /** Initial unified AI defaults for agents (plan/exec/compact + subagents) */
  agentAiDefaults?: AgentAiDefaults;
  /** Agent definitions to expose via agents.list */
  agentDefinitions?: AgentDefinitionDescriptor[];
  /** Initial per-subagent AI defaults for config.getConfig (e.g., Settings → Tasks section) */
  subagentAiDefaults?: SubagentAiDefaults;
  /** Coder lifecycle preferences for config.getConfig (e.g., Settings → Coder section) */
  stopCoderWorkspaceOnArchive?: boolean;
  /** Initial runtime enablement for config.getConfig */
  runtimeEnablement?: Record<string, boolean>;
  /** Initial default runtime for config.getConfig (global) */
  defaultRuntime?: RuntimeEnablementId | null;
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
  /** Server auth sessions for Settings → Server Access stories */
  serverAuthSessions?: ServerAuthSession[];
  /** Mock for projects.remove - return typed error to simulate failure */
  onProjectRemove?: (
    projectPath: string
  ) => { success: true; data: undefined } | { success: false; error: ProjectRemoveError };
  /** Override for nameGeneration.generate result (default: success) */
  nameGenerationResult?: { success: false; error: NameGenerationError };
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
  /** Global secrets (Settings → Secrets → Global) */
  globalSecrets?: Secret[];
  /** Project secrets per project */
  projectSecrets?: Map<string, Secret[]>;
  /** Terminal sessions to expose via terminal.listSessions + terminal.attach */
  terminalSessions?: MockTerminalSession[];
  sessionUsage?: Map<string, MockSessionUsage>;
  /** Debug snapshot per workspace for the last LLM request modal */
  lastLlmRequestSnapshots?: Map<string, DebugLlmRequestSnapshot | null>;
  /** Mock transcripts for workspace.getSubagentTranscript (taskId -> persisted transcript response). */
  subagentTranscripts?: Map<
    string,
    { messages: MuxMessage[]; model?: string; thinkingLevel?: ThinkingLevel }
  >;
  /** Global MCP server configuration (Settings → MCP) */
  globalMcpServers?: Record<string, MCPServerInfo>;
  /** MCP server configuration per project */
  mcpServers?: Map<string, Record<string, MCPServerInfo>>;
  /** Optional OAuth auth status per MCP server URL (serverUrl -> status) */
  mcpOauthAuthStatus?: Map<string, MCPOAuthAuthStatus>;
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
    devcontainer:
      | { available: true; configs: Array<{ path: string; label: string }>; cliVersion?: string }
      | { available: false; reason: string };
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
  /** Override Coder template list result (including error states) */
  coderTemplatesResult?: CoderListTemplatesResult;
  /** Override Coder preset list result per template (including error states) */
  coderPresetsResult?: Map<string, CoderListPresetsResult>;
  /** Override Coder workspace list result (including error states) */
  coderWorkspacesResult?: CoderListWorkspacesResult;
  /** Available agent skills (descriptors) */
  agentSkills?: AgentSkillDescriptor[];
  /** Agent skills that were discovered but couldn't be loaded (SKILL.md parse errors, etc.) */
  invalidAgentSkills?: AgentSkillIssue[];
  /** Mux Governor URL (null = not enrolled) */
  muxGovernorUrl?: string | null;
  /** Whether enrolled with Mux Governor */
  muxGovernorEnrolled?: boolean;
  /** Policy response for policy.get */
  policyResponse?: {
    source: "none" | "env" | "governor";
    status: { state: "disabled" | "enforced" | "blocked"; reason?: string };
    policy: unknown;
  };
  /** Mock log entries for Output tab (subscribeLogs snapshot) */
  logEntries?: Array<{
    timestamp: number;
    level: "error" | "warn" | "info" | "debug";
    message: string;
    location: string;
  }>;
  /** Mock clearLogs result (default: { success: true, error: null }) */
  clearLogsResult?: { success: boolean; error?: string | null };
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

type MockMcpServers = Record<string, MCPServerInfo>;

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
    projects: providedProjects = new Map<string, ProjectConfig>(),
    workspaces: inputWorkspaces = [],
    onChat,
    executeBash,
    providersConfig = { anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true } },
    providersList = [],
    serverAuthSessions: initialServerAuthSessions = [],
    onProjectRemove,
    nameGenerationResult,
    backgroundProcesses = new Map<string, MockBackgroundProcess[]>(),
    sessionUsage = new Map<string, MockSessionUsage>(),
    lastLlmRequestSnapshots = new Map<string, DebugLlmRequestSnapshot | null>(),
    subagentTranscripts = new Map<
      string,
      { messages: MuxMessage[]; model?: string; thinkingLevel?: ThinkingLevel }
    >(),
    workspaceStatsSnapshots = new Map<string, WorkspaceStatsSnapshot>(),
    statsTabVariant = "control",
    globalSecrets = [],
    projectSecrets = new Map<string, Secret[]>(),
    terminalSessions: initialTerminalSessions = [],
    globalMcpServers = {},
    mcpServers = new Map<string, MockMcpServers>(),
    mcpOverrides = new Map<string, MockMcpOverrides>(),
    mcpTestResults = new Map<string, MockMcpTestResult>(),
    mcpOauthAuthStatus = new Map<string, MCPOAuthAuthStatus>(),
    taskSettings: initialTaskSettings,
    subagentAiDefaults: initialSubagentAiDefaults,
    agentAiDefaults: initialAgentAiDefaults,
    stopCoderWorkspaceOnArchive: initialStopCoderWorkspaceOnArchive = true,
    runtimeEnablement: initialRuntimeEnablement,
    defaultRuntime: initialDefaultRuntime,
    agentDefinitions: initialAgentDefinitions,
    listBranches: customListBranches,
    gitInit: customGitInit,
    runtimeAvailability: customRuntimeAvailability,
    signingCapabilities: customSigningCapabilities,
    coderInfo = { state: "unavailable" as const, reason: "missing" as const },
    coderTemplates = [],
    coderPresets = new Map<string, CoderPreset[]>(),
    coderWorkspaces = [],
    coderTemplatesResult,
    coderPresetsResult = new Map<string, CoderListPresetsResult>(),
    coderWorkspacesResult,
    layoutPresets: initialLayoutPresets,
    agentSkills = [],
    invalidAgentSkills = [],
    muxGovernorUrl = null,
    muxGovernorEnrolled = false,
    policyResponse = {
      source: "none" as const,
      status: { state: "disabled" as const },
      policy: null,
    },
    logEntries = [],
    clearLogsResult = { success: true, error: null },
  } = options;

  // Feature flags
  let statsTabOverride: "default" | "on" | "off" = "default";

  const getStatsTabState = () => {
    // Stats tab is default-on; keep override as a local kill switch.
    const enabled = statsTabOverride !== "off";

    return { enabled, variant: statsTabVariant, override: statsTabOverride } as const;
  };

  // App now boots into the built-in mux-chat workspace by default.
  // Ensure Storybook mocks always include it so stories don't render "Workspace not found".
  const muxChatProjectPath = "/Users/dev/.mux/system/chat-with-mux";
  const muxChatWorkspace: FrontendWorkspaceMetadata = {
    id: MUX_HELP_CHAT_WORKSPACE_ID,
    name: MUX_HELP_CHAT_WORKSPACE_NAME,
    title: MUX_HELP_CHAT_WORKSPACE_TITLE,
    projectName: "Mux",
    projectPath: muxChatProjectPath,
    namedWorkspacePath: muxChatProjectPath,
    runtimeConfig: { type: "local" },
    agentId: MUX_HELP_CHAT_AGENT_ID,
  };

  const workspaces = inputWorkspaces.some((w) => w.id === MUX_HELP_CHAT_WORKSPACE_ID)
    ? inputWorkspaces
    : [muxChatWorkspace, ...inputWorkspaces];

  // Keep Storybook aligned with app behavior: the built-in Mux chat workspace belongs to a
  // system project so user-facing project lists can hide it while still rendering sidebar affordances.
  const projects = new Map(providedProjects);
  const muxChatProject = projects.get(muxChatProjectPath);
  if (muxChatProject) {
    projects.set(muxChatProjectPath, { ...muxChatProject, projectKind: "system" });
  } else {
    projects.set(muxChatProjectPath, { workspaces: [], projectKind: "system" });
  }

  // Keep Storybook's built-in mux-help workspace behavior deterministic:
  // if stories haven't seeded a read baseline, treat it as "known but never read"
  // rather than "unknown workspace" so the unread badge can render when recency exists.
  const muxHelpLastReadKey = getWorkspaceLastReadKey(MUX_HELP_CHAT_WORKSPACE_ID);
  if (readPersistedState<number | null>(muxHelpLastReadKey, null) === null) {
    updatePersistedState(muxHelpLastReadKey, 0);
  }
  const workspaceMap = new Map(workspaces.map((w) => [w.id, w]));

  // Terminal sessions are used by RightSidebar and TerminalView.
  // Stories can seed deterministic sessions (with screenState) to make the embedded terminal look
  // data-rich, while still keeping the default mock (no sessions) lightweight.
  const terminalSessionsById = new Map<string, MockTerminalSession>();
  const terminalSessionIdsByWorkspace = new Map<string, string[]>();

  const registerTerminalSession = (session: MockTerminalSession) => {
    terminalSessionsById.set(session.sessionId, session);
    const existing = terminalSessionIdsByWorkspace.get(session.workspaceId) ?? [];
    if (!existing.includes(session.sessionId)) {
      terminalSessionIdsByWorkspace.set(session.workspaceId, [...existing, session.sessionId]);
    }
  };

  for (const session of initialTerminalSessions) {
    registerTerminalSession(session);
  }

  let terminalSessionCounter = initialTerminalSessions.reduce((max, session) => {
    const match = /^mock-terminal-(\d+)$/.exec(session.sessionId);
    if (!match) {
      return max;
    }
    const parsed = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  const allocTerminalSessionId = () => {
    let nextSessionId = "";
    do {
      terminalSessionCounter += 1;
      nextSessionId = `mock-terminal-${terminalSessionCounter}`;
    } while (terminalSessionsById.has(nextSessionId));
    return nextSessionId;
  };

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
        uiColor: "var(--color-plan-mode)",
      },
      {
        id: "exec",
        scope: "built-in",
        name: "Exec",
        description: "Implement changes in the repository",
        uiSelectable: true,
        subagentRunnable: true,
        uiColor: "var(--color-exec-mode)",
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
      {
        id: "mux",
        scope: "built-in",
        name: "Mux",
        description: "Configure mux global behavior (system workspace)",
        uiSelectable: false,
        subagentRunnable: false,
      },
    ] satisfies AgentDefinitionDescriptor[]);

  let taskSettings = normalizeTaskSettings(initialTaskSettings ?? DEFAULT_TASK_SETTINGS);

  let agentAiDefaults = normalizeAgentAiDefaults(
    initialAgentAiDefaults ?? ({ ...(initialSubagentAiDefaults ?? {}) } as const)
  );

  let muxGatewayEnabled: boolean | undefined = undefined;
  let muxGatewayModels: string[] | undefined = undefined;
  let stopCoderWorkspaceOnArchive = initialStopCoderWorkspaceOnArchive;
  let runtimeEnablement: Record<string, boolean> = initialRuntimeEnablement ?? {
    local: true,
    worktree: true,
    ssh: true,
    coder: true,
    docker: true,
    devcontainer: true,
  };

  let defaultRuntime: RuntimeEnablementId | null = initialDefaultRuntime ?? null;
  let globalSecretsState: Secret[] = [...globalSecrets];
  const globalMcpServersState: MockMcpServers = { ...globalMcpServers };

  let serverAuthSessionsState: ServerAuthSession[] = initialServerAuthSessions.map((session) => ({
    ...session,
  }));

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

  let layoutPresets = initialLayoutPresets ?? DEFAULT_LAYOUT_PRESETS_CONFIG;
  let subagentAiDefaults = deriveSubagentAiDefaults();

  const mockStats: ChatStats = {
    consumers: [],
    totalTokens: 0,
    model: "mock-model",
    tokenizerName: "mock-tokenizer",
    usageHistory: [],
  };

  // MCP OAuth mock state (used by Settings → MCP OAuth UI)
  let mcpOauthFlowCounter = 0;
  const mcpOauthFlows = new Map<
    string,
    { projectPath: string; serverName: string; pendingServerUrl?: string }
  >();

  const getMcpServerUrl = (projectPath: string, serverName: string): string | undefined => {
    const server = mcpServers.get(projectPath)?.[serverName] ?? globalMcpServersState[serverName];
    if (!server || server.transport === "stdio") {
      return undefined;
    }
    return server.url;
  };

  const getMcpOauthStatus = (projectPath: string, serverName: string): MCPOAuthAuthStatus => {
    const serverUrl = getMcpServerUrl(projectPath, serverName);
    const status = serverUrl ? mcpOauthAuthStatus.get(serverUrl) : undefined;

    if (status) {
      return {
        ...status,
        // Prefer the stored serverUrl, but fall back to current config (helps stories stay minimal).
        serverUrl: status.serverUrl ?? serverUrl,
      };
    }

    return {
      serverUrl,
      isLoggedIn: false,
      hasRefreshToken: false,
    };
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
    serverAuth: {
      listSessions: () =>
        Promise.resolve(
          [...serverAuthSessionsState]
            .map((session) => ({ ...session }))
            .sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs)
        ),
      revokeSession: (input: { sessionId: string }) => {
        const beforeCount = serverAuthSessionsState.length;
        serverAuthSessionsState = serverAuthSessionsState.filter(
          (session) => session.id !== input.sessionId
        );

        return Promise.resolve({ removed: serverAuthSessionsState.length < beforeCount });
      },
      revokeOtherSessions: () => {
        const currentSession = serverAuthSessionsState.find((session) => session.isCurrent);
        const beforeCount = serverAuthSessionsState.length;

        if (!currentSession) {
          return Promise.resolve({ revokedCount: 0 });
        }

        serverAuthSessionsState = serverAuthSessionsState.filter(
          (session) => session.id === currentSession.id
        );

        return Promise.resolve({ revokedCount: beforeCount - serverAuthSessionsState.length });
      },
    },
    // Settings → Layouts (layout presets)
    // Stored in-memory for Storybook only.
    // Frontend code normalizes the response defensively, but we normalize here too so
    // stories remain stable even if they mutate the config.
    uiLayouts: {
      getAll: () => Promise.resolve(layoutPresets),
      saveAll: (input: { layoutPresets: unknown }) => {
        layoutPresets = normalizeLayoutPresetsConfig(input.layoutPresets);
        return Promise.resolve(undefined);
      },
    },
    config: {
      getConfig: () =>
        Promise.resolve({
          taskSettings,
          muxGatewayEnabled,
          muxGatewayModels,
          stopCoderWorkspaceOnArchive,
          runtimeEnablement,
          defaultRuntime,
          agentAiDefaults,
          subagentAiDefaults,
          muxGovernorUrl,
          muxGovernorEnrolled,
        }),
      saveConfig: (input: {
        taskSettings: unknown;
        agentAiDefaults?: unknown;
        subagentAiDefaults?: unknown;
      }) => {
        taskSettings = normalizeTaskSettings(input.taskSettings);

        if (input.agentAiDefaults !== undefined) {
          agentAiDefaults = normalizeAgentAiDefaults(input.agentAiDefaults);
          subagentAiDefaults = deriveSubagentAiDefaults();
        }

        if (input.subagentAiDefaults !== undefined) {
          subagentAiDefaults = normalizeSubagentAiDefaults(input.subagentAiDefaults);

          const nextAgentAiDefaults: Record<string, unknown> = { ...agentAiDefaults };
          for (const [agentType, entry] of Object.entries(subagentAiDefaults)) {
            nextAgentAiDefaults[agentType] = entry;
          }

          agentAiDefaults = normalizeAgentAiDefaults(nextAgentAiDefaults);
        }

        return Promise.resolve(undefined);
      },
      updateAgentAiDefaults: (input: { agentAiDefaults: unknown }) => {
        agentAiDefaults = normalizeAgentAiDefaults(input.agentAiDefaults);
        subagentAiDefaults = deriveSubagentAiDefaults();
        return Promise.resolve(undefined);
      },
      updateMuxGatewayPrefs: (input: {
        muxGatewayEnabled: boolean;
        muxGatewayModels: string[];
      }) => {
        muxGatewayEnabled = input.muxGatewayEnabled ? undefined : false;
        muxGatewayModels = input.muxGatewayModels.length > 0 ? input.muxGatewayModels : undefined;
        return Promise.resolve(undefined);
      },
      updateCoderPrefs: (input: { stopCoderWorkspaceOnArchive: boolean }) => {
        stopCoderWorkspaceOnArchive = input.stopCoderWorkspaceOnArchive;
        return Promise.resolve(undefined);
      },
      updateRuntimeEnablement: (input: {
        projectPath?: string | null;
        runtimeEnablement?: Record<string, boolean> | null;
        defaultRuntime?: RuntimeEnablementId | null;
        runtimeOverridesEnabled?: boolean | null;
      }) => {
        const shouldUpdateRuntimeEnablement = input.runtimeEnablement !== undefined;
        const shouldUpdateDefaultRuntime = input.defaultRuntime !== undefined;
        const shouldUpdateOverridesEnabled = input.runtimeOverridesEnabled !== undefined;
        const projectPath = input.projectPath?.trim();

        const runtimeEnablementOverrides =
          input.runtimeEnablement == null
            ? undefined
            : (() => {
                const normalized = normalizeRuntimeEnablement(input.runtimeEnablement);
                const disabled: Partial<Record<RuntimeEnablementId, false>> = {};

                for (const runtimeId of RUNTIME_ENABLEMENT_IDS) {
                  if (!normalized[runtimeId]) {
                    disabled[runtimeId] = false;
                  }
                }

                return Object.keys(disabled).length > 0 ? disabled : undefined;
              })();

        const runtimeOverridesEnabled = input.runtimeOverridesEnabled === true ? true : undefined;

        if (projectPath) {
          const project = projects.get(projectPath);
          if (project) {
            const nextProject = { ...project };
            if (shouldUpdateRuntimeEnablement) {
              if (runtimeEnablementOverrides) {
                nextProject.runtimeEnablement = runtimeEnablementOverrides;
              } else {
                delete nextProject.runtimeEnablement;
              }
            }

            if (shouldUpdateDefaultRuntime) {
              if (input.defaultRuntime !== null && input.defaultRuntime !== undefined) {
                nextProject.defaultRuntime = input.defaultRuntime;
              } else {
                delete nextProject.defaultRuntime;
              }
            }

            if (shouldUpdateOverridesEnabled) {
              if (runtimeOverridesEnabled) {
                nextProject.runtimeOverridesEnabled = true;
              } else {
                delete nextProject.runtimeOverridesEnabled;
              }
            }
            projects.set(projectPath, nextProject);
          }

          return Promise.resolve(undefined);
        }

        if (shouldUpdateRuntimeEnablement) {
          if (input.runtimeEnablement == null) {
            runtimeEnablement = normalizeRuntimeEnablement({});
          } else {
            runtimeEnablement = normalizeRuntimeEnablement(input.runtimeEnablement);
          }
        }

        if (shouldUpdateDefaultRuntime) {
          defaultRuntime = input.defaultRuntime ?? null;
        }

        return Promise.resolve(undefined);
      },
      unenrollMuxGovernor: () => Promise.resolve(undefined),
    },
    agents: {
      list: (_input: {
        projectPath?: string;
        workspaceId?: string;
        disableWorkspaceAgents?: boolean;
        includeDisabled?: boolean;
      }) => Promise.resolve(agentDefinitions),
      get: (input: {
        projectPath?: string;
        workspaceId?: string;
        disableWorkspaceAgents?: boolean;
        includeDisabled?: boolean;
        agentId: string;
      }) => {
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
    agentSkills: {
      list: () => Promise.resolve(agentSkills),
      listDiagnostics: () =>
        Promise.resolve({ skills: agentSkills, invalidSkills: invalidAgentSkills }),
      get: () =>
        Promise.resolve({
          scope: "built-in" as const,
          directoryName: "mock-skill",
          frontmatter: { name: "mock-skill", description: "Mock skill" },
          body: "",
        }),
    },
    providers: {
      list: () => Promise.resolve(providersList),
      getConfig: () => Promise.resolve(providersConfig),
      setProviderConfig: () => Promise.resolve({ success: true, data: undefined }),
      setModels: () => Promise.resolve({ success: true, data: undefined }),
    },
    muxGateway: {
      getAccountStatus: () =>
        Promise.resolve({
          success: true,
          data: {
            remaining_microdollars: 134_598_127,
            ai_gateway_concurrent_requests_per_user: 20,
          },
        }),
    },
    general: {
      listDirectory: () => Promise.resolve({ entries: [], hasMore: false }),
      ping: (input: string) => Promise.resolve(`Pong: ${input}`),
      tick: async function* () {
        // No ticks in the mock, but keep the subscription open.
        yield* [];
        await new Promise<void>(() => undefined);
      },
      subscribeLogs: async function* (input: { level?: string | null }) {
        const LOG_LEVEL_PRIORITY: Record<string, number> = {
          error: 0,
          warn: 1,
          info: 2,
          debug: 3,
        };
        const minPriority = input.level != null ? (LOG_LEVEL_PRIORITY[input.level] ?? 3) : 3;
        const filtered = logEntries.filter(
          (entry) => (LOG_LEVEL_PRIORITY[entry.level] ?? 3) <= minPriority
        );
        yield { type: "snapshot" as const, epoch: 1, entries: filtered };
        await new Promise<void>(() => undefined);
      },
      clearLogs: () => Promise.resolve(clearLogsResult),
    },
    secrets: {
      get: (input?: { projectPath?: string }) => {
        const projectPath = typeof input?.projectPath === "string" ? input.projectPath.trim() : "";
        if (projectPath) {
          return Promise.resolve(projectSecrets.get(projectPath) ?? []);
        }

        return Promise.resolve(globalSecretsState);
      },
      update: (input: { projectPath?: string; secrets: Secret[] }) => {
        const projectPath = typeof input.projectPath === "string" ? input.projectPath.trim() : "";

        if (projectPath) {
          projectSecrets.set(projectPath, input.secrets);
        } else {
          globalSecretsState = input.secrets;
        }

        return Promise.resolve({ success: true, data: undefined });
      },
    },
    mcp: {
      list: (input?: { projectPath?: string }) => {
        const projectPath = typeof input?.projectPath === "string" ? input.projectPath.trim() : "";
        if (projectPath) {
          return Promise.resolve(mcpServers.get(projectPath) ?? globalMcpServersState);
        }

        return Promise.resolve(globalMcpServersState);
      },
      add: (input: {
        name: string;
        transport?: "stdio" | "http" | "sse" | "auto";
        command?: string;
        url?: string;
        headers?: MCPHttpServerInfo["headers"];
      }) => {
        const transport = input.transport ?? "stdio";

        if (transport === "stdio") {
          globalMcpServersState[input.name] = {
            transport: "stdio",
            command: input.command ?? "",
            disabled: false,
          };
        } else {
          globalMcpServersState[input.name] = {
            transport,
            url: input.url ?? "",
            headers: input.headers,
            disabled: false,
          };
        }

        return Promise.resolve({ success: true, data: undefined });
      },
      remove: (input: { name: string }) => {
        delete globalMcpServersState[input.name];
        return Promise.resolve({ success: true, data: undefined });
      },
      test: (input: { projectPath?: string; name?: string }) => {
        if (input.name && mcpTestResults.has(input.name)) {
          return Promise.resolve(mcpTestResults.get(input.name)!);
        }

        // Default: return empty tools.
        return Promise.resolve({ success: true, tools: [] });
      },
      setEnabled: (input: { name: string; enabled: boolean }) => {
        const server = globalMcpServersState[input.name];
        if (server) {
          const disabled = !input.enabled;
          if (server.transport === "stdio") {
            globalMcpServersState[input.name] = { ...server, disabled };
          } else {
            globalMcpServersState[input.name] = { ...server, disabled };
          }
        }
        return Promise.resolve({ success: true, data: undefined });
      },
      setToolAllowlist: (input: { name: string; toolAllowlist: string[] }) => {
        const server = globalMcpServersState[input.name];
        if (server) {
          if (server.transport === "stdio") {
            globalMcpServersState[input.name] = { ...server, toolAllowlist: input.toolAllowlist };
          } else {
            globalMcpServersState[input.name] = { ...server, toolAllowlist: input.toolAllowlist };
          }
        }
        return Promise.resolve({ success: true, data: undefined });
      },
    },
    mcpOauth: {
      getAuthStatus: (input: { serverUrl: string }) => {
        const status = mcpOauthAuthStatus.get(input.serverUrl);
        return Promise.resolve(
          status ?? {
            serverUrl: input.serverUrl,
            isLoggedIn: false,
            hasRefreshToken: false,
          }
        );
      },
      startDesktopFlow: (input: {
        projectPath?: string;
        serverName: string;
        pendingServer?: { transport: "http" | "sse" | "auto"; url: string };
      }) => {
        mcpOauthFlowCounter += 1;
        const flowId = `mock-mcp-oauth-flow-${mcpOauthFlowCounter}`;

        mcpOauthFlows.set(flowId, {
          projectPath: input.projectPath ?? "",
          serverName: input.serverName,
          pendingServerUrl: input.pendingServer?.url,
        });

        return Promise.resolve({
          success: true,
          data: {
            flowId,
            authorizeUrl: `https://example.com/oauth/authorize?flowId=${encodeURIComponent(flowId)}`,
            redirectUri: "mux://oauth/callback",
          },
        });
      },
      waitForDesktopFlow: (input: { flowId: string; timeoutMs?: number }) => {
        const flow = mcpOauthFlows.get(input.flowId);
        if (!flow) {
          return Promise.resolve({ success: false as const, error: "OAuth flow not found." });
        }

        mcpOauthFlows.delete(input.flowId);

        const serverUrl =
          flow.pendingServerUrl ?? getMcpServerUrl(flow.projectPath, flow.serverName);
        if (serverUrl) {
          mcpOauthAuthStatus.set(serverUrl, {
            serverUrl,
            isLoggedIn: true,
            hasRefreshToken: true,
            updatedAtMs: Date.now(),
          });
        }

        return Promise.resolve({ success: true as const, data: undefined });
      },
      cancelDesktopFlow: (input: { flowId: string }) => {
        mcpOauthFlows.delete(input.flowId);
        return Promise.resolve(undefined);
      },
      startServerFlow: (input: {
        projectPath?: string;
        serverName: string;
        pendingServer?: { transport: "http" | "sse" | "auto"; url: string };
      }) => {
        mcpOauthFlowCounter += 1;
        const flowId = `mock-mcp-oauth-flow-${mcpOauthFlowCounter}`;

        mcpOauthFlows.set(flowId, {
          projectPath: input.projectPath ?? "",
          serverName: input.serverName,
          pendingServerUrl: input.pendingServer?.url,
        });

        return Promise.resolve({
          success: true,
          data: {
            flowId,
            authorizeUrl: `https://example.com/oauth/authorize?flowId=${encodeURIComponent(flowId)}`,
            redirectUri: "mux://oauth/callback",
          },
        });
      },
      waitForServerFlow: (input: { flowId: string; timeoutMs?: number }) => {
        const flow = mcpOauthFlows.get(input.flowId);
        if (!flow) {
          return Promise.resolve({ success: false as const, error: "OAuth flow not found." });
        }

        mcpOauthFlows.delete(input.flowId);

        const serverUrl =
          flow.pendingServerUrl ?? getMcpServerUrl(flow.projectPath, flow.serverName);
        if (serverUrl) {
          mcpOauthAuthStatus.set(serverUrl, {
            serverUrl,
            isLoggedIn: true,
            hasRefreshToken: true,
            updatedAtMs: Date.now(),
          });
        }

        return Promise.resolve({ success: true as const, data: undefined });
      },
      cancelServerFlow: (input: { flowId: string }) => {
        mcpOauthFlows.delete(input.flowId);
        return Promise.resolve(undefined);
      },
      logout: (input: { serverUrl: string }) => {
        mcpOauthAuthStatus.set(input.serverUrl, {
          serverUrl: input.serverUrl,
          isLoggedIn: false,
          hasRefreshToken: false,
          updatedAtMs: Date.now(),
        });

        return Promise.resolve({ success: true as const, data: undefined });
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
      getDefaultProjectDir: () => Promise.resolve("~/.mux/projects"),
      setDefaultProjectDir: () => Promise.resolve(),
      clone: () =>
        Promise.resolve(
          (function* () {
            yield {
              type: "progress" as const,
              line: "Cloning into '/mock/cloned-project'...\n",
            };
            yield {
              type: "success" as const,
              projectConfig: { workspaces: [] },
              normalizedPath: "/mock/cloned-project",
            };
          })()
        ),
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
            devcontainer: { available: false, reason: "No devcontainer.json found" },
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
      mcpOauth: {
        getAuthStatus: (input: { projectPath: string; serverName: string }) =>
          Promise.resolve(getMcpOauthStatus(input.projectPath, input.serverName)),
        startDesktopFlow: (input: { projectPath: string; serverName: string }) => {
          mcpOauthFlowCounter += 1;
          const flowId = `mock-mcp-oauth-flow-${mcpOauthFlowCounter}`;

          mcpOauthFlows.set(flowId, {
            projectPath: input.projectPath,
            serverName: input.serverName,
          });

          return Promise.resolve({
            success: true,
            data: {
              flowId,
              authorizeUrl: `https://example.com/oauth/authorize?flowId=${encodeURIComponent(flowId)}`,
              redirectUri: "mux://oauth/callback",
            },
          });
        },
        waitForDesktopFlow: (input: { flowId: string; timeoutMs?: number }) => {
          const flow = mcpOauthFlows.get(input.flowId);
          if (!flow) {
            return Promise.resolve({ success: false as const, error: "OAuth flow not found." });
          }

          mcpOauthFlows.delete(input.flowId);

          const serverUrl = getMcpServerUrl(flow.projectPath, flow.serverName);
          if (serverUrl) {
            mcpOauthAuthStatus.set(serverUrl, {
              serverUrl,
              isLoggedIn: true,
              hasRefreshToken: true,
              updatedAtMs: Date.now(),
            });
          }

          return Promise.resolve({ success: true as const, data: undefined });
        },
        cancelDesktopFlow: (input: { flowId: string }) => {
          mcpOauthFlows.delete(input.flowId);
          return Promise.resolve(undefined);
        },
        logout: (input: { projectPath: string; serverName: string }) => {
          const serverUrl = getMcpServerUrl(input.projectPath, input.serverName);
          if (serverUrl) {
            mcpOauthAuthStatus.set(serverUrl, {
              serverUrl,
              isLoggedIn: false,
              hasRefreshToken: false,
              updatedAtMs: Date.now(),
            });
          }

          return Promise.resolve({ success: true as const, data: undefined });
        },
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
      updateAgentAISettings: () => Promise.resolve({ success: true, data: undefined }),
      updateModeAISettings: () => Promise.resolve({ success: true, data: undefined }),
      updateTitle: () => Promise.resolve({ success: true, data: undefined }),
      rename: (input: { workspaceId: string }) =>
        Promise.resolve({
          success: true,
          data: { newWorkspaceId: input.workspaceId },
        }),
      fork: () => Promise.resolve({ success: false, error: "Not implemented in mock" }),
      sendMessage: () => Promise.resolve({ success: true, data: undefined }),
      resumeStream: () => Promise.resolve({ success: true, data: { started: true } }),
      setAutoRetryEnabled: () =>
        Promise.resolve({
          success: true,
          data: { previousEnabled: true, enabled: true },
        }),
      getStartupAutoRetryModel: () => Promise.resolve({ success: true, data: null }),
      setAutoCompactionThreshold: () => Promise.resolve({ success: true, data: undefined }),
      interruptStream: () => Promise.resolve({ success: true, data: undefined }),
      clearQueue: () => Promise.resolve({ success: true, data: undefined }),
      truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
      replaceChatHistory: () => Promise.resolve({ success: true, data: undefined }),
      getInfo: (input: { workspaceId: string }) =>
        Promise.resolve(workspaceMap.get(input.workspaceId) ?? null),
      getLastLlmRequest: (input: { workspaceId: string }) =>
        Promise.resolve({
          success: true,
          data: lastLlmRequestSnapshots.get(input.workspaceId) ?? null,
        }),
      getSubagentTranscript: (input: { workspaceId?: string; taskId: string }) =>
        Promise.resolve(subagentTranscripts.get(input.taskId) ?? { messages: [] }),
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
          const caughtUp: WorkspaceChatMessage = { type: "caught-up", hasOlderHistory: false };
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
        getOutput: () =>
          Promise.resolve({
            success: true,
            data: { status: "running" as const, output: "", nextOffset: 0, truncatedStart: false },
          }),
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
      listTemplates: () =>
        Promise.resolve(coderTemplatesResult ?? { ok: true, templates: coderTemplates }),
      listPresets: (input: { template: string }) =>
        Promise.resolve(
          coderPresetsResult.get(input.template) ?? {
            ok: true,
            presets: coderPresets.get(input.template) ?? [],
          }
        ),
      listWorkspaces: () =>
        Promise.resolve(coderWorkspacesResult ?? { ok: true, workspaces: coderWorkspaces }),
    },
    nameGeneration: {
      generate: () => {
        if (nameGenerationResult) {
          return Promise.resolve(nameGenerationResult);
        }
        return Promise.resolve({
          success: true as const,
          data: { name: "generated-workspace", title: "Generated Workspace", modelUsed: "mock" },
        });
      },
    },
    terminal: {
      activity: {
        subscribe: async function* (_input?: void, opts?: { signal?: AbortSignal }) {
          yield { type: "snapshot" as const, workspaces: {} };
          await new Promise<void>((resolve) => {
            if (opts?.signal?.aborted) {
              resolve();
              return;
            }
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
      listSessions: (input: { workspaceId: string }) =>
        Promise.resolve(terminalSessionIdsByWorkspace.get(input.workspaceId) ?? []),
      create: (input: {
        workspaceId: string;
        cols: number;
        rows: number;
        initialCommand?: string;
      }) => {
        const sessionId = allocTerminalSessionId();
        registerTerminalSession({
          sessionId,
          workspaceId: input.workspaceId,
          cols: input.cols,
          rows: input.rows,
          // Leave the terminal visually empty by default; data-rich stories can override via
          // MockTerminalSession.screenState.
          screenState: "",
        });

        return Promise.resolve({
          sessionId,
          workspaceId: input.workspaceId,
          cols: input.cols,
          rows: input.rows,
        });
      },
      close: (input: { sessionId: string }) => {
        const session = terminalSessionsById.get(input.sessionId);
        if (session) {
          terminalSessionsById.delete(input.sessionId);
          const ids = terminalSessionIdsByWorkspace.get(session.workspaceId) ?? [];
          terminalSessionIdsByWorkspace.set(
            session.workspaceId,
            ids.filter((id) => id !== input.sessionId)
          );
        }
        return Promise.resolve(undefined);
      },
      resize: (input: { sessionId: string; cols: number; rows: number }) => {
        const session = terminalSessionsById.get(input.sessionId);
        if (session) {
          terminalSessionsById.set(input.sessionId, {
            ...session,
            cols: input.cols,
            rows: input.rows,
          });
        }
        return Promise.resolve(undefined);
      },
      sendInput: () => undefined,
      attach: async function* (input: { sessionId: string }, opts?: { signal?: AbortSignal }) {
        const session = terminalSessionsById.get(input.sessionId);
        yield { type: "screenState", data: session?.screenState ?? "" };

        for (const chunk of session?.outputChunks ?? []) {
          yield { type: "output", data: chunk };
        }

        // Keep the iterator alive until the caller aborts. The real backend streams output
        // indefinitely; Storybook uses abort to clean up on story change.
        if (opts?.signal) {
          if (opts.signal.aborted) {
            return;
          }
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }

        await new Promise<void>(() => undefined);
      },
      onExit: async function* (_input: { sessionId: string }, opts?: { signal?: AbortSignal }) {
        yield* [];
        if (opts?.signal) {
          if (opts.signal.aborted) {
            return;
          }
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }

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
      getChannel: () => Promise.resolve("stable" as const),
      setChannel: () => Promise.resolve(undefined),
    },
    policy: {
      get: () => Promise.resolve(policyResponse),
      onChanged: async function* () {
        yield* [];
        await new Promise<void>(() => undefined);
      },
      refreshNow: () => Promise.resolve({ success: true as const, value: policyResponse }),
    },
    muxGovernorOauth: {
      startDesktopFlow: () =>
        Promise.resolve({
          success: true as const,
          value: {
            flowId: "mock-flow-id",
            authorizeUrl: "https://governor.example.com/oauth/authorize",
            redirectUri: "http://localhost:12345/callback",
          },
        }),
      waitForDesktopFlow: () =>
        // Never resolves - user would complete in browser
        new Promise(() => undefined),
      cancelDesktopFlow: () => Promise.resolve(undefined),
    },
  } as unknown as APIClient;
}
