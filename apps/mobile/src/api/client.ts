import Constants from "expo-constants";
import { assert } from "../utils/assert";
import type {
  FrontendWorkspaceMetadata,
  ProjectsListResponse,
  WorkspaceChatEvent,
  Secret,
} from "../types";

export type Result<T, E = string> = { success: true; data: T } | { success: false; error: E };

export interface SendMessageOptions {
  model: string;
  [key: string]: unknown;
}

export interface CmuxMobileClientConfig {
  baseUrl?: string; // http://host:3000
  authToken?: string;
}

const IPC_CHANNELS = {
  WORKSPACE_LIST: "workspace:list",
  WORKSPACE_SEND_MESSAGE: "workspace:sendMessage",
  WORKSPACE_INTERRUPT_STREAM: "workspace:interruptStream",
  WORKSPACE_GET_INFO: "workspace:getInfo",
  PROJECT_LIST: "project:list",
  PROJECT_SECRETS_GET: "project:secrets:get",
  PROJECT_SECRETS_UPDATE: "project:secrets:update",
  WORKSPACE_CHAT_PREFIX: "workspace:chat:",
  WORKSPACE_CHAT_SUBSCRIBE: "workspace:chat",
  WORKSPACE_METADATA: "workspace:metadata",
  WORKSPACE_METADATA_SUBSCRIBE: "workspace:metadata",
  WORKSPACE_METADATA_ACK: "workspace:metadata:subscribe",
} as const;

type InvokeResponse<T> = { success: true; data: T } | { success: false; error: string };

type WebSocketSubscription = { ws: WebSocket; close: () => void };

type JsonRecord = Record<string, unknown>;

function pickBaseUrl(): string {
  const extra = (Constants.expoConfig?.extra as JsonRecord | undefined)?.cmux as
    | JsonRecord
    | undefined;
  const configured = typeof extra?.baseUrl === "string" ? extra.baseUrl : undefined;
  return (configured ?? "http://localhost:3000").replace(/\/$/, "");
}

