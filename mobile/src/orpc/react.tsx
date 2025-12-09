import { createContext, useContext, useMemo } from "react";
import { createMobileORPCClient, type ORPCClient } from "./client";
import { useAppConfig } from "../contexts/AppConfigContext";

const ORPCContext = createContext<ORPCClient | null>(null);

interface ORPCProviderProps {
  children: React.ReactNode;
}

export function ORPCProvider(props: ORPCProviderProps): JSX.Element {
  const appConfig = useAppConfig();

  const client = useMemo(() => {
    return createMobileORPCClient({
      baseUrl: appConfig.resolvedBaseUrl,
      authToken: appConfig.resolvedAuthToken ?? null,
    });
  }, [appConfig.resolvedBaseUrl, appConfig.resolvedAuthToken]);

  return <ORPCContext.Provider value={client}>{props.children}</ORPCContext.Provider>;
}

export function useORPC(): ORPCClient {
  const ctx = useContext(ORPCContext);
  if (!ctx) {
    throw new Error("useORPC must be used within ORPCProvider");
  }
  return ctx;
}
