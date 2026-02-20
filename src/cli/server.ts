/**
 * CLI entry point for the mux oRPC server.
 * Uses ServerService for server lifecycle management.
 */
import { Config } from "@/node/config";
import { ServiceContainer } from "@/node/services/serviceContainer";
import { setOpenSSHHostKeyPolicyMode } from "@/node/runtime/sshConnectionPool";
import { getMuxHome, migrateLegacyMuxHome } from "@/common/constants/paths";
import { ServerLockfile } from "@/node/services/serverLockfile";
import type { BrowserWindow } from "electron";
import { Command } from "commander";
import { validateProjectPath } from "@/node/utils/pathUtils";
import { VERSION } from "@/version";
import { getParseOptions } from "./argv";
import { resolveServerAuthToken } from "./serverAuthToken";

const program = new Command();
program
  .name("mux server")
  .description("HTTP/WebSocket ORPC server for mux")
  .option("-h, --host <host>", "bind to specific host", "localhost")
  .option("-p, --port <port>", "bind to specific port", "3000")
  .option("--auth-token <token>", "bearer token for HTTP/WS auth (default: auto-generated)")
  .option("--no-auth", "disable authentication (server is open to anyone who can reach it)")
  .option("--print-auth-token", "always print the auth token on startup")
  .option(
    "--allow-http-origin",
    "allow HTTPS origins when TLS is terminated by a proxy that forwards X-Forwarded-Proto=http"
  )
  .option("--ssh-host <host>", "SSH hostname/alias for editor deep links (e.g., devbox)")
  .option("--add-project <path>", "add and open project at the specified path (idempotent)")
  .parse(process.argv, getParseOptions());

const options = program.opts();
const HOST = options.host as string;
const PORT = Number.parseInt(String(options.port), 10);
const resolved = resolveServerAuthToken({
  noAuth: options.noAuth === true || options.auth === false,
  cliToken: options.authToken as string | undefined,
  envToken: process.env.MUX_SERVER_AUTH_TOKEN,
});
const ADD_PROJECT_PATH = options.addProject as string | undefined;
// HTTPS-terminating proxy compatibility is opt-in so local/default deployments stay strict.
const ALLOW_HTTP_ORIGIN = options.allowHttpOrigin === true;
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
  // Keepalive interval to prevent premature process exit during async initialization.
  // During startup, taskService.initialize() may resume running tasks by calling
  // sendMessage(), which spawns background AI streams. Between the completion of
  // serviceContainer.initialize() and the HTTP server starting to listen, there can
  // be a brief moment where no ref'd handles exist, causing Node to exit with code 0.
  // This interval ensures the event loop stays alive until the server is listening.
  const startupKeepalive = setInterval(() => {
    // Intentionally empty - keeps event loop alive during startup
  }, 1000);

  migrateLegacyMuxHome();

  // Early lockfile check: detect an existing server BEFORE initializing services.
  // serviceContainer.initialize() resumes queued/running tasks (via TaskService),
  // so we must fail fast here to avoid orphaned side effects when another server
  // already holds the lock. ServerService.startServer() re-checks as defense-in-depth.
  const muxHome = getMuxHome();
  const earlyLockfile = new ServerLockfile(muxHome);
  const existing = await earlyLockfile.read();
  if (existing) {
    console.error(`Error: mux API server is already running at ${existing.baseUrl}`);
    console.error(`Use 'mux api' commands to interact with the running instance.`);
    process.exit(1);
  }

  const config = new Config();
  const serviceContainer = new ServiceContainer(config);
  // Headless server has no interactive host-key dialog
  setOpenSSHHostKeyPolicyMode("headless-fallback");
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

  const context = serviceContainer.toORPCContext();

  // Start server via ServerService (handles lockfile, mDNS, network URLs)
  const serverInfo = await serviceContainer.serverService.startServer({
    muxHome: serviceContainer.config.rootDir,
    context,
    host: HOST,
    port: PORT,
    authToken: resolved.token,
    serveStatic: true,
    allowHttpOrigin: ALLOW_HTTP_ORIGIN,
  });

  // Server is now listening - clear the startup keepalive since httpServer keeps the loop alive
  clearInterval(startupKeepalive);

  // --- Startup output ---
  console.log(`\nmux server v${VERSION.git_describe}`);
  console.log(`  URL:  ${serverInfo.baseUrl}`);
  if (serverInfo.networkBaseUrls.length > 0) {
    for (const url of serverInfo.networkBaseUrls) {
      console.log(`  LAN:  ${url}`);
    }
  }
  console.log(`  Docs: ${serverInfo.baseUrl}/api/docs`);

  if (resolved.mode === "disabled") {
    console.warn(
      "\nWARNING: Authentication is DISABLED (--no-auth). The server is open to anyone who can reach it."
    );
  } else {
    console.log(`\n  Auth: enabled (token source: ${resolved.source})`);

    // Use a LAN-reachable URL for remote connection instructions when available,
    // since baseUrl is loopback (127.0.0.1) even when binding to 0.0.0.0.
    const remoteUrl =
      serverInfo.networkBaseUrls.length > 0 ? serverInfo.networkBaseUrls[0] : serverInfo.baseUrl;

    if (serverInfo.networkBaseUrls.length > 0) {
      console.log(`\n  # Connect from another machine:`);
      console.log(`  export MUX_SERVER_URL=${remoteUrl}`);
    }

    // Avoid logging user-supplied long-lived credentials by default.
    const shouldPrintSensitiveToken =
      options.printAuthToken === true || resolved.source === "generated";
    if (shouldPrintSensitiveToken) {
      // Shell-quote the token to handle metacharacters ($, &, spaces, etc.)
      const shellToken = `'${resolved.token.replace(/'/g, "'\\''")}'`;
      const urlToken = encodeURIComponent(resolved.token);

      console.log(`  export MUX_SERVER_AUTH_TOKEN=${shellToken}`);
      console.log(`\n  # Open in browser:`);
      console.log(`  ${remoteUrl}/?token=${urlToken}`);
    } else {
      console.log(`\n  # Token is not printed by default for CLI/env-provided credentials.`);
      console.log(`  # Pass --print-auth-token to print it in this terminal.`);
    }

    const lockfilePath = serviceContainer.serverService.getLockfilePath();
    if (lockfilePath) {
      console.log(`\n  Token stored in: ${lockfilePath}`);
    }
  }
  console.log(""); // blank line

  if (ALLOW_HTTP_ORIGIN) {
    console.warn(
      "NOTE: --allow-http-origin is enabled. Use it only when HTTPS is terminated by an upstream proxy that forwards X-Forwarded-Proto=http."
    );
    console.log(""); // blank line
  }

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
      // Close all PTY sessions first
      serviceContainer.terminalService.closeAllSessions();

      // Dispose background processes
      await serviceContainer.dispose();

      // Stop server (releases lockfile, stops mDNS, closes HTTP server)
      await serviceContainer.serverService.stopServer();

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
