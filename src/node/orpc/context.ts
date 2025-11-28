import type { IncomingHttpHeaders } from "http";
import type { ProjectService } from "@/node/services/projectService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { ProviderService } from "@/node/services/providerService";
import type { TerminalService } from "@/node/services/terminalService";
import type { WindowService } from "@/node/services/windowService";
import type { UpdateService } from "@/node/services/updateService";
import type { TokenizerService } from "@/node/services/tokenizerService";
import type { ServerService } from "@/node/services/serverService";
import type { MenuEventService } from "@/node/services/menuEventService";
import type { VoiceService } from "@/node/services/voiceService";

export interface ORPCContext {
  projectService: ProjectService;
  workspaceService: WorkspaceService;
  providerService: ProviderService;
  terminalService: TerminalService;
  windowService: WindowService;
  updateService: UpdateService;
  tokenizerService: TokenizerService;
  serverService: ServerService;
  menuEventService: MenuEventService;
  voiceService: VoiceService;
  headers?: IncomingHttpHeaders;
}
