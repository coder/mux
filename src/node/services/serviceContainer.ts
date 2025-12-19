import * as os from "os";
import * as path from "path";
import type { Config } from "@/node/config";
import { AIService } from "@/node/services/aiService";
import { HistoryService } from "@/node/services/historyService";
import { PartialService } from "@/node/services/partialService";
import { InitStateManager } from "@/node/services/initStateManager";
import { PTYService } from "@/node/services/ptyService";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import { ProjectService } from "@/node/services/projectService";
import { WorkspaceService } from "@/node/services/workspaceService";
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
import { MCPServerManager } from "@/node/services/mcpServerManager";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { IdleCompactionService } from "@/node/services/idleCompactionService";
import { TaskService } from "@/node/services/taskService";

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
  public readonly terminalService: TerminalService;
  public readonly editorService: EditorService;
  public readonly windowService: WindowService;
  public readonly updateService: UpdateService;
  public readonly tokenizerService: TokenizerService;
  public readonly serverService: ServerService;
  public readonly menuEventService: MenuEventService;
  public readonly voiceService: VoiceService;
  public readonly mcpConfigService: MCPConfigService;
  public readonly mcpServerManager: MCPServerManager;
  public readonly telemetryService: TelemetryService;
  public readonly featureFlagService: FeatureFlagService;
  public readonly sessionTimingService: SessionTimingService;
  public readonly experimentsService: ExperimentsService;
  public readonly sessionUsageService: SessionUsageService;
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
    this.mcpConfigService = new MCPConfigService();
    this.extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    this.backgroundProcessManager = new BackgroundProcessManager(
      path.join(os.tmpdir(), "mux-bashes")
    );
    this.mcpServerManager = new MCPServerManager(this.mcpConfigService);
    this.sessionUsageService = new SessionUsageService(config, this.historyService);
    this.aiService = new AIService(
      config,
      this.historyService,
      this.partialService,
      this.initStateManager,
      this.backgroundProcessManager,
      this.sessionUsageService
    );
    this.aiService.setMCPServerManager(this.mcpServerManager);
    this.workspaceService = new WorkspaceService(
      config,
      this.historyService,
      this.partialService,
      this.aiService,
      this.initStateManager,
      this.extensionMetadata,
      this.backgroundProcessManager
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
    this.providerService = new ProviderService(config);
    // Terminal services - PTYService is cross-platform
    this.ptyService = new PTYService();
    this.terminalService = new TerminalService(config, this.ptyService);
    // Wire terminal service to workspace service for cleanup on removal
    this.workspaceService.setTerminalService(this.terminalService);
    // Editor service for opening workspaces in code editors
    this.editorService = new EditorService(config);
    this.windowService = new WindowService();
    this.updateService = new UpdateService();
    this.tokenizerService = new TokenizerService();
    this.serverService = new ServerService();
    this.menuEventService = new MenuEventService();
    this.voiceService = new VoiceService(config);
    this.telemetryService = new TelemetryService(config.rootDir);
    this.aiService.setTelemetryService(this.telemetryService);
    this.workspaceService.setTelemetryService(this.telemetryService);
    this.experimentsService = new ExperimentsService({
      telemetryService: this.telemetryService,
      muxHome: config.rootDir,
    });
    this.featureFlagService = new FeatureFlagService(config, this.telemetryService);
    this.sessionTimingService = new SessionTimingService(config, this.telemetryService);

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
    this.mcpServerManager.dispose();
    await this.backgroundProcessManager.terminateAll();
  }
}
