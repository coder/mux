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

// Handle ORPC connection setup
window.addEventListener("message", (event) => {
  if (event.data === "start-orpc-client") {
    const [serverPort] = event.ports;
    ipcRenderer.postMessage("start-orpc-server", null, [serverPort]);
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
});
