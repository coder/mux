import type { IPCApi } from "./ipc";

// Our simplified permission modes for UI
export type UIPermissionMode = "plan" | "edit";

// Claude SDK permission modes
export type SDKPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

declare global {
  interface Window {
    api: IPCApi & {
      platform: string;
      versions: {
        node: string;
        chrome: string;
        electron: string;
      };
    };
  }
}

export {};
