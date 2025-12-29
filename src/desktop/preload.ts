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
import { execSync } from "child_process";

// Forward ORPC MessagePort from renderer to main process
window.addEventListener("message", (event) => {
  if (event.data === "start-orpc-client" && event.ports?.[0]) {
    ipcRenderer.postMessage("start-orpc-server", null, [...event.ports]);
  }
});

/**
 * Detect if running under Rosetta 2 translation on Apple Silicon.
 * Returns true if the process is x64 but running on an arm64 Mac.
 */
function detectRosetta(): boolean {
  if (process.platform !== "darwin" || process.arch === "arm64") {
    return false;
  }
  try {
    // sysctl.proc_translated returns 1 if running under Rosetta
    const result = execSync("sysctl -n sysctl.proc_translated", {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    return result === "1";
  } catch {
    // If the sysctl key doesn't exist (Intel Mac), we're not under Rosetta
    return false;
  }
}

contextBridge.exposeInMainWorld("api", {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  isE2E: process.env.MUX_E2E === "1",
  enableTelemetryInDev: process.env.MUX_ENABLE_TELEMETRY_IN_DEV === "1",
  isRosetta: detectRosetta(),
});
