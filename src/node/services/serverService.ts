import { createOrpcServer, type OrpcServer, type OrpcServerOptions } from "@/node/orpc/server";
import { ServerLockfile } from "./serverLockfile";
import type { ORPCContext } from "@/node/orpc/context";
import type { AppRouter } from "@/node/orpc/router";

export interface ServerInfo {
  baseUrl: string;
  token: string;
}

export interface StartServerOptions {
  /** Path to mux home directory (for lockfile) */
  muxHome: string;
  /** oRPC context with services */
  context: ORPCContext;
  /** Auth token for the server */
  authToken: string;
  /** Port to bind to (0 = random) */
  port?: number;
  /** Optional pre-created router (if not provided, creates router(authToken)) */
  router?: AppRouter;
  /** Whether to serve static files */
  serveStatic?: boolean;
}

export class ServerService {
  private launchProjectPath: string | null = null;
  private server: OrpcServer | null = null;
  private lockfile: ServerLockfile | null = null;
  private serverInfo: ServerInfo | null = null;

  /**
   * Set the launch project path
   */
  setLaunchProject(path: string | null): void {
    this.launchProjectPath = path;
  }

  /**
   * Get the launch project path
   */
  getLaunchProject(): Promise<string | null> {
    return Promise.resolve(this.launchProjectPath);
  }

  /**
   * Start the HTTP/WS API server.
   *
   * @throws Error if a server is already running (check lockfile first)
   */
  async startServer(options: StartServerOptions): Promise<ServerInfo> {
    if (this.server) {
      throw new Error("Server already running in this process");
    }

    // Create lockfile instance for checking - don't store yet
    const lockfile = new ServerLockfile(options.muxHome);

    // Check for existing server (another process)
    const existing = await lockfile.read();
    if (existing) {
      throw new Error(
        `Another mux server is already running at ${existing.baseUrl} (PID: ${existing.pid})`
      );
    }

    // Create the server (Electron always binds to 127.0.0.1)
    const serverOptions: OrpcServerOptions = {
      host: "127.0.0.1",
      port: options.port ?? 0,
      context: options.context,
      authToken: options.authToken,
      router: options.router,
      serveStatic: options.serveStatic ?? false,
    };

    const server = await createOrpcServer(serverOptions);

    // Acquire the lockfile - clean up server if this fails
    try {
      await lockfile.acquire(server.baseUrl, options.authToken);
    } catch (err) {
      await server.close();
      throw err;
    }

    // Only store references after successful acquisition - ensures stopServer
    // won't delete another process's lockfile if we failed before acquiring
    this.lockfile = lockfile;
    this.server = server;
    this.serverInfo = {
      baseUrl: this.server.baseUrl,
      token: options.authToken,
    };

    return this.serverInfo;
  }

  /**
   * Stop the HTTP/WS API server and release the lockfile.
   */
  async stopServer(): Promise<void> {
    if (this.lockfile) {
      await this.lockfile.release();
      this.lockfile = null;
    }
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
    this.serverInfo = null;
  }

  /**
   * Get information about the running server.
   * Returns null if no server is running in this process.
   */
  getServerInfo(): ServerInfo | null {
    return this.serverInfo;
  }

  /**
   * Check if a server is running in this process.
   */
  isServerRunning(): boolean {
    return this.server !== null;
  }
}
