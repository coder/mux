import type { IncomingHttpHeaders } from "http";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { ProjectService } from "@/node/services/projectService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { ProviderService } from "@/node/services/providerService";
import type { TerminalService } from "@/node/services/terminalService";
import type { EditorService } from "@/node/services/editorService";
import type { WindowService } from "@/node/services/windowService";
import type { UpdateService } from "@/node/services/updateService";
import type { TokenizerService } from "@/node/services/tokenizerService";
import type { ServerService } from "@/node/services/serverService";
import type { MenuEventService } from "@/node/services/menuEventService";
import type { VoiceService } from "@/node/services/voiceService";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { SessionUsageService } from "@/node/services/sessionUsageService";

export interface ORPCContext {
  config: Config;
  aiService: AIService;
  projectService: ProjectService;
  workspaceService: WorkspaceService;
  providerService: ProviderService;
  terminalService: TerminalService;
  editorService: EditorService;
  windowService: WindowService;
  updateService: UpdateService;
  tokenizerService: TokenizerService;
  serverService: ServerService;
  menuEventService: MenuEventService;
  voiceService: VoiceService;
  mcpConfigService: MCPConfigService;
  mcpServerManager: MCPServerManager;
  telemetryService: TelemetryService;
  sessionUsageService: SessionUsageService;
  headers?: IncomingHttpHeaders;
}
