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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      routerRef.current?.dispose();
      routerRef.current = null;
    };
  }, []);

  // Don't render children until API is ready
  if (!api || !routerRef.current) {
    return null;
  }

  return (
    <TerminalRouterContext.Provider value={routerRef.current}>
      {props.children}
    </TerminalRouterContext.Provider>
  );
}

/**
 * Hook to access the TerminalSessionRouter.
 *
 * @throws If used outside of TerminalRouterProvider
 */
export function useTerminalRouter(): TerminalSessionRouter {
  const router = useContext(TerminalRouterContext);
  if (!router) {
    throw new Error("useTerminalRouter must be used within a TerminalRouterProvider");
  }
  return router;
}
