import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

// Cache the MediaQueryList at module level so subscribe/getSnapshot don't
// create a new object on every call.
const mql = typeof window !== "undefined" ? window.matchMedia(QUERY) : null;

function subscribe(callback: () => void): () => void {
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- no matchMedia in SSR
  if (!mql) return () => {};
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return mql?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns true when the user has enabled "reduce motion" in their OS settings.
 * Reacts to live changes (e.g. toggling the setting while the app is open).
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
