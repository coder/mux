import * as path from "path";
import { DEFAULT_CODER_ARCHIVE_BEHAVIOR } from "@/common/config/coderArchiveBehavior";
import { DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR } from "@/common/config/worktreeArchiveBehavior";
import { log } from "@/node/services/log";
import type { Config } from "@/node/config";
import { createCoreServices, type CoreServices } from "@/node/services/coreServices";
import { PTYService } from "@/node/services/ptyService";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import { ProjectService } from "@/node/services/projectService";
import { MuxGatewayOauthService } from "@/node/services/muxGatewayOauthService";
import { MuxGovernorOauthService } from "@/node/services/muxGovernorOauthService";
import { CodexOauthService } from "@/node/services/codexOauthService";
import { CopilotOauthService } from "@/node/services/copilotOauthService";
import { TerminalService } from "@/node/services/terminalService";
import { OnePasswordService } from "@/node/services/onePasswordService";
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
import { BrowserBridgeServer } from "@/node/services/browser/BrowserBridgeServer";
import { AgentBrowserSessionDiscoveryService } from "@/node/services/browser/AgentBrowserSessionDiscoveryService";
import { BrowserBridgeTokenManager } from "@/node/services/browser/BrowserBridgeTokenManager";
import { BrowserControlService } from "@/node/services/browser/BrowserControlService";
import { BrowserSessionStateHub } from "@/node/services/browser/BrowserSessionStateHub";
import { DevToolsService } from "@/node/services/devToolsService";
import { SessionTimingService } from "@/node/services/sessionTimingService";
import { AnalyticsService } from "@/node/services/analytics/analyticsService";
import { ExperimentsService } from "@/node/services/experimentsService";
import { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { McpOauthService } from "@/node/services/mcpOauthService";
import { HeartbeatService } from "@/node/services/heartbeatService";
import { IdleCompactionService } from "@/node/services/idleCompactionService";
import { getSigningService, type SigningService } from "@/node/services/signingService";
import { coderService, type CoderService } from "@/node/services/coderService";
import { SshPromptService } from "@/node/services/sshPromptService";
import { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import { WorktreeArchiveSnapshotService } from "@/node/services/worktreeArchiveSnapshotService";
import {
  createCoderArchiveHook,
  createCoderUnarchiveHook,
} from "@/node/runtime/coderLifecycleHooks";
import { createWorktreeArchiveHook } from "@/node/runtime/worktreeLifecycleHooks";
import { setGlobalCoderService } from "@/node/runtime/runtimeFactory";
import { setSshPromptService } from "@/node/runtime/sshConnectionPool";
import { setSshPromptService as setSSH2SshPromptService } from "@/node/runtime/SSH2ConnectionPool";
import {
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
} from "@/node/runtime/runtimeHelpers";
import { PolicyService } from "@/node/services/policyService";
import { ServerAuthService } from "@/node/services/serverAuthService";
import { DesktopBridgeServer } from "@/node/services/desktop/DesktopBridgeServer";
import { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import { DesktopTokenManager } from "@/node/services/desktop/DesktopTokenManager";
import type { ORPCContext } from "@/node/orpc/context";
import type { ExternalSecretResolver } from "@/common/types/secrets";

/**
 * ServiceContainer - Central dependency container for all backend services.
 *
 * This class instantiates and wires together all services needed by the ORPC router.
 * Services are accessed via the ORPC context object.
 */
export class ServiceContainer {
  public readonly config: Config;
  // Core services — instantiated by createCoreServices (shared with `mux run` CLI)
  private readonly historyService: CoreServices["historyService"];
  public readonly aiService: CoreServices["aiService"];
  public readonly workspaceService: CoreServices["workspaceService"];
  public readonly taskService: CoreServices["taskService"];
  public readonly providerService: CoreServices["providerService"];
  public readonly mcpConfigService: CoreServices["mcpConfigService"];
  public readonly mcpServerManager: CoreServices["mcpServerManager"];
  public readonly lspManager: CoreServices["lspManager"];
  public readonly sessionUsageService: CoreServices["sessionUsageService"];
  private readonly extensionMetadata: CoreServices["extensionMetadata"];
  private readonly backgroundProcessManager: CoreServices["backgroundProcessManager"];
  // Desktop-only services
  public readonly projectService: ProjectService;
  public readonly muxGatewayOauthService: MuxGatewayOauthService;
  public readonly muxGovernorOauthService: MuxGovernorOauthService;
  public readonly codexOauthService: CodexOauthService;
  public readonly copilotOauthService: CopilotOauthService;
  private _onePasswordService: OnePasswordService | null | undefined = undefined;
  private _onePasswordServiceAccountName: string | undefined;
  public readonly terminalService: TerminalService;
  public readonly editorService: EditorService;
  public readonly windowService: WindowService;
  public readonly updateService: UpdateService;
  public readonly tokenizerService: TokenizerService;
  public readonly serverService: ServerService;
  public readonly menuEventService: MenuEventService;
  public readonly voiceService: VoiceService;
  public readonly mcpOauthService: McpOauthService;
  public readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  public readonly telemetryService: TelemetryService;
  public readonly sessionTimingService: SessionTimingService;
  public readonly devToolsService: DevToolsService;
  public readonly browserSessionDiscoveryService: AgentBrowserSessionDiscoveryService;
  public readonly browserBridgeTokenManager: BrowserBridgeTokenManager;
  public readonly browserBridgeServer: BrowserBridgeServer;
  public readonly browserControlService: BrowserControlService;
  public readonly browserSessionStateHub: BrowserSessionStateHub;
  public readonly analyticsService: AnalyticsService;
  public readonly experimentsService: ExperimentsService;
  public readonly signingService: SigningService;
  public readonly policyService: PolicyService;
  public readonly coderService: CoderService;
  public readonly serverAuthService: ServerAuthService;
  public readonly desktopSessionManager: DesktopSessionManager;
  public readonly desktopTokenManager: DesktopTokenManager;
  public readonly desktopBridgeServer: DesktopBridgeServer;
  public readonly sshPromptService = new SshPromptService();
  private readonly ptyService: PTYService;
  public readonly idleCompactionService: IdleCompactionService;
  public readonly heartbeatService: HeartbeatService;

  constructor(config: Config) {
    this.config = config;

    // Cross-cutting services: created first so they can be passed to core
    // services via constructor params (no setter injection needed).
    this.policyService = new PolicyService(config);
    this.telemetryService = new TelemetryService(config.rootDir);
    this.experimentsService = new ExperimentsService({
      telemetryService: this.telemetryService,
      muxHome: config.rootDir,
    });
    this.sessionTimingService = new SessionTimingService(config, this.telemetryService);
    this.analyticsService = new AnalyticsService(config);
    this.devToolsService = new DevToolsService(config);
    this.browserBridgeTokenManager = new BrowserBridgeTokenManager();

    // Desktop passes WorkspaceMcpOverridesService explicitly so AIService uses
    // the persistent config rather than creating a default with an ephemeral one.
    this.workspaceMcpOverridesService = new WorkspaceMcpOverridesService(config);

    // 1Password integration — resolve references lazily so config updates are picked
    // up without requiring an app restart.
    const opResolver: ExternalSecretResolver = async (ref: string) => {
      const service = this.onePasswordService;
      if (!service) {
        return undefined;
      }

      return service.resolve(ref);
    };

    const core = createCoreServices({
      config,
      extensionMetadataPath: path.join(config.rootDir, "extensionMetadata.json"),
      workspaceMcpOverridesService: this.workspaceMcpOverridesService,
      policyService: this.policyService,
      telemetryService: this.telemetryService,
      experimentsService: this.experimentsService,
      sessionTimingService: this.sessionTimingService,
      devToolsService: this.devToolsService,
      opResolver,
    });

    // Spread core services into class fields
    this.historyService = core.historyService;
    this.aiService = core.aiService;
    this.aiService.setAnalyticsService(this.analyticsService);
    this.browserSessionDiscoveryService = new AgentBrowserSessionDiscoveryService({
      resolveWorkspaceCandidatePathsFn: async (workspaceId: string) => {
        const allWorkspaceMetadata = await config.getAllWorkspaceMetadata();
        const workspaceMetadata =
          allWorkspaceMetadata.find((candidate) => candidate.id === workspaceId) ?? null;
        if (workspaceMetadata == null) {
          return [];
        }

        const runtime = createRuntimeForWorkspace(workspaceMetadata);
        const workspacePath = resolveWorkspaceExecutionPath(workspaceMetadata, runtime);
        return [workspaceMetadata.projectPath, workspacePath].filter(
          (candidatePath): candidatePath is string => candidatePath.trim().length > 0
        );
      },
    });
    this.browserControlService = new BrowserControlService({
      browserSessionDiscoveryService: this.browserSessionDiscoveryService,
      resolveSessionEnvFn: () => Promise.resolve(process.env),
    });
    this.browserSessionStateHub = new BrowserSessionStateHub({
      browserControlService: this.browserControlService,
    });
    this.browserBridgeServer = new BrowserBridgeServer({
      browserSessionDiscoveryService: this.browserSessionDiscoveryService,
      browserBridgeTokenManager: this.browserBridgeTokenManager,
      browserSessionStateHub: this.browserSessionStateHub,
    });
    this.workspaceService = core.workspaceService;
    this.taskService = core.taskService;
    this.providerService = core.providerService;
    this.mcpConfigService = core.mcpConfigService;
    this.mcpServerManager = core.mcpServerManager;
    this.lspManager = core.lspManager;
    this.sessionUsageService = core.sessionUsageService;
    this.extensionMetadata = core.extensionMetadata;
    this.backgroundProcessManager = core.backgroundProcessManager;

    this.projectService = new ProjectService(config, this.sshPromptService);
    this.projectService.setWorkspaceService(this.workspaceService);
    this.desktopSessionManager = new DesktopSessionManager({
      config,
      experimentsService: this.experimentsService,
      workspaceService: this.workspaceService,
    });
    this.aiService.setDesktopSessionManager(this.desktopSessionManager);
    this.desktopTokenManager = new DesktopTokenManager();
    this.desktopBridgeServer = new DesktopBridgeServer({
      desktopSessionManager: this.desktopSessionManager,
      desktopTokenManager: this.desktopTokenManager,
    });

    // Idle compaction service - auto-compacts workspaces after configured idle period
    this.idleCompactionService = new IdleCompactionService(
      config,
      this.historyService,
      this.extensionMetadata,
      (workspaceId) => this.workspaceService.executeIdleCompaction(workspaceId)
    );
    // Heartbeat service - periodically sends heartbeat turns to eligible idle workspaces
    this.heartbeatService = new HeartbeatService(
      config,
      this.extensionMetadata,
      this.workspaceService,
      this.taskService
    );
    this.windowService = new WindowService();
    this.mcpOauthService = new McpOauthService(
      config,
      this.mcpConfigService,
      this.windowService,
      this.telemetryService
    );
    this.mcpServerManager.setMcpOauthService(this.mcpOauthService);

    this.muxGatewayOauthService = new MuxGatewayOauthService(
      this.providerService,
      this.windowService
    );
    this.muxGovernorOauthService = new MuxGovernorOauthService(
      config,
      this.windowService,
      this.policyService
    );
    this.codexOauthService = new CodexOauthService(
      config,
      this.providerService,
      this.windowService
    );
    this.aiService.setCodexOauthService(this.codexOauthService);
    this.copilotOauthService = new CopilotOauthService(this.providerService, this.windowService);
    // Terminal services - PTYService is cross-platform
    this.ptyService = new PTYService();
    this.terminalService = new TerminalService(config, this.ptyService, opResolver);
    // Wire terminal service to workspace service for cleanup on removal
    this.workspaceService.setTerminalService(this.terminalService);
    this.workspaceService.setDesktopSessionManager(this.desktopSessionManager);
    // Editor service for opening workspaces in code editors
    this.editorService = new EditorService(config);
    this.updateService = new UpdateService(this.config);
    this.tokenizerService = new TokenizerService(this.sessionUsageService);
    this.serverService = new ServerService();
    this.menuEventService = new MenuEventService();
    this.voiceService = new VoiceService(
      config,
      this.providerService,
      this.policyService,
      opResolver
    );
    this.signingService = getSigningService();
    this.coderService = coderService;

    this.serverAuthService = new ServerAuthService(config);

    const workspaceLifecycleHooks = new WorkspaceLifecycleHooks();
    const worktreeArchiveSnapshotService = new WorktreeArchiveSnapshotService(this.config);
    this.workspaceService.setWorktreeArchiveSnapshotService(worktreeArchiveSnapshotService);
    const getArchiveBehavior = () =>
      this.config.loadConfigOrDefault().coderWorkspaceArchiveBehavior ??
      DEFAULT_CODER_ARCHIVE_BEHAVIOR;
    workspaceLifecycleHooks.registerBeforeArchive(
      createCoderArchiveHook({
        coderService: this.coderService,
        getArchiveBehavior,
      })
    );
    workspaceLifecycleHooks.registerAfterUnarchive(
      createCoderUnarchiveHook({
        coderService: this.coderService,
        getArchiveBehavior,
      })
    );
    const getWorktreeArchiveBehavior = () =>
      this.config.loadConfigOrDefault().worktreeArchiveBehavior ??
      DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
    workspaceLifecycleHooks.registerAfterArchive(
      createWorktreeArchiveHook({ getWorktreeArchiveBehavior })
    );
    this.workspaceService.setWorkspaceLifecycleHooks(workspaceLifecycleHooks);

    // Register globally so all createRuntime calls can create CoderSSHRuntime
    setGlobalCoderService(this.coderService);
    setSshPromptService(this.sshPromptService);
    setSSH2SshPromptService(this.sshPromptService);

    // Backend timing stats.
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
    this.aiService.on("stream-end", (data: StreamEndEvent) => {
      this.sessionTimingService.handleStreamEnd(data);

      const workspaceLookup = this.config.findWorkspace(data.workspaceId);
      const sessionDir = this.config.getSessionDir(data.workspaceId);
      const analyticsProjectPath =
        workspaceLookup?.attributionProjectPath ?? workspaceLookup?.projectPath;
      // Newly created sub-agent workspaces are ingested here before a full rebuild,
      // so keep workspaceName + parentWorkspaceId to avoid NULL analytics attribution.
      // Multi-project workspaces stay stored under _multi in config, but analytics should
      // still attribute spend to the workspace's first real project path.
      this.analyticsService.ingestWorkspace(data.workspaceId, sessionDir, {
        projectPath: analyticsProjectPath,
        projectName: analyticsProjectPath ? path.basename(analyticsProjectPath) : undefined,
        workspaceName: workspaceLookup?.workspaceName,
        parentWorkspaceId: workspaceLookup?.parentWorkspaceId,
      });
    });
    // WorkspaceService emits metadata:null after successful remove().
    // Clear analytics rows immediately so deleted workspaces disappear from stats
    // without waiting for a future ingest pass.
    this.workspaceService.on("metadata", (event) => {
      if (event.metadata !== null) {
        return;
      }

      this.analyticsService.clearWorkspace(event.workspaceId);
    });

    this.aiService.on("stream-abort", (data: StreamAbortEvent) =>
      this.sessionTimingService.handleStreamAbort(data)
    );
  }

  get onePasswordService(): OnePasswordService | null {
    const opAccountName = this.config.loadConfigOrDefault().onePasswordAccountName;

    if (!opAccountName) {
      this._onePasswordService = null;
      this._onePasswordServiceAccountName = undefined;
      return null;
    }

    if (
      this._onePasswordService === undefined ||
      this._onePasswordService === null ||
      this._onePasswordServiceAccountName !== opAccountName
    ) {
      this._onePasswordService = new OnePasswordService(opAccountName);
      this._onePasswordServiceAccountName = opAccountName;
    }

    return this._onePasswordService;
  }

  async initialize(): Promise<void> {
    const startupStartedAt = Date.now();
    const stepDurationsMs: Record<string, number> = {};
    const recordStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const stepStartedAt = Date.now();
      try {
        return await fn();
      } finally {
        stepDurationsMs[name] = Date.now() - stepStartedAt;
      }
    };

    log.info("[startup] ServiceContainer.initialize starting");

    await recordStep("extensionMetadata.initialize", () => this.extensionMetadata.initialize());
    // Initialize telemetry service
    await recordStep("telemetryService.initialize", () => this.telemetryService.initialize());

    // Initialize policy service (startup gating)
    await recordStep("policyService.initialize", () => this.policyService.initialize());

    await recordStep("experimentsService.initialize", () => this.experimentsService.initialize());
    // Kick off non-task chat restart recovery eagerly; task workspaces recover in TaskService.initialize().
    await recordStep("workspaceService.initialize", () => this.workspaceService.initialize());
    await recordStep("taskService.initialize", () => this.taskService.initialize());

    const idleCompactionStartedAt = Date.now();
    // Start idle compaction checker
    this.idleCompactionService.start();
    stepDurationsMs["idleCompactionService.start"] = Date.now() - idleCompactionStartedAt;

    const heartbeatStartedAt = Date.now();
    this.heartbeatService.start();
    stepDurationsMs["heartbeatService.start"] = Date.now() - heartbeatStartedAt;

    // Refresh mux-owned Coder SSH config in background (handles binary path changes on restart)
    // Skip getCoderInfo() to avoid caching "unavailable" if coder isn't installed yet
    void this.coderService.ensureMuxCoderSSHConfig().catch((error: unknown) => {
      log.warn("Background mux SSH config setup failed", { error });
    });

    log.info("[startup] ServiceContainer.initialize completed", {
      totalMs: Date.now() - startupStartedAt,
      stepDurationsMs,
    });
  }

  /**
   * Build the ORPCContext from this container's services.
   * Centralizes the ServiceContainer → ORPCContext mapping so callers
   * (desktop/main.ts, cli/server.ts) don't duplicate a 30-field spread.
   */
  toORPCContext(): Omit<ORPCContext, "headers"> {
    const resolveOnePasswordService = () => this.onePasswordService;

    return {
      config: this.config,
      aiService: this.aiService,
      projectService: this.projectService,
      workspaceService: this.workspaceService,
      taskService: this.taskService,
      providerService: this.providerService,
      muxGatewayOauthService: this.muxGatewayOauthService,
      muxGovernorOauthService: this.muxGovernorOauthService,
      codexOauthService: this.codexOauthService,
      copilotOauthService: this.copilotOauthService,
      get onePasswordService() {
        return resolveOnePasswordService();
      },
      terminalService: this.terminalService,
      editorService: this.editorService,
      windowService: this.windowService,
      updateService: this.updateService,
      tokenizerService: this.tokenizerService,
      serverService: this.serverService,
      menuEventService: this.menuEventService,
      voiceService: this.voiceService,
      mcpConfigService: this.mcpConfigService,
      mcpOauthService: this.mcpOauthService,
      workspaceMcpOverridesService: this.workspaceMcpOverridesService,
      mcpServerManager: this.mcpServerManager,
      sessionTimingService: this.sessionTimingService,
      telemetryService: this.telemetryService,
      experimentsService: this.experimentsService,
      sessionUsageService: this.sessionUsageService,
      lspManager: this.lspManager,
      devToolsService: this.devToolsService,
      browserSessionDiscoveryService: this.browserSessionDiscoveryService,
      browserBridgeTokenManager: this.browserBridgeTokenManager,
      browserBridgeServer: this.browserBridgeServer,
      browserControlService: this.browserControlService,
      browserSessionStateHub: this.browserSessionStateHub,
      policyService: this.policyService,
      signingService: this.signingService,
      coderService: this.coderService,
      serverAuthService: this.serverAuthService,
      sshPromptService: this.sshPromptService,
      analyticsService: this.analyticsService,
      desktopSessionManager: this.desktopSessionManager,
      desktopTokenManager: this.desktopTokenManager,
      desktopBridgeServer: this.desktopBridgeServer,
    };
  }

  /**
   * Shutdown services that need cleanup
   */
  async shutdown(): Promise<void> {
    // Stop the bridge before closing sessions so desktop clients get a clean disconnect.
    await this.desktopBridgeServer.stop();
    this.desktopTokenManager.dispose();
    await this.desktopSessionManager.closeAll();
    this.heartbeatService.stop();
    this.idleCompactionService.stop();
    await this.browserBridgeServer.stop();
    this.browserSessionStateHub.dispose();
    this.browserBridgeTokenManager.dispose();
    await this.analyticsService.dispose();
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
    // Stop the bridge before closing sessions so desktop clients get a clean disconnect.
    await this.desktopBridgeServer.stop();
    this.desktopTokenManager.dispose();
    await this.desktopSessionManager.closeAll();
    await this.browserBridgeServer.stop();
    this.browserSessionStateHub.dispose();
    this.browserBridgeTokenManager.dispose();
    await this.analyticsService.dispose();
    this.policyService.dispose();
    this.mcpServerManager.dispose();
    await this.lspManager.dispose();
    await this.mcpOauthService.dispose();
    await this.muxGatewayOauthService.dispose();
    await this.muxGovernorOauthService.dispose();
    await this.codexOauthService.dispose();

    this.copilotOauthService.dispose();
    this.serverAuthService.dispose();
    await this.backgroundProcessManager.terminateAll();
  }
}