function pickToken(): string | undefined {
  const extra = (Constants.expoConfig?.extra as JsonRecord | undefined)?.cmux as
    | JsonRecord
    | undefined;
  const rawToken = typeof extra?.authToken === "string" ? extra.authToken : undefined;
  if (!rawToken) {
    return undefined;
  }
  const trimmed = rawToken.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureWorkspaceId(id: string): string {
  assert(typeof id === "string", "workspaceId must be a string");
  const trimmed = id.trim();
  assert(trimmed.length > 0, "workspaceId must not be empty");
  return trimmed;
}

export function createClient(cfg: CmuxMobileClientConfig = {}) {
  const baseUrl = (cfg.baseUrl ?? pickBaseUrl()).replace(/\/$/, "");
  const authToken = cfg.authToken ?? pickToken();

  async function invoke<T = unknown>(channel: string, args: unknown[] = []): Promise<T> {
    const response = await fetch(`${baseUrl}/ipc/${encodeURIComponent(channel)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ args }),
    });

    const payload = (await response.json()) as InvokeResponse<T> | undefined;
    if (!payload || typeof payload !== "object") {
      throw new Error(`Unexpected response for channel ${channel}`);
    }

    if (payload.success) {
      return payload.data as T;
    }

    const message = typeof payload.error === "string" ? payload.error : "Request failed";
    throw new Error(message);
  }

  function makeWebSocketUrl(): string {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    if (authToken) {
      url.searchParams.set("token", authToken);
    }
    return url.toString();
  }

  function subscribe(
    payload: JsonRecord,
    handleMessage: (data: JsonRecord) => void
  ): WebSocketSubscription {
    const ws = new WebSocket(makeWebSocketUrl());

    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (isJsonRecord(data)) {
          handleMessage(data);
        }
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("Failed to parse WebSocket message", error);
        }
      }
    };

    return {
      ws,
      close: () => {
        try {
          ws.close();
        } catch {
          // noop
        }
      },
    };
  }

  return {
    projects: {
      list: async (): Promise<ProjectsListResponse> => invoke(IPC_CHANNELS.PROJECT_LIST),
      secrets: {
        get: async (projectPath: string): Promise<Secret[]> =>
          invoke(IPC_CHANNELS.PROJECT_SECRETS_GET, [projectPath]),
        update: async (projectPath: string, secrets: Secret[]): Promise<Result<void, string>> => {
          try {
            await invoke(IPC_CHANNELS.PROJECT_SECRETS_UPDATE, [projectPath, secrets]);
            return { success: true, data: undefined };
          } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            return { success: false, error: err };
          }
        },
      },
    },
    workspace: {
      list: async (): Promise<FrontendWorkspaceMetadata[]> =>
        invoke(IPC_CHANNELS.WORKSPACE_LIST),
      getInfo: async (workspaceId: string): Promise<FrontendWorkspaceMetadata | null> =>
        invoke(IPC_CHANNELS.WORKSPACE_GET_INFO, [ensureWorkspaceId(workspaceId)]),
      interruptStream: async (workspaceId: string): Promise<Result<void, string>> => {
        try {
          await invoke(IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM, [ensureWorkspaceId(workspaceId)]);
          return { success: true, data: undefined };
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          return { success: false, error: err };
        }
      },
      sendMessage: async (
        workspaceId: string,
        message: string,
        options: SendMessageOptions
      ): Promise<Result<void, string>> => {
        try {
          assert(typeof message === "string" && message.trim().length > 0, "message required");
          
          // Fire and forget - don't wait for response
          // The stream-start event will arrive via WebSocket if successful
          // Errors will come via stream-error WebSocket events, not HTTP response
          void invoke<unknown>(
            IPC_CHANNELS.WORKSPACE_SEND_MESSAGE,
            [ensureWorkspaceId(workspaceId), message, options]
          ).catch(() => {
            // Silently ignore HTTP errors - stream-error events handle actual failures
            // The server may return before stream completes, causing spurious errors
          });
          
          // Immediately return success - actual errors will come via stream-error events
          return { success: true, data: undefined };
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          console.error('[sendMessage] Validation error:', err);
          return { success: false, error: err };
        }
      },
      subscribeChat: (
        workspaceId: string,
        onEvent: (event: WorkspaceChatEvent) => void
      ): WebSocketSubscription => {
        const trimmedId = ensureWorkspaceId(workspaceId);
        const subscription = subscribe(
          {
            type: "subscribe",
            channel: IPC_CHANNELS.WORKSPACE_CHAT_SUBSCRIBE,
            workspaceId: trimmedId,
          },
          (data) => {
            const channel = typeof data.channel === "string" ? data.channel : undefined;
            const args = Array.isArray(data.args) ? data.args : [];

            if (!channel || !channel.startsWith(IPC_CHANNELS.WORKSPACE_CHAT_PREFIX)) {
              return;
            }

            const channelWorkspaceId = channel.replace(IPC_CHANNELS.WORKSPACE_CHAT_PREFIX, "");
            if (channelWorkspaceId !== trimmedId) {
              return;
            }

            const [firstArg] = args;
            if (firstArg) {
              onEvent(firstArg as WorkspaceChatEvent);
            }
          }
        );

        return subscription;
      },
      subscribeMetadata: (
        onMetadata: (payload: { workspaceId: string; metadata: FrontendWorkspaceMetadata }) => void
      ): WebSocketSubscription =>
        subscribe(
          { type: "subscribe", channel: IPC_CHANNELS.WORKSPACE_METADATA_SUBSCRIBE },
          (data) => {
            if (data.channel !== IPC_CHANNELS.WORKSPACE_METADATA) {
              return;
            }
            const args = Array.isArray(data.args) ? data.args : [];
            const [firstArg] = args;
            if (!isJsonRecord(firstArg)) {
              return;
            }
            const workspaceId = typeof firstArg.workspaceId === "string" ? firstArg.workspaceId : null;
            const metadataRaw = isJsonRecord(firstArg.metadata) ? firstArg.metadata : null;
            if (!workspaceId || !metadataRaw) {
              return;
            }
            const metadata: FrontendWorkspaceMetadata = {
              id: typeof metadataRaw.id === "string" ? metadataRaw.id : workspaceId,
              name: typeof metadataRaw.name === "string" ? metadataRaw.name : workspaceId,
              projectName: typeof metadataRaw.projectName === "string" ? metadataRaw.projectName : "",
              projectPath: typeof metadataRaw.projectPath === "string" ? metadataRaw.projectPath : "",
              namedWorkspacePath:
                typeof metadataRaw.namedWorkspacePath === "string"
                  ? metadataRaw.namedWorkspacePath
                  : typeof metadataRaw.workspacePath === "string"
                  ? metadataRaw.workspacePath
                  : "",
              createdAt: typeof metadataRaw.createdAt === "string" ? metadataRaw.createdAt : undefined,
              runtimeConfig: isJsonRecord(metadataRaw.runtimeConfig)
                ? (metadataRaw.runtimeConfig as Record<string, unknown>)
                : undefined,
            };

            if (
              metadata.projectName.length === 0 ||
              metadata.projectPath.length === 0 ||
              metadata.namedWorkspacePath.length === 0
            ) {
              return;
            }

            onMetadata({ workspaceId, metadata });
          }
        ),
    },
  } as const;
}
