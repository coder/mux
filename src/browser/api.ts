/**
 * Browser API client. Used when running mux in server mode.
 */
import { IPC_CHANNELS, getChatChannel } from "@/common/constants/ipc-constants";
import type { IPCApi } from "@/common/types/ipc";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";

// Backend URL - defaults to same origin, but can be overridden via VITE_BACKEND_URL
// This allows frontend (Vite :8080) to connect to backend (:3000) in dev mode
const API_BASE = import.meta.env.VITE_BACKEND_URL ?? window.location.origin;
const WS_BASE = API_BASE.replace("http://", "ws://").replace("https://", "wss://");

interface InvokeResponse<T> {
  success: boolean;
  data?: T;
  error?: unknown; // Can be string or structured error object
}

// Helper function to invoke IPC handlers via HTTP
async function invokeIPC<T>(channel: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`${API_BASE}/ipc/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ args }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const result = (await response.json()) as InvokeResponse<T>;

  // Return the result as-is - let the caller handle success/failure
  // This matches the behavior of Electron's ipcRenderer.invoke() which doesn't throw on error
  if (!result.success) {
    return result as T;
  }

  // Success - unwrap and return the data
  return result.data as T;
}

function parseWorkspaceActivity(value: unknown): WorkspaceActivitySnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const recency =
    typeof record.recency === "number" && Number.isFinite(record.recency) ? record.recency : null;
  if (recency === null) {
    return null;
  }
  const streaming = record.streaming === true;
  const lastModel = typeof record.lastModel === "string" ? record.lastModel : null;
  return {
    recency,
    streaming,
    lastModel,
  };
}

// WebSocket connection manager
class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandlers = new Map<string, Set<(data: unknown) => void>>();
  private channelWorkspaceIds = new Map<string, string>(); // Track workspaceId for each channel
  private isConnecting = false;
  private shouldReconnect = true;

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    this.ws = new WebSocket(`${WS_BASE}/ws`);

    this.ws.onopen = () => {
      console.log("WebSocket connected");
      this.isConnecting = false;

      // Resubscribe to all channels with their workspace IDs
      for (const channel of this.messageHandlers.keys()) {
        const workspaceId = this.channelWorkspaceIds.get(channel);
        this.subscribe(channel, workspaceId);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as { channel: string; args: unknown[] };
        const { channel, args } = parsed;
        const handlers = this.messageHandlers.get(channel);
        if (handlers && args.length > 0) {
          handlers.forEach((handler) => handler(args[0]));
        }
      } catch (error) {
        console.error("Error handling WebSocket message:", error);
      }
    };

    this.ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      this.isConnecting = false;
    };

    this.ws.onclose = () => {
      console.log("WebSocket disconnected");
      this.isConnecting = false;
      this.ws = null;

      // Attempt to reconnect after a delay
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    };
  }

  subscribe(channel: string, workspaceId?: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (channel.startsWith(IPC_CHANNELS.WORKSPACE_CHAT_PREFIX)) {
        console.log(
          `[WebSocketManager] Subscribing to workspace chat for workspaceId: ${workspaceId ?? "undefined"}`
        );
        this.ws.send(
          JSON.stringify({
            type: "subscribe",
            channel: "workspace:chat",
            workspaceId,
          })
        );
      } else if (channel === IPC_CHANNELS.WORKSPACE_METADATA) {
        this.ws.send(
          JSON.stringify({
            type: "subscribe",
            channel: "workspace:metadata",
          })
        );
      } else if (channel === IPC_CHANNELS.WORKSPACE_ACTIVITY) {
        this.ws.send(
          JSON.stringify({
            type: "subscribe",
            channel: "workspace:activity",
          })
        );
      }
    }
  }

  unsubscribe(channel: string, workspaceId?: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (channel.startsWith(IPC_CHANNELS.WORKSPACE_CHAT_PREFIX)) {
        this.ws.send(
          JSON.stringify({
            type: "unsubscribe",
            channel: "workspace:chat",
            workspaceId,
          })
        );
      } else if (channel === IPC_CHANNELS.WORKSPACE_METADATA) {
        this.ws.send(
          JSON.stringify({
            type: "unsubscribe",
            channel: "workspace:metadata",
          })
        );
      } else if (channel === IPC_CHANNELS.WORKSPACE_ACTIVITY) {
        this.ws.send(
          JSON.stringify({
            type: "unsubscribe",
            channel: "workspace:activity",
          })
        );
      }
    }
  }

  on(channel: string, handler: (data: unknown) => void, workspaceId?: string): () => void {
    if (!this.messageHandlers.has(channel)) {
      this.messageHandlers.set(channel, new Set());
      // Store workspaceId for this channel (needed for reconnection)
      if (workspaceId) {
        this.channelWorkspaceIds.set(channel, workspaceId);
      }
      this.connect();
      this.subscribe(channel, workspaceId);
    }

    const handlers = this.messageHandlers.get(channel)!;
    handlers.add(handler);

    // Return unsubscribe function
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.messageHandlers.delete(channel);
        this.channelWorkspaceIds.delete(channel);
        this.unsubscribe(channel, workspaceId);
      }
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

const wsManager = new WebSocketManager();

// Create the Web API implementation
const webApi: IPCApi = {
  tokenizer: {
    countTokens: (model, text) => invokeIPC(IPC_CHANNELS.TOKENIZER_COUNT_TOKENS, model, text),
    countTokensBatch: (model, texts) =>
      invokeIPC(IPC_CHANNELS.TOKENIZER_COUNT_TOKENS_BATCH, model, texts),
    calculateStats: (messages, model) =>
      invokeIPC(IPC_CHANNELS.TOKENIZER_CALCULATE_STATS, messages, model),
  },
  fs: {
    listDirectory: (root) => invokeIPC(IPC_CHANNELS.FS_LIST_DIRECTORY, root),
  },
  providers: {
    setProviderConfig: (provider, keyPath, value) =>
      invokeIPC(IPC_CHANNELS.PROVIDERS_SET_CONFIG, provider, keyPath, value),
    list: () => invokeIPC(IPC_CHANNELS.PROVIDERS_LIST),
  },
  projects: {
    create: (projectPath) => invokeIPC(IPC_CHANNELS.PROJECT_CREATE, projectPath),
    pickDirectory: () => Promise.resolve(null),
    remove: (projectPath) => invokeIPC(IPC_CHANNELS.PROJECT_REMOVE, projectPath),
    list: () => invokeIPC(IPC_CHANNELS.PROJECT_LIST),
    listBranches: (projectPath) => invokeIPC(IPC_CHANNELS.PROJECT_LIST_BRANCHES, projectPath),
    secrets: {
      get: (projectPath) => invokeIPC(IPC_CHANNELS.PROJECT_SECRETS_GET, projectPath),
      update: (projectPath, secrets) =>
        invokeIPC(IPC_CHANNELS.PROJECT_SECRETS_UPDATE, projectPath, secrets),
    },
  },
  workspace: {
    list: () => invokeIPC(IPC_CHANNELS.WORKSPACE_LIST),
    create: (projectPath, branchName, trunkBranch) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_CREATE, projectPath, branchName, trunkBranch),
    remove: (workspaceId, options) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId, options),
    rename: (workspaceId, newName) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_RENAME, workspaceId, newName),
    fork: (sourceWorkspaceId, newName) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_FORK, sourceWorkspaceId, newName),
    sendMessage: (workspaceId, message, options) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_SEND_MESSAGE, workspaceId, message, options),
    resumeStream: (workspaceId, options) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_RESUME_STREAM, workspaceId, options),
    interruptStream: (workspaceId, options) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM, workspaceId, options),
    clearQueue: (workspaceId) => invokeIPC(IPC_CHANNELS.WORKSPACE_QUEUE_CLEAR, workspaceId),
    truncateHistory: (workspaceId, percentage) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_TRUNCATE_HISTORY, workspaceId, percentage),
    replaceChatHistory: (workspaceId, summaryMessage) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_REPLACE_HISTORY, workspaceId, summaryMessage),
    getInfo: (workspaceId) => invokeIPC(IPC_CHANNELS.WORKSPACE_GET_INFO, workspaceId),
    executeBash: (workspaceId, script, options) =>
      invokeIPC(IPC_CHANNELS.WORKSPACE_EXECUTE_BASH, workspaceId, script, options),
    openTerminal: (workspaceId) => invokeIPC(IPC_CHANNELS.WORKSPACE_OPEN_TERMINAL, workspaceId),
    activity: {
      list: async (): Promise<Record<string, WorkspaceActivitySnapshot>> => {
        const response = await invokeIPC<Record<string, unknown>>(
          IPC_CHANNELS.WORKSPACE_ACTIVITY_LIST
        );
        const result: Record<string, WorkspaceActivitySnapshot> = {};
        if (response && typeof response === "object") {
          for (const [workspaceId, value] of Object.entries(response)) {
            if (typeof workspaceId !== "string") {
              continue;
            }
            const parsed = parseWorkspaceActivity(value);
            if (parsed) {
              result[workspaceId] = parsed;
            }
          }
        }
        return result;
      },
      subscribe: (callback) =>
        wsManager.on(IPC_CHANNELS.WORKSPACE_ACTIVITY, (data) => {
          if (!data || typeof data !== "object") {
            return;
          }
          const record = data as { workspaceId?: string; activity?: unknown };
          if (typeof record.workspaceId !== "string") {
            return;
          }
          if (record.activity === null) {
            callback({ workspaceId: record.workspaceId, activity: null });
            return;
          }
          const activity = parseWorkspaceActivity(record.activity);
          if (!activity) {
            return;
          }
          callback({ workspaceId: record.workspaceId, activity });
        }),
    },

    onChat: (workspaceId, callback) => {
      const channel = getChatChannel(workspaceId);
      return wsManager.on(channel, callback as (data: unknown) => void, workspaceId);
    },

    onMetadata: (callback) => {
      const unsubscribe = wsManager.on(IPC_CHANNELS.WORKSPACE_METADATA, (data: unknown) => {
        callback(data as Parameters<typeof callback>[0]);
      });
      return unsubscribe;
    },
  },
  window: {
    setTitle: (title) => {
      document.title = title;
      return Promise.resolve();
    },
  },
  terminal: {
    create: (params) => invokeIPC(IPC_CHANNELS.TERMINAL_CREATE, params),
    close: (sessionId) => invokeIPC(IPC_CHANNELS.TERMINAL_CLOSE, sessionId),
    resize: (params) => invokeIPC(IPC_CHANNELS.TERMINAL_RESIZE, params),
    sendInput: (sessionId: string, data: string) => {
      // Send via IPC - in browser mode this becomes an HTTP POST
      void invokeIPC(IPC_CHANNELS.TERMINAL_INPUT, sessionId, data);
    },
    onOutput: (sessionId: string, callback: (data: string) => void) => {
      // Subscribe to terminal output events via WebSocket
      const channel = `terminal:output:${sessionId}`;
      return wsManager.on(channel, callback as (data: unknown) => void);
    },
    onExit: (sessionId: string, callback: (exitCode: number) => void) => {
      // Subscribe to terminal exit events via WebSocket
      const channel = `terminal:exit:${sessionId}`;
      return wsManager.on(channel, callback as (data: unknown) => void);
    },
    openWindow: (workspaceId) => {
      // In browser mode, always open terminal in a new browser window (for both local and SSH workspaces)
      // This must be synchronous to avoid popup blocker during user gesture
      const url = `/terminal.html?workspaceId=${encodeURIComponent(workspaceId)}`;
      window.open(url, `terminal-${workspaceId}-${Date.now()}`, "width=1000,height=600,popup=yes");

      // Also invoke IPC to let backend know (desktop mode will handle native/ghostty-web routing)
      return invokeIPC(IPC_CHANNELS.TERMINAL_WINDOW_OPEN, workspaceId);
    },
    closeWindow: (workspaceId) => invokeIPC(IPC_CHANNELS.TERMINAL_WINDOW_CLOSE, workspaceId),
  },
  update: {
    check: () => invokeIPC(IPC_CHANNELS.UPDATE_CHECK),
    download: () => invokeIPC(IPC_CHANNELS.UPDATE_DOWNLOAD),
    install: () => {
      // Install is a one-way call that doesn't wait for response
      void invokeIPC(IPC_CHANNELS.UPDATE_INSTALL);
    },
    onStatus: (callback) => {
      return wsManager.on(IPC_CHANNELS.UPDATE_STATUS, callback as (data: unknown) => void);
    },
  },
  server: {
    getLaunchProject: () => invokeIPC("server:getLaunchProject"),
  },
  // In browser mode, set platform to "browser" to differentiate from Electron
  platform: "browser" as const,
  versions: {},
};

if (typeof window.api === "undefined") {
  // @ts-expect-error - Assigning to window.api which is not in TypeScript types
  window.api = webApi;
}

window.addEventListener("beforeunload", () => {
  wsManager.disconnect();
});
