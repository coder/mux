import { useMemo } from "react";
import { createClient, type MuxMobileClientConfig } from "../api/client";
import { useAppConfig } from "../contexts/AppConfigContext";

export function useApiClient(config?: MuxMobileClientConfig) {
  const appConfig = useAppConfig();
  const mergedConfig = useMemo<MuxMobileClientConfig>(
    () => ({
      baseUrl: config?.baseUrl ?? appConfig.resolvedBaseUrl,
      authToken: config?.authToken ?? appConfig.resolvedAuthToken,
    }),
    [appConfig.resolvedAuthToken, appConfig.resolvedBaseUrl, config?.authToken, config?.baseUrl]
  );

  return useMemo(() => createClient(mergedConfig), [mergedConfig.authToken, mergedConfig.baseUrl]);
}
