/**
 * CLI entry point for the mux oRPC server.
 * Uses createOrpcServer from ./orpcServer.ts for the actual server logic.
 */
import { Config } from "@/node/config";
import { ServiceContainer } from "@/node/services/serviceContainer";
import { migrateLegacyMuxHome } from "@/common/constants/paths";
import type { BrowserWindow } from "electron";
import { Command } from "commander";
import { validateProjectPath } from "@/node/utils/pathUtils";
import { createOrpcServer } from "./orpcServer";
import type { ORPCContext } from "@/node/orpc/context";

const program = new Command();
program
  .name("mux-server")
  .description("HTTP/WebSocket ORPC server for mux")
  .option("-h, --host <host>", "bind to specific host", "localhost")
  .option("-p, --port <port>", "bind to specific port", "3000")
  .option("--auth-token <token>", "optional bearer token for HTTP/WS auth")
  .option("--add-project <path>", "add and open project at the specified path (idempotent)")
  .parse(process.argv);

const options = program.opts();
const HOST = options.host as string;
const PORT = Number.parseInt(String(options.port), 10);
const rawAuthToken = (options.authToken as string | undefined) ?? process.env.MUX_SERVER_AUTH_TOKEN;
const AUTH_TOKEN = rawAuthToken?.trim() ? rawAuthToken.trim() : undefined;
const ADD_PROJECT_PATH = options.addProject as string | undefined;

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

  const config = new Config();
  const serviceContainer = new ServiceContainer(config);
  await serviceContainer.initialize();
  serviceContainer.windowService.setMainWindow(mockWindow);

  if (ADD_PROJECT_PATH) {
    await initializeProjectDirect(ADD_PROJECT_PATH, serviceContainer);
  }

  // Set launch project path for clients
  serviceContainer.serverService.setLaunchProject(launchProjectPath);

  // Build oRPC context from services
  const context: ORPCContext = {
    projectService: serviceContainer.projectService,
    workspaceService: serviceContainer.workspaceService,
    providerService: serviceContainer.providerService,
    terminalService: serviceContainer.terminalService,
    windowService: serviceContainer.windowService,
    updateService: serviceContainer.updateService,
    tokenizerService: serviceContainer.tokenizerService,
    serverService: serviceContainer.serverService,
    menuEventService: serviceContainer.menuEventService,
    voiceService: serviceContainer.voiceService,
  };

  const server = await createOrpcServer({
    host: HOST,
    port: PORT,
    authToken: AUTH_TOKEN,
    context,
    serveStatic: true,
  });

  console.log(`Server is running on ${server.baseUrl}`);
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
