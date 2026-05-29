/**
 * Environment helpers for the browser/renderer runtime.
 */

export function isVscodeWebview(): boolean {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === "function";
}
