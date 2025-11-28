/**
 * HTTP/WebSocket Server for mux
 * Allows accessing mux backend from mobile devices
 */
import { Config } from "@/node/config";
import { IPC_CHANNELS, getChatChannel } from "@/common/constants/ipc-constants";
import { IpcMain } from "@/node/services/ipcMain";
import { migrateLegacyMuxHome } from "@/common/constants/paths";
import cors from "cors";
import type { BrowserWindow, IpcMain as ElectronIpcMain } from "electron";
import express from "express";
import * as http from "http";
import * as path from "path";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import { Command } from "commander";
import { z } from "zod";
import { VERSION } from "@/version";
import { createAuthMiddleware, isWsAuthorized } from "@/server/auth";
import { validateProjectPath } from "@/node/utils/pathUtils";

const program = new Command();
program
  .name("mux-server")
  .description("HTTP/WebSocket server for mux - allows accessing mux backend from mobile devices")
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

class HttpIpcMainAdapter {
  private handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  private listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();

  constructor(private readonly app: express.Application) {}

  getHandler(
    channel: string
  ): ((event: unknown, ...args: unknown[]) => Promise<unknown>) | undefined {
    return this.handlers.get(channel);
  }

  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>): void {
    this.handlers.set(channel, handler);

    this.app.post(`/ipc/${encodeURIComponent(channel)}`, async (req, res) => {
      try {
        const schema = z.object({ args: z.array(z.unknown()).optional() });
        const body = schema.parse(req.body);
        const args: unknown[] = body.args ?? [];
        const result = await handler(null, ...args);

        if (
          result &&
          typeof result === "object" &&
          "success" in result &&
          result.success === false
        ) {
          res.json(result);
          return;
        }

        res.json({ success: true, data: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error in handler ${channel}:`, error);
        res.json({ success: false, error: message });
      }
    });
  }

  on(channel: string, handler: (event: unknown, ...args: unknown[]) => void): void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, []);
    }
    this.listeners.get(channel)!.push(handler);
  }

  send(channel: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(channel);
    if (handlers) {
      handlers.forEach((handler) => handler(null, ...args));
    }
  }
}

interface ClientSubscriptions {
  chatSubscriptions: Set<string>;
  metadataSubscription: boolean;
  activitySubscription: boolean;
}

class MockBrowserWindow {
  constructor(private readonly clients: Map<WebSocket, ClientSubscriptions>) {}

  webContents = {
    send: (channel: string, ...args: unknown[]) => {
      const message = JSON.stringify({ channel, args });
      this.clients.forEach((clientInfo, client) => {
        if (client.readyState !== WebSocket.OPEN) {
          return;
        }

        if (channel === IPC_CHANNELS.WORKSPACE_METADATA && clientInfo.metadataSubscription) {
          client.send(message);
        } else if (channel === IPC_CHANNELS.WORKSPACE_ACTIVITY && clientInfo.activitySubscription) {
          client.send(message);
        } else if (channel.startsWith(IPC_CHANNELS.WORKSPACE_CHAT_PREFIX)) {
          const workspaceId = channel.replace(IPC_CHANNELS.WORKSPACE_CHAT_PREFIX, "");
          if (clientInfo.chatSubscriptions.has(workspaceId)) {
            client.send(message);
          }
        } else {
          client.send(message);
        }
      });
    },
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const clients = new Map<WebSocket, ClientSubscriptions>();
const mockWindow = new MockBrowserWindow(clients);
const httpIpcMain = new HttpIpcMainAdapter(app);

function rawDataToString(rawData: RawData): string {
  if (typeof rawData === "string") {
    return rawData;
  }
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData).toString("utf-8");
  }
  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString("utf-8");
  }
  return (rawData as Buffer).toString("utf-8");
}

(async () => {
  migrateLegacyMuxHome();

  const config = new Config();
  const ipcMainService = new IpcMain(config);
  await ipcMainService.initialize();

  if (AUTH_TOKEN) {
    app.use("/ipc", createAuthMiddleware({ token: AUTH_TOKEN }));
  }

  httpIpcMain.handle("server:getLaunchProject", () => {
    return Promise.resolve(launchProjectPath);
  });

  ipcMainService.register(
    httpIpcMain as unknown as ElectronIpcMain,
    mockWindow as unknown as BrowserWindow
  );

  if (ADD_PROJECT_PATH) {
    void initializeProject(ADD_PROJECT_PATH, httpIpcMain);
  }

  app.use(express.static(path.join(__dirname, "..")));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/version", (_req, res) => {
    res.json({ ...VERSION, mode: "server" });
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/ipc") && !req.path.startsWith("/ws")) {
      res.sendFile(path.join(__dirname, "..", "index.html"));
    } else {
      next();
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  async function initializeProject(
    projectPath: string,
    ipcAdapter: HttpIpcMainAdapter
  ): Promise<void> {
    try {
      // Normalize path so project metadata matches desktop behavior
      let normalizedPath = projectPath.replace(/\/+$/, "");
      const validation = await validateProjectPath(normalizedPath);
      if (!validation.valid || !validation.expandedPath) {
        console.error(
          `Invalid project path provided via --add-project: ${validation.error ?? "unknown error"}`
        );
        return;
      }
      normalizedPath = validation.expandedPath;

      const listHandler = ipcAdapter.getHandler(IPC_CHANNELS.PROJECT_LIST);
      if (!listHandler) {
        console.error("PROJECT_LIST handler not found; cannot initialize project");
        return;
      }
      const projects = (await listHandler(null)) as Array<[string, unknown]> | undefined;
      const alreadyExists = Array.isArray(projects)
        ? projects.some(([path]) => path === normalizedPath)
        : false;

      if (alreadyExists) {
        console.log(`Project already exists: ${normalizedPath}`);
        launchProjectPath = normalizedPath;
        return;
      }

      console.log(`Creating project via --add-project: ${normalizedPath}`);
      const createHandler = ipcAdapter.getHandler(IPC_CHANNELS.PROJECT_CREATE);
      if (!createHandler) {
        console.error("PROJECT_CREATE handler not found; cannot add project");
        return;
      }
      const result = (await createHandler(null, normalizedPath)) as {
        success?: boolean;
        error?: unknown;
      } | void;
      if (result && typeof result === "object" && "success" in result) {
        if (result.success) {
          console.log(`Project created at ${normalizedPath}`);
          launchProjectPath = normalizedPath;
          return;
        }
        const errorMsg =
          result.error instanceof Error
            ? result.error.message
            : typeof result.error === "string"
              ? result.error
              : JSON.stringify(result.error ?? "unknown error");
        console.error(`Failed to create project at ${normalizedPath}: ${errorMsg}`);
        return;
      }

      console.log(`Project created at ${normalizedPath}`);
      launchProjectPath = normalizedPath;
    } catch (error) {
      console.error(`initializeProject failed for ${projectPath}:`, error);
    }
  }

  wss.on("connection", (ws, req) => {
    if (!isWsAuthorized(req, { token: AUTH_TOKEN })) {
      ws.close(1008, "Unauthorized");
      return;
    }

    const clientInfo: ClientSubscriptions = {
      chatSubscriptions: new Set(),
      metadataSubscription: false,
      activitySubscription: false,
    };
    clients.set(ws, clientInfo);

    ws.on("message", (rawData: RawData) => {
      try {
        const payload = rawDataToString(rawData);
        const message = JSON.parse(payload) as {
          type: string;
          channel: string;
          workspaceId?: string;
        };
        const { type, channel, workspaceId } = message;

        if (type === "subscribe") {
          if (channel === "workspace:chat" && workspaceId) {
            clientInfo.chatSubscriptions.add(workspaceId);

            // Replay history only to this specific WebSocket client (no broadcast)
            // The broadcast httpIpcMain.send() was designed for Electron's single-renderer model
            // and causes duplicate history + cross-client pollution in multi-client WebSocket mode
            void (async () => {
              const replayHandler = httpIpcMain.getHandler(
                IPC_CHANNELS.WORKSPACE_CHAT_GET_FULL_REPLAY
              );
              if (!replayHandler) {
                return;
              }
              try {
                const events = (await replayHandler(null, workspaceId)) as unknown[];
                const chatChannel = getChatChannel(workspaceId);
                for (const event of events) {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ channel: chatChannel, args: [event] }));
                  }
                }
              } catch (error) {
                console.error(`Failed to replay history for workspace ${workspaceId}:`, error);
              }
            })();
          } else if (channel === "workspace:metadata") {
            clientInfo.metadataSubscription = true;
            httpIpcMain.send(IPC_CHANNELS.WORKSPACE_METADATA_SUBSCRIBE);
          } else if (channel === "workspace:activity") {
            clientInfo.activitySubscription = true;
            httpIpcMain.send(IPC_CHANNELS.WORKSPACE_ACTIVITY_SUBSCRIBE);
          }
        } else if (type === "unsubscribe") {
          if (channel === "workspace:chat" && workspaceId) {
            clientInfo.chatSubscriptions.delete(workspaceId);
            httpIpcMain.send("workspace:chat:unsubscribe", workspaceId);
          } else if (channel === "workspace:metadata") {
            clientInfo.metadataSubscription = false;
            httpIpcMain.send(IPC_CHANNELS.WORKSPACE_METADATA_UNSUBSCRIBE);
          } else if (channel === "workspace:activity") {
            clientInfo.activitySubscription = false;
            httpIpcMain.send(IPC_CHANNELS.WORKSPACE_ACTIVITY_UNSUBSCRIBE);
          }
        }
      } catch (error) {
        console.error("Error handling WebSocket message:", error);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
  });
})().catch((error) => {
  console.error("Failed to initialize server:", error);
  process.exit(1);
});
