import type { BrowserWindow, WebContents } from "electron";
import { Config } from "../../../src/node/config";
import type { ORPCContext } from "../../../src/node/orpc/context";
import { ServiceContainer } from "../../../src/node/services/serviceContainer";
import { createMuxMessage } from "../../../src/common/types/message";
import { createOrpcTestClient } from "../orpcTestClient";

function createMockBrowserWindow(): BrowserWindow {
  const mockWindow = {
    webContents: {
      send: () => undefined,
      openDevTools: () => undefined,
    } as unknown as WebContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => undefined,
    focus: () => undefined,
    loadURL: () => undefined,
    on: () => undefined,
    setTitle: () => undefined,
  } as unknown as BrowserWindow;

  return mockWindow;
}

async function main(): Promise<void> {
  const rootDir = process.env.MUX_TEST_ROOT_DIR;
  const workspaceId = process.env.MUX_TEST_WORKSPACE_ID;
  const summaryBytesRaw = process.env.MUX_TEST_SUMMARY_BYTES ?? "20000000";

  if (!rootDir) {
    throw new Error("MUX_TEST_ROOT_DIR is required");
  }
  if (!workspaceId) {
    throw new Error("MUX_TEST_WORKSPACE_ID is required");
  }

  const summaryBytes = Number(summaryBytesRaw);
  if (!Number.isFinite(summaryBytes) || summaryBytes <= 0) {
    throw new Error(`Invalid MUX_TEST_SUMMARY_BYTES: ${summaryBytesRaw}`);
  }

  const config = new Config(rootDir);
  const services = new ServiceContainer(config);
  await services.initialize();

  services.windowService.setMainWindow(createMockBrowserWindow());

  const orpcContext: ORPCContext = {
    config: services.config,
    aiService: services.aiService,
    projectService: services.projectService,
    workspaceService: services.workspaceService,
    taskService: services.taskService,
    providerService: services.providerService,
    terminalService: services.terminalService,
    editorService: services.editorService,
    windowService: services.windowService,
    updateService: services.updateService,
    tokenizerService: services.tokenizerService,
    serverService: services.serverService,
    featureFlagService: services.featureFlagService,
    sessionTimingService: services.sessionTimingService,
    mcpConfigService: services.mcpConfigService,
    mcpServerManager: services.mcpServerManager,
    menuEventService: services.menuEventService,
    voiceService: services.voiceService,
    experimentsService: services.experimentsService,
    telemetryService: services.telemetryService,
    sessionUsageService: services.sessionUsageService,
  };

  const client = createOrpcTestClient(orpcContext);

  // Huge payload to keep the write-file-atomic temp file around long enough
  // for the parent Jest process to observe and SIGKILL us.
  const summaryText = "X".repeat(summaryBytes);

  const summaryMessage = createMuxMessage(
    `compaction-summary-${Date.now()}`,
    "assistant",
    summaryText,
    {
      compacted: "user",
    }
  );

  const result = await client.workspace.replaceChatHistory({
    workspaceId,
    summaryMessage,
  });

  if (!result.success) {
    throw new Error(`replaceChatHistory failed: ${result.error}`);
  }

  // Best-effort cleanup (won't run under SIGKILL).
  await services.dispose();
  await services.shutdown();
}

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});
