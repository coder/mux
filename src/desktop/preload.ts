/**
 * Electron Preload Script
 *
 * This script bridges the renderer process with the main process via ORPC over MessagePort.
 *
 * Key responsibilities:
 * 1) Forward MessagePort from renderer to main process for ORPC transport setup
 * 2) Expose minimal platform info to renderer via contextBridge
 *
 * The ORPC connection flow:
 * - Renderer creates MessageChannel, posts "start-orpc-client" with serverPort
 * - Preload intercepts, forwards serverPort to main via ipcRenderer.postMessage
 * - Main process upgrades the port with RPCHandler for bidirectional RPC
 *
 * Build: `bun build src/desktop/preload.ts --format=cjs --target=node --external=electron`
 */

import { contextBridge, ipcRenderer } from "electron";
import type { MuxDeepLinkPayload } from "@/common/types/deepLink";

// mux:// deep links can arrive before the React app subscribes.
// Buffer them here so the renderer can consume them on mount.
const pendingDeepLinks: MuxDeepLinkPayload[] = [];
const deepLinkSubscribers = new Set<(payload: MuxDeepLinkPayload) => void>();

ipcRenderer.on("mux:deep-link", (_event: unknown, payload: MuxDeepLinkPayload) => {
  if (deepLinkSubscribers.size === 0) {
    pendingDeepLinks.push(payload);
  }

  for (const subscriber of deepLinkSubscribers) {
    try {
      subscriber(payload);
    } catch (error) {
      // Best-effort: a renderer bug shouldn't break deep link delivery.
      console.debug("[deep-link] Renderer subscriber threw:", error);
    }
  }
});

// Forward ORPC MessagePort from renderer to main process
window.addEventListener("message", (event) => {
  if (event.data === "start-orpc-client" && event.ports?.[0]) {
    ipcRenderer.postMessage("start-orpc-server", null, [...event.ports]);
  }
});

contextBridge.exposeInMainWorld("api", {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  isE2E: process.env.MUX_E2E === "1",
  enableTelemetryInDev: process.env.MUX_ENABLE_TELEMETRY_IN_DEV === "1",
  // Note: When debugging LLM requests, we also want to see synthetic/request-only
  // messages in the chat history so the UI matches what was sent to the provider.
  debugLlmRequest: process.env.MUX_DEBUG_LLM_REQUEST === "1",
  // NOTE: This is intentionally async so the preload script does not rely on Node builtins
  // like `child_process` (which can break in hardened/sandboxed environments).
  getIsRosetta: () => ipcRenderer.invoke("mux:get-is-rosetta"),
  getIsWindowsWslShell: () => ipcRenderer.invoke("mux:get-is-windows-wsl-shell"),
  // Register a callback for notification clicks (navigates to workspace)
  // Returns an unsubscribe function.
  onNotificationClicked: (callback: (data: { workspaceId: string }) => void) => {
    const listener = (_event: unknown, data: { workspaceId: string }) => callback(data);
    ipcRenderer.on("mux:notification-clicked", listener);
    return () => {
      ipcRenderer.off("mux:notification-clicked", listener);
    };
  },
  consumePendingDeepLinks: () => pendingDeepLinks.splice(0, pendingDeepLinks.length),
  onDeepLink: (callback: (payload: MuxDeepLinkPayload) => void) => {
    deepLinkSubscribers.add(callback);
    return () => {
      deepLinkSubscribers.delete(callback);
    };
  },
});
