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
import { WindowService } from "@/node/services/windowService";
import { UpdateService } from "@/node/services/updateService";
import { TokenizerService } from "@/node/services/tokenizerService";
import { ServerService } from "@/node/services/serverService";
import { MenuEventService } from "@/node/services/menuEventService";
import { VoiceService } from "@/node/services/voiceService";

/**
 * ServiceContainer - Central dependency container for all backend services.
 *
 * This class instantiates and wires together all services needed by the ORPC router.
 * Services are accessed via the ORPC context object.
 */
export class ServiceContainer {
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly aiService: AIService;
  public readonly projectService: ProjectService;
  public readonly workspaceService: WorkspaceService;
  public readonly providerService: ProviderService;
  public readonly terminalService: TerminalService;
  public readonly windowService: WindowService;
  public readonly updateService: UpdateService;
  public readonly tokenizerService: TokenizerService;
  public readonly serverService: ServerService;
  public readonly menuEventService: MenuEventService;
  public readonly voiceService: VoiceService;
  private readonly initStateManager: InitStateManager;
  private readonly extensionMetadata: ExtensionMetadataService;
  private readonly ptyService: PTYService;

  constructor(config: Config) {
    this.config = config;
    this.historyService = new HistoryService(config);
    this.partialService = new PartialService(config, this.historyService);
    this.projectService = new ProjectService(config);
    this.initStateManager = new InitStateManager(config);
    this.extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    this.aiService = new AIService(
      config,
      this.historyService,
      this.partialService,
      this.initStateManager
    );
    this.workspaceService = new WorkspaceService(
      config,
      this.historyService,
      this.partialService,
      this.aiService,
      this.initStateManager,
      this.extensionMetadata
    );
    this.providerService = new ProviderService(config);
    // Terminal services - PTYService is cross-platform
    this.ptyService = new PTYService();
    this.terminalService = new TerminalService(config, this.ptyService);
    // Wire terminal service to workspace service for cleanup on removal
    this.workspaceService.setTerminalService(this.terminalService);
    this.windowService = new WindowService();
    this.updateService = new UpdateService();
    this.tokenizerService = new TokenizerService();
    this.serverService = new ServerService();
    this.menuEventService = new MenuEventService();
    this.voiceService = new VoiceService(config);
  }

  async initialize(): Promise<void> {
    await this.extensionMetadata.initialize();
  }

  setProjectDirectoryPicker(picker: () => Promise<string | null>): void {
    this.projectService.setDirectoryPicker(picker);
  }

  setTerminalWindowManager(manager: TerminalWindowManager): void {
    this.terminalService.setTerminalWindowManager(manager);
  }
}
