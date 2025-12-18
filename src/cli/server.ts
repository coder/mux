/**
 * CLI entry point for the mux oRPC server.
 * Uses createOrpcServer from ./orpcServer.ts for the actual server logic.
 */
import { Config } from "@/node/config";
import { ServiceContainer } from "@/node/services/serviceContainer";
import { ServerLockfile } from "@/node/services/serverLockfile";
import { getMuxHome, migrateLegacyMuxHome } from "@/common/constants/paths";
import type { BrowserWindow } from "electron";
import { Command } from "commander";
import { validateProjectPath } from "@/node/utils/pathUtils";
import { createOrpcServer } from "@/node/orpc/server";
import type { ORPCContext } from "@/node/orpc/context";
import { getParseOptions } from "./argv";

const program = new Command();
program
  .name("mux server")
  .description("HTTP/WebSocket ORPC server for mux")
  .option("-h, --host <host>", "bind to specific host", "localhost")
  .option("-p, --port <port>", "bind to specific port", "3000")
  .option("--auth-token <token>", "optional bearer token for HTTP/WS auth")
  .option("--ssh-host <host>", "SSH hostname/alias for editor deep links (e.g., devbox)")
  .option("--add-project <path>", "add and open project at the specified path (idempotent)")
  .parse(process.argv, getParseOptions());

const options = program.opts();
const HOST = options.host as string;
const PORT = Number.parseInt(String(options.port), 10);
const rawAuthToken = (options.authToken as string | undefined) ?? process.env.MUX_SERVER_AUTH_TOKEN;
const AUTH_TOKEN = rawAuthToken?.trim() ? rawAuthToken.trim() : undefined;
const ADD_PROJECT_PATH = options.addProject as string | undefined;
// SSH host for editor deep links (CLI flag > env var > config file, resolved later)
const CLI_SSH_HOST = options.sshHost as string | undefined;

// Track the launch project path for initial navigation
let launchProjectPath: string | null = null;

// Minimal BrowserWindow stub for services that expect one
const mockWindow: BrowserWindow = {
  isDestroyed: () => false,
  setTitle: () => undefined,
  webContents: {
    send: () => undefined,
    openDevTools: () => undefined,
  },
} as unknown as BrowserWindow;

(async () => {
  migrateLegacyMuxHome();

  // Check for existing server (Electron or another mux server instance)
  const lockfile = new ServerLockfile(getMuxHome());
  const existing = await lockfile.read();
  if (existing) {
    console.error(`Error: mux API server is already running at ${existing.baseUrl}`);
    console.error(`Use 'mux api' commands to interact with the running instance.`);
    process.exit(1);
  }

  const config = new Config();
  const serviceContainer = new ServiceContainer(config);
  await serviceContainer.initialize();
  serviceContainer.windowService.setMainWindow(mockWindow);

  if (ADD_PROJECT_PATH) {
    await initializeProjectDirect(ADD_PROJECT_PATH, serviceContainer);
  }

  // Set launch project path for clients
  serviceContainer.serverService.setLaunchProject(launchProjectPath);

  // Set SSH host for editor deep links (CLI > env > config file)
  const sshHost = CLI_SSH_HOST ?? process.env.MUX_SSH_HOST ?? config.getServerSshHost();
  serviceContainer.serverService.setSshHost(sshHost);

  // Build oRPC context from services
  const context: ORPCContext = {
    config: serviceContainer.config,
    aiService: serviceContainer.aiService,
    projectService: serviceContainer.projectService,
    workspaceService: serviceContainer.workspaceService,
    providerService: serviceContainer.providerService,
    terminalService: serviceContainer.terminalService,
    editorService: serviceContainer.editorService,
    windowService: serviceContainer.windowService,
    updateService: serviceContainer.updateService,
    tokenizerService: serviceContainer.tokenizerService,
    serverService: serviceContainer.serverService,
    menuEventService: serviceContainer.menuEventService,
    mcpConfigService: serviceContainer.mcpConfigService,
    featureFlagService: serviceContainer.featureFlagService,
    sessionTimingService: serviceContainer.sessionTimingService,
    mcpServerManager: serviceContainer.mcpServerManager,
    voiceService: serviceContainer.voiceService,
    telemetryService: serviceContainer.telemetryService,
    experimentsService: serviceContainer.experimentsService,
    sessionUsageService: serviceContainer.sessionUsageService,
  };

  const server = await createOrpcServer({
    host: HOST,
    port: PORT,
    authToken: AUTH_TOKEN,
    context,
    serveStatic: true,
  });

  // Acquire lockfile so other instances know we're running
  await lockfile.acquire(server.baseUrl, AUTH_TOKEN ?? "");

  console.log(`Server is running on ${server.baseUrl}`);

  // Cleanup on shutdown
  let cleanupInProgress = false;
  const cleanup = async () => {
    if (cleanupInProgress) return;
    cleanupInProgress = true;

    console.log("Shutting down server...");

    // Force exit after timeout if cleanup hangs
    const forceExitTimer = setTimeout(() => {
      console.log("Cleanup timed out, forcing exit...");
      process.exit(1);
    }, 5000);

    try {
      // Close all PTY sessions first (these are the "sub-processes" nodemon sees)
      serviceContainer.terminalService.closeAllSessions();

      // Dispose background processes
      await serviceContainer.dispose();

      // Release lockfile and close server
      await lockfile.release();
      await server.close();

      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (err) {
      console.error("Cleanup error:", err);
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());
})().catch((error) => {
  console.error("Failed to initialize server:", error);
  process.exit(1);
});

async function initializeProjectDirect(
  projectPath: string,
  serviceContainer: ServiceContainer
): Promise<void> {
  try {
    let normalizedPath = projectPath.replace(/\/+$/, "");
    const validation = await validateProjectPath(normalizedPath);
    if (!validation.valid || !validation.expandedPath) {
      console.error(
        `Invalid project path provided via --add-project: ${validation.error ?? "unknown error"}`
      );
      return;
    }
    normalizedPath = validation.expandedPath;

    const projects = serviceContainer.projectService.list();
    const alreadyExists = Array.isArray(projects)
      ? projects.some(([path]) => path === normalizedPath)
      : false;

    if (alreadyExists) {
      console.log(`Project already exists: ${normalizedPath}`);
      launchProjectPath = normalizedPath;
      return;
    }

    console.log(`Creating project via --add-project: ${normalizedPath}`);
    const result = await serviceContainer.projectService.create(normalizedPath);
    if (result.success) {
      console.log(`Project created at ${normalizedPath}`);
      launchProjectPath = normalizedPath;
    } else {
      const errorMsg =
        typeof result.error === "string"
          ? result.error
          : JSON.stringify(result.error ?? "unknown error");
      console.error(`Failed to create project at ${normalizedPath}: ${errorMsg}`);
    }
  } catch (error) {
    console.error(`initializeProject failed for ${projectPath}:`, error);
  }
}
