/**
 * Core service graph shared by `mux run` (CLI) and `ServiceContainer` (desktop).
 */

import * as os from "os";
import * as path from "path";
import type { Config } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { PartialService } from "@/node/services/partialService";
import { InitStateManager } from "@/node/services/initStateManager";
import { ProviderService } from "@/node/services/providerService";
import { AIService } from "@/node/services/aiService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { MCPServerManager, type MCPServerManagerOptions } from "@/node/services/mcpServerManager";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { TaskService } from "@/node/services/taskService";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import type { PolicyService } from "@/node/services/policyService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { SessionTimingService } from "@/node/services/sessionTimingService";

export interface CoreServicesOptions {
  config: Config;
  extensionMetadataPath: string;
  /** Overrides config for MCPConfigService; CLI passes its persistent realConfig. */
  mcpConfig?: Config;
  mcpServerManagerOptions?: MCPServerManagerOptions;
  workspaceMcpOverridesService?: WorkspaceMcpOverridesService;
  /** Optional cross-cutting services (desktop creates before core services). */
  policyService?: PolicyService;
  telemetryService?: TelemetryService;
  experimentsService?: ExperimentsService;
  sessionTimingService?: SessionTimingService;
}

export interface CoreServices {
  historyService: HistoryService;
  partialService: PartialService;
  initStateManager: InitStateManager;
  providerService: ProviderService;
  backgroundProcessManager: BackgroundProcessManager;
  sessionUsageService: SessionUsageService;
  aiService: AIService;
  mcpConfigService: MCPConfigService;
  mcpServerManager: MCPServerManager;
  extensionMetadata: ExtensionMetadataService;
  workspaceService: WorkspaceService;
  taskService: TaskService;
}

export function createCoreServices(opts: CoreServicesOptions): CoreServices {
  const { config, extensionMetadataPath } = opts;

  const historyService = new HistoryService(config);
  const partialService = new PartialService(config, historyService);
  const initStateManager = new InitStateManager(config);
  const providerService = new ProviderService(config, opts.policyService);
  const backgroundProcessManager = new BackgroundProcessManager(
    path.join(os.tmpdir(), "mux-bashes")
  );
  const sessionUsageService = new SessionUsageService(config, historyService);

  const aiService = new AIService(
    config,
    historyService,
    partialService,
    initStateManager,
    providerService,
    backgroundProcessManager,
    sessionUsageService,
    opts.workspaceMcpOverridesService,
    opts.policyService,
    opts.telemetryService
  );

  // MCP: allow callers to override which Config provides server definitions
  const mcpConfigService = new MCPConfigService(opts.mcpConfig ?? config);
  const mcpServerManager = new MCPServerManager(
    mcpConfigService,
    opts.mcpServerManagerOptions,
    opts.policyService
  );
  aiService.setMCPServerManager(mcpServerManager);

  const extensionMetadata = new ExtensionMetadataService(extensionMetadataPath);

  const workspaceService = new WorkspaceService(
    config,
    historyService,
    partialService,
    aiService,
    initStateManager,
    extensionMetadata,
    backgroundProcessManager,
    sessionUsageService,
    opts.policyService,
    opts.telemetryService,
    opts.experimentsService,
    opts.sessionTimingService
  );
  workspaceService.setMCPServerManager(mcpServerManager);

  const taskService = new TaskService(
    config,
    historyService,
    partialService,
    aiService,
    workspaceService,
    initStateManager
  );
  aiService.setTaskService(taskService);

  return {
    historyService,
    partialService,
    initStateManager,
    providerService,
    backgroundProcessManager,
    sessionUsageService,
    aiService,
    mcpConfigService,
    mcpServerManager,
    extensionMetadata,
    workspaceService,
    taskService,
  };
}
