import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import {
  MUX_HELP_CHAT_AGENT_ID,
  MUX_HELP_CHAT_WORKSPACE_ID,
  MUX_HELP_CHAT_WORKSPACE_NAME,
  MUX_HELP_CHAT_WORKSPACE_TITLE,
} from "@/common/constants/muxChat";
import { getMuxHelpChatProjectPath } from "@/node/constants/muxChat";
import { createMuxMessage } from "@/common/types/message";
import { log } from "@/node/services/log";
import type { Config } from "@/node/config";
import { AIService } from "@/node/services/aiService";
import { HistoryService } from "@/node/services/historyService";
import { PartialService } from "@/node/services/partialService";
import { InitStateManager } from "@/node/services/initStateManager";
import { PTYService } from "@/node/services/ptyService";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import { ProjectService } from "@/node/services/projectService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { MuxGatewayOauthService } from "@/node/services/muxGatewayOauthService";
import { MuxGovernorOauthService } from "@/node/services/muxGovernorOauthService";
import { ProviderService } from "@/node/services/providerService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { TerminalService } from "@/node/services/terminalService";
import { EditorService } from "@/node/services/editorService";
import { WindowService } from "@/node/services/windowService";
import { UpdateService } from "@/node/services/updateService";
import { TokenizerService } from "@/node/services/tokenizerService";
import { ServerService } from "@/node/services/serverService";
import { MenuEventService } from "@/node/services/menuEventService";
import { VoiceService } from "@/node/services/voiceService";
import { TelemetryService } from "@/node/services/telemetryService";
import type {
  ReasoningDeltaEvent,
  StreamAbortEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "@/common/types/stream";
import { FeatureFlagService } from "@/node/services/featureFlagService";
import { SessionTimingService } from "@/node/services/sessionTimingService";
import { ExperimentsService } from "@/node/services/experimentsService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { MCPServerManager } from "@/node/services/mcpServerManager";
import { McpOauthService } from "@/node/services/mcpOauthService";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { IdleCompactionService } from "@/node/services/idleCompactionService";
import { TaskService } from "@/node/services/taskService";
import { getSigningService, type SigningService } from "@/node/services/signingService";
import { coderService, type CoderService } from "@/node/services/coderService";
import { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import {
  createStartCoderOnUnarchiveHook,
  createStopCoderOnArchiveHook,
} from "@/node/runtime/coderLifecycleHooks";
import { setGlobalCoderService } from "@/node/runtime/runtimeFactory";
import { PolicyService } from "@/node/services/policyService";

const MUX_HELP_CHAT_WELCOME_MESSAGE_ID = "mux-chat-welcome";
const MUX_HELP_CHAT_WELCOME_MESSAGE = `Hi, I'm Mux.

This is your built-in **Chat with Mux** workspace — a safe place to ask questions about Mux itself.

I can help you:
- Configure global agent behavior by editing **~/.mux/AGENTS.md** (I'll show a diff and ask before writing).
- Pick models/providers and explain Mux modes + tool policies.
- Troubleshoot common setup issues (keys, runtimes, workspaces, etc.).

Try asking:
- "What does AGENTS.md do?"
- "Help me write global instructions for code reviews"
- "How do I set up an OpenAI / Anthropic key in Mux?"
`;

/**
 * ServiceContainer - Central dependency container for all backend services.
 *
 * This class instantiates and wires together all services needed by the ORPC router.
 * Services are accessed via the ORPC context object.
 */
export class ServiceContainer {
  public readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  public readonly aiService: AIService;
  public readonly projectService: ProjectService;
  public readonly workspaceService: WorkspaceService;
  public readonly taskService: TaskService;
  public readonly providerService: ProviderService;
  public readonly muxGatewayOauthService: MuxGatewayOauthService;
  public readonly muxGovernorOauthService: MuxGovernorOauthService;
  public readonly terminalService: TerminalService;
  public readonly editorService: EditorService;
  public readonly windowService: WindowService;
  public readonly updateService: UpdateService;
  public readonly tokenizerService: TokenizerService;
  public readonly serverService: ServerService;
  public readonly menuEventService: MenuEventService;
  public readonly voiceService: VoiceService;
  public readonly mcpConfigService: MCPConfigService;
  public readonly mcpOauthService: McpOauthService;
  public readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  public readonly mcpServerManager: MCPServerManager;
  public readonly telemetryService: TelemetryService;
  public readonly featureFlagService: FeatureFlagService;
  public readonly sessionTimingService: SessionTimingService;
  public readonly experimentsService: ExperimentsService;
  public readonly sessionUsageService: SessionUsageService;
  public readonly signingService: SigningService;
  public readonly policyService: PolicyService;
  public readonly coderService: CoderService;
  private readonly initStateManager: InitStateManager;
  private readonly extensionMetadata: ExtensionMetadataService;
  private readonly ptyService: PTYService;
  private readonly backgroundProcessManager: BackgroundProcessManager;
  public readonly idleCompactionService: IdleCompactionService;

  constructor(config: Config) {
    this.config = config;
    this.historyService = new HistoryService(config);
    this.partialService = new PartialService(config, this.historyService);
    this.projectService = new ProjectService(config);
    this.initStateManager = new InitStateManager(config);
    this.workspaceMcpOverridesService = new WorkspaceMcpOverridesService(config);
    this.mcpConfigService = new MCPConfigService(config);
    this.extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    this.backgroundProcessManager = new BackgroundProcessManager(
      path.join(os.tmpdir(), "mux-bashes")
    );
    this.mcpServerManager = new MCPServerManager(this.mcpConfigService);
    this.sessionUsageService = new SessionUsageService(config, this.historyService);
    this.providerService = new ProviderService(config);
    this.aiService = new AIService(
      config,
      this.historyService,
      this.partialService,
      this.initStateManager,
      this.providerService,
      this.backgroundProcessManager,
      this.sessionUsageService,
      this.workspaceMcpOverridesService
    );
    this.aiService.setMCPServerManager(this.mcpServerManager);
    this.workspaceService = new WorkspaceService(
      config,
      this.historyService,
      this.partialService,
      this.aiService,
      this.initStateManager,
      this.extensionMetadata,
      this.backgroundProcessManager,
      this.sessionUsageService
    );
    this.workspaceService.setMCPServerManager(this.mcpServerManager);
    this.taskService = new TaskService(
      config,
      this.historyService,
      this.partialService,
      this.aiService,
      this.workspaceService,
      this.initStateManager
    );
    this.aiService.setTaskService(this.taskService);
    // Idle compaction service - auto-compacts workspaces after configured idle period
    this.idleCompactionService = new IdleCompactionService(
      config,
      this.historyService,
      this.extensionMetadata,
      (workspaceId) => this.workspaceService.emitIdleCompactionNeeded(workspaceId)
    );
    this.windowService = new WindowService();
    this.mcpOauthService = new McpOauthService(config, this.mcpConfigService, this.windowService);
    this.mcpServerManager.setMcpOauthService(this.mcpOauthService);

    this.policyService = new PolicyService(config);
    this.muxGatewayOauthService = new MuxGatewayOauthService(
      this.providerService,
      this.windowService
    );
    this.muxGovernorOauthService = new MuxGovernorOauthService(
      config,
      this.windowService,
      this.policyService
    );
    // Terminal services - PTYService is cross-platform
    this.ptyService = new PTYService();
    this.terminalService = new TerminalService(config, this.ptyService);
    // Wire terminal service to workspace service for cleanup on removal
    this.workspaceService.setTerminalService(this.terminalService);
    // Editor service for opening workspaces in code editors
    this.editorService = new EditorService(config);
    this.updateService = new UpdateService();
    this.tokenizerService = new TokenizerService(this.sessionUsageService);
    this.serverService = new ServerService();
    this.menuEventService = new MenuEventService();
    this.voiceService = new VoiceService(config);
    this.telemetryService = new TelemetryService(config.rootDir);
    this.mcpOauthService.setTelemetryService(this.telemetryService);
    this.aiService.setTelemetryService(this.telemetryService);
    this.workspaceService.setTelemetryService(this.telemetryService);
    this.experimentsService = new ExperimentsService({
      telemetryService: this.telemetryService,
      muxHome: config.rootDir,
    });
    this.featureFlagService = new FeatureFlagService(config, this.telemetryService);
    this.sessionTimingService = new SessionTimingService(config, this.telemetryService);
    this.workspaceService.setSessionTimingService(this.sessionTimingService);
    this.signingService = getSigningService();
    this.coderService = coderService;

    const workspaceLifecycleHooks = new WorkspaceLifecycleHooks();
    workspaceLifecycleHooks.registerBeforeArchive(
      createStopCoderOnArchiveHook({
        coderService: this.coderService,
        shouldStopOnArchive: () =>
          this.config.loadConfigOrDefault().stopCoderWorkspaceOnArchive !== false,
      })
    );
    workspaceLifecycleHooks.registerAfterUnarchive(
      createStartCoderOnUnarchiveHook({
        coderService: this.coderService,
        shouldStopOnArchive: () =>
          this.config.loadConfigOrDefault().stopCoderWorkspaceOnArchive !== false,
      })
    );
    this.workspaceService.setWorkspaceLifecycleHooks(workspaceLifecycleHooks);

    // PolicyService is a cross-cutting dependency; use setter injection to avoid
    // constructor cycles between services.
    this.providerService.setPolicyService(this.policyService);
    this.mcpServerManager.setPolicyService(this.policyService);
    this.aiService.setPolicyService(this.policyService);
    this.workspaceService.setPolicyService(this.policyService);

    // Register globally so all createRuntime calls can create CoderSSHRuntime
    setGlobalCoderService(this.coderService);

    // Backend timing stats (behind feature flag).
    this.aiService.on("stream-start", (data: StreamStartEvent) =>
      this.sessionTimingService.handleStreamStart(data)
    );
    this.aiService.on("stream-delta", (data: StreamDeltaEvent) =>
      this.sessionTimingService.handleStreamDelta(data)
    );
    this.aiService.on("reasoning-delta", (data: ReasoningDeltaEvent) =>
      this.sessionTimingService.handleReasoningDelta(data)
    );
    this.aiService.on("tool-call-start", (data: ToolCallStartEvent) =>
      this.sessionTimingService.handleToolCallStart(data)
    );
    this.aiService.on("tool-call-delta", (data: ToolCallDeltaEvent) =>
      this.sessionTimingService.handleToolCallDelta(data)
    );
    this.aiService.on("tool-call-end", (data: ToolCallEndEvent) =>
      this.sessionTimingService.handleToolCallEnd(data)
    );
    this.aiService.on("stream-end", (data: StreamEndEvent) =>
      this.sessionTimingService.handleStreamEnd(data)
    );
    this.aiService.on("stream-abort", (data: StreamAbortEvent) =>
      this.sessionTimingService.handleStreamAbort(data)
    );
    this.workspaceService.setExperimentsService(this.experimentsService);
  }

  async initialize(): Promise<void> {
    await this.extensionMetadata.initialize();
    // Initialize telemetry service
    await this.telemetryService.initialize();

    // Initialize policy service (startup gating)
    await this.policyService.initialize();

    // Initialize feature flag state (don't block startup on network).
    this.featureFlagService
      .getStatsTabState()
      .then((state) => this.sessionTimingService.setStatsTabState(state))
      .catch(() => {
        // Ignore feature flag failures.
      });
    await this.experimentsService.initialize();
    await this.taskService.initialize();
    // Start idle compaction checker
    this.idleCompactionService.start();

    // Refresh Coder SSH config in background (handles binary path changes on restart)
    // Skip getCoderInfo() to avoid caching "unavailable" if coder isn't installed yet
    void this.coderService.ensureSSHConfig().catch(() => {
      // Ignore errors - coder may not be installed
    });

    // Ensure the built-in Chat with Mux system workspace exists.
    // Defensive: startup-time initialization must never crash the app.
    try {
      await this.ensureMuxChatWorkspace();
    } catch (error) {
      log.warn("[ServiceContainer] Failed to ensure Chat with Mux workspace", { error });
    }
  }

  private async ensureMuxChatWorkspace(): Promise<void> {
    const projectPath = getMuxHelpChatProjectPath(this.config.rootDir);

    // Ensure the directory exists (LocalRuntime uses project dir directly).
    await fsPromises.mkdir(projectPath, { recursive: true });

    await this.config.editConfig((config) => {
      let projectConfig = config.projects.get(projectPath);
      if (!projectConfig) {
        projectConfig = { workspaces: [] };
        config.projects.set(projectPath, projectConfig);
      }

      const existing = projectConfig.workspaces.find((w) => w.id === MUX_HELP_CHAT_WORKSPACE_ID);
      if (!existing) {
        projectConfig.workspaces.push({
          path: projectPath,
          id: MUX_HELP_CHAT_WORKSPACE_ID,
          name: MUX_HELP_CHAT_WORKSPACE_NAME,
          title: MUX_HELP_CHAT_WORKSPACE_TITLE,
          agentId: MUX_HELP_CHAT_AGENT_ID,
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
        });
        return config;
      }

      // Self-heal: enforce invariants for the system workspace.
      existing.path = projectPath;
      existing.name = MUX_HELP_CHAT_WORKSPACE_NAME;
      existing.title = MUX_HELP_CHAT_WORKSPACE_TITLE;
      existing.agentId = MUX_HELP_CHAT_AGENT_ID;
      existing.createdAt ??= new Date().toISOString();
      existing.runtimeConfig = { type: "local" };
      existing.archivedAt = undefined;

      return config;
    });

    await this.ensureMuxChatWelcomeMessage();
  }

  private async ensureMuxChatWelcomeMessage(): Promise<void> {
    const historyResult = await this.historyService.getHistory(MUX_HELP_CHAT_WORKSPACE_ID);
    if (!historyResult.success) {
      log.warn("[ServiceContainer] Failed to read mux-chat history for welcome message", {
        error: historyResult.error,
      });
      return;
    }

    if (historyResult.data.length > 0) {
      return;
    }

    const message = createMuxMessage(
      MUX_HELP_CHAT_WELCOME_MESSAGE_ID,
      "assistant",
      MUX_HELP_CHAT_WELCOME_MESSAGE,
      // Note: This message should be visible in the UI, so it must NOT be marked synthetic.
      { timestamp: Date.now() }
    );

    const appendResult = await this.historyService.appendToHistory(
      MUX_HELP_CHAT_WORKSPACE_ID,
      message
    );
    if (!appendResult.success) {
      log.warn("[ServiceContainer] Failed to seed mux-chat welcome message", {
        error: appendResult.error,
      });
    }
  }

  /**
   * Shutdown services that need cleanup
   */
  async shutdown(): Promise<void> {
    this.idleCompactionService.stop();
    await this.telemetryService.shutdown();
  }

  setProjectDirectoryPicker(picker: () => Promise<string | null>): void {
    this.projectService.setDirectoryPicker(picker);
  }

  setTerminalWindowManager(manager: TerminalWindowManager): void {
    this.terminalService.setTerminalWindowManager(manager);
  }

  /**
   * Dispose all services. Called on app quit to clean up resources.
   * Terminates all background processes to prevent orphans.
   */
  async dispose(): Promise<void> {
    this.policyService.dispose();
    this.mcpServerManager.dispose();
    await this.mcpOauthService.dispose();
    await this.muxGatewayOauthService.dispose();
    await this.muxGovernorOauthService.dispose();
    await this.backgroundProcessManager.terminateAll();
  }
}
