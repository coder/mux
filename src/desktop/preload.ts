/**
 * Electron Preload Script with Bundled Constants
 *
 * This file demonstrates a sophisticated solution to a complex problem in Electron development:
 * how to share constants between main and preload processes while respecting Electron's security
 * sandbox restrictions. The challenge is that preload scripts run in a heavily sandboxed environment
 * where they cannot import custom modules using standard Node.js `require()` or ES6 `import` syntax.
 *
 * Our solution uses Bun's bundler with the `--external=electron` flag to create a hybrid approach:
 * 1) Constants from `./constants/ipc-constants.ts` are inlined directly into this compiled script
 * 2) The `electron` module remains external and is safely required at runtime by Electron's sandbox
 * 3) This gives us a single source of truth for IPC constants while avoiding the fragile text
 *    parsing and complex inline replacement scripts that other approaches require.
 *
 * The build command `bun build src/preload.ts --format=cjs --target=node --external=electron --outfile=dist/preload.js`
 * produces a self-contained script where IPC_CHANNELS, getOutputChannel, and getClearChannel are
 * literal values with no runtime imports needed, while contextBridge and ipcRenderer remain as
 * clean `require("electron")` calls that work perfectly in the sandbox environment.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { IPCApi, WorkspaceChatMessage, UpdateStatus } from "@/common/types/ipc";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";
import { IPC_CHANNELS, getChatChannel } from "@/common/constants/ipc-constants";

// Build the API implementation using the shared interface
const api: IPCApi = {
  tokenizer: {
    countTokens: (model, text) =>
      ipcRenderer.invoke(IPC_CHANNELS.TOKENIZER_COUNT_TOKENS, model, text),
    countTokensBatch: (model, texts) =>
      ipcRenderer.invoke(IPC_CHANNELS.TOKENIZER_COUNT_TOKENS_BATCH, model, texts),
    calculateStats: (messages, model) =>
      ipcRenderer.invoke(IPC_CHANNELS.TOKENIZER_CALCULATE_STATS, messages, model),
  },
  providers: {
    setProviderConfig: (provider, keyPath, value) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_SET_CONFIG, provider, keyPath, value),
    setModels: (provider, models) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_SET_MODELS, provider, models),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_GET_CONFIG),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROVIDERS_LIST),
  },
  fs: {
    listDirectory: (root: string) => ipcRenderer.invoke(IPC_CHANNELS.FS_LIST_DIRECTORY, root),
  },
  projects: {
    create: (projectPath) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, projectPath),
    pickDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_PICK_DIRECTORY),
    remove: (projectPath) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REMOVE, projectPath),
    list: (): Promise<Array<[string, ProjectConfig]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),
    listBranches: (projectPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST_BRANCHES, projectPath),
    secrets: {
      get: (projectPath) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SECRETS_GET, projectPath),
      update: (projectPath, secrets) =>
        ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SECRETS_UPDATE, projectPath, secrets),
    },
  },
  workspace: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),
    create: (projectPath, branchName, trunkBranch: string, runtimeConfig?) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.WORKSPACE_CREATE,
        projectPath,
        branchName,
        trunkBranch,
        runtimeConfig
      ),
    remove: (workspaceId: string, options?: { force?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, workspaceId, options),
    rename: (workspaceId: string, newName: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_RENAME, workspaceId, newName),
    fork: (sourceWorkspaceId: string, newName: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_FORK, sourceWorkspaceId, newName),
    sendMessage: (workspaceId, message, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SEND_MESSAGE, workspaceId, message, options),
    resumeStream: (workspaceId, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_RESUME_STREAM, workspaceId, options),
    interruptStream: (workspaceId: string, options?: { abandonPartial?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM, workspaceId, options),
    clearQueue: (workspaceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CLEAR_QUEUE, workspaceId),
    truncateHistory: (workspaceId, percentage) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_TRUNCATE_HISTORY, workspaceId, percentage),
    replaceChatHistory: (workspaceId, summaryMessage) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REPLACE_HISTORY, workspaceId, summaryMessage),
    getInfo: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_INFO, workspaceId),
    executeBash: (workspaceId, script, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_EXECUTE_BASH, workspaceId, script, options),
    openTerminal: (workspaceId) => {
      return ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN_TERMINAL, workspaceId);
    },

    onChat: (workspaceId: string, callback) => {
      const channel = getChatChannel(workspaceId);
      const handler = (_event: unknown, data: WorkspaceChatMessage) => {
        callback(data);
      };

      // Subscribe to the channel
      ipcRenderer.on(channel, handler);

      // Send subscription request with workspace ID as parameter
      // This allows main process to fetch history for the specific workspace
      ipcRenderer.send(`workspace:chat:subscribe`, workspaceId);

      return () => {
        ipcRenderer.removeListener(channel, handler);
        ipcRenderer.send(`workspace:chat:unsubscribe`, workspaceId);
      };
    },
    onMetadata: (
      callback: (data: { workspaceId: string; metadata: FrontendWorkspaceMetadata }) => void
    ) => {
      const handler = (
        _event: unknown,
        data: { workspaceId: string; metadata: FrontendWorkspaceMetadata }
      ) => callback(data);

      // Subscribe to metadata events
      ipcRenderer.on(IPC_CHANNELS.WORKSPACE_METADATA, handler);

      // Request current metadata state - consistent subscription pattern
      ipcRenderer.send(`workspace:metadata:subscribe`);

      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.WORKSPACE_METADATA, handler);
        ipcRenderer.send(`workspace:metadata:unsubscribe`);
      };
    },
    activity: {
      list: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ACTIVITY_LIST),
      subscribe: (
        callback: (payload: {
          workspaceId: string;
          activity: WorkspaceActivitySnapshot | null;
        }) => void
      ) => {
        const handler = (
          _event: unknown,
          data: { workspaceId: string; activity: WorkspaceActivitySnapshot | null }
        ) => callback(data);

        ipcRenderer.on(IPC_CHANNELS.WORKSPACE_ACTIVITY, handler);
        ipcRenderer.send(IPC_CHANNELS.WORKSPACE_ACTIVITY_SUBSCRIBE);

        return () => {
          ipcRenderer.removeListener(IPC_CHANNELS.WORKSPACE_ACTIVITY, handler);
          ipcRenderer.send(IPC_CHANNELS.WORKSPACE_ACTIVITY_UNSUBSCRIBE);
        };
      },
    },
  },
  window: {
    setTitle: (title: string) => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_TITLE, title),
  },
  voice: {
    transcribe: (audioBase64: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRANSCRIBE, audioBase64),
  },
  update: {
    check: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),
    install: () => {
      void ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL);
    },
    onStatus: (callback: (status: UpdateStatus) => void) => {
      const handler = (_event: unknown, status: UpdateStatus) => {
        callback(status);
      };

      // Subscribe to status updates
      ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, handler);

      // Request current status - consistent subscription pattern
      ipcRenderer.send(IPC_CHANNELS.UPDATE_STATUS_SUBSCRIBE);

      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATUS, handler);
      };
    },
  },
  terminal: {
    create: (params) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, params),
    close: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CLOSE, sessionId),
    resize: (params) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, params),
    sendInput: (sessionId: string, data: string) => {
      void ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_INPUT, sessionId, data);
    },
    onOutput: (sessionId: string, callback: (data: string) => void) => {
      const channel = `terminal:output:${sessionId}`;
      const handler = (_event: unknown, data: string) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onExit: (sessionId: string, callback: (exitCode: number) => void) => {
      const channel = `terminal:exit:${sessionId}`;
      const handler = (_event: unknown, exitCode: number) => callback(exitCode);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    openWindow: (workspaceId: string) => {
      console.log(
        `[Preload] terminal.openWindow called with workspaceId: ${workspaceId}, channel: ${IPC_CHANNELS.TERMINAL_WINDOW_OPEN}`
      );
      return ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WINDOW_OPEN, workspaceId);
    },
    closeWindow: (workspaceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WINDOW_CLOSE, workspaceId),
  },
  menu: {
    onOpenSettings: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.MENU_OPEN_SETTINGS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_OPEN_SETTINGS, handler);
    },
  },
};

// Expose the API along with platform/versions
contextBridge.exposeInMainWorld("api", {
  ...api,
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
