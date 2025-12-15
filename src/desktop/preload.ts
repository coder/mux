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
});
