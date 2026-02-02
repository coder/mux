/**
 * React context for TerminalSessionRouter.
 *
 * Provides centralized terminal session management to all TerminalView components.
 * Must be wrapped inside APIProvider since it depends on the API client.
 */

import { createContext, useContext, useEffect, useRef } from "react";
import { useAPI } from "@/browser/contexts/API";
import { TerminalSessionRouter } from "./TerminalSessionRouter";

const TerminalRouterContext = createContext<TerminalSessionRouter | null>(null);

interface TerminalRouterProviderProps {
  children: React.ReactNode;
}

/**
 * Provides TerminalSessionRouter to the component tree.
 *
 * Creates a single router instance that lives for the lifetime of the provider.
 * The router is recreated if the API client changes (e.g., reconnection).
 *
 * Always renders children so the app UI stays visible during reconnection.
 * The router may be null when API is unavailable; consumers must handle this.
 */
export function TerminalRouterProvider(props: TerminalRouterProviderProps) {
  const { api } = useAPI();
  const routerRef = useRef<TerminalSessionRouter | null>(null);

  // Create/recreate router when API changes
  if (api && (!routerRef.current || routerRef.current.getApi() !== api)) {
    // Dispose old router if exists
    routerRef.current?.dispose();
    routerRef.current = new TerminalSessionRouter(api);
  }

  // When API disconnects, dispose the router but keep rendering children.
  // This ensures the app UI stays visible during reconnection.
  if (!api && routerRef.current) {
    routerRef.current.dispose();
    routerRef.current = null;
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      routerRef.current?.dispose();
      routerRef.current = null;
    };
  }, []);

  // Always render children - the router may be null during reconnection.
  // Consumers (useTerminalRouter) must handle the null case gracefully.
  return (
    <TerminalRouterContext.Provider value={routerRef.current}>
      {props.children}
    </TerminalRouterContext.Provider>
  );
}

/**
 * Hook to access the TerminalSessionRouter.
 *
 * Returns null when the API is disconnected (e.g., during reconnection).
 * Callers should handle the null case gracefully.
 *
 * @throws If used outside of TerminalRouterProvider
 */
export function useTerminalRouter(): TerminalSessionRouter | null {
  return useContext(TerminalRouterContext);
}
