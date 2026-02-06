/**
 * Core service graph shared by `mux run` (CLI) and `ServiceContainer` (desktop).
 *
 * Both entry points instantiate the same dependency chain:
 *   HistoryService → PartialService → AIService → WorkspaceService → TaskService
 * with identical constructor args and setter wiring. Differences between CLI
 * and desktop (e.g., ephemeral vs persistent paths, MCP options) are handled
 * via the options bag.
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

// ---------------------------------------------------------------------------
// Options & return types
// ---------------------------------------------------------------------------

export interface CoreServicesOptions {
  /** Primary config instance (used by most services). */
  config: Config;

  /** Path for ExtensionMetadataService storage. Desktop uses ~/.mux/, CLI uses a temp dir. */
  extensionMetadataPath: string;

  /**
   * Config instance for MCPConfigService. Defaults to `config`.
   * CLI passes its persistent `realConfig` so MCP server definitions survive
   * across ephemeral session configs.
   */
  mcpConfig?: Config;

  /** Options forwarded to MCPServerManager (e.g., inline servers from CLI flags). */
  mcpServerManagerOptions?: MCPServerManagerOptions;

  /**
   * Optional workspace-level MCP overrides. Desktop passes an explicit instance;
   * when omitted, AIService creates a default internally.
   */
  workspaceMcpOverridesService?: WorkspaceMcpOverridesService;

  /**
   * Optional cross-cutting services. Desktop creates these before core services
   * so they can be wired via constructors instead of setters.
   */
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Instantiate and wire the core service graph that both `mux run` and the
 * Electron `ServiceContainer` share. Returns a flat bag of services; callers
 * can destructure what they need.
 */
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
