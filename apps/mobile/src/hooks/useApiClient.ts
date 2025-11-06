import { useMemo } from "react";
import { createClient, type CmuxMobileClientConfig } from "../api/client";

export function useApiClient(config?: CmuxMobileClientConfig) {
  return useMemo(() => createClient(config), [config?.authToken, config?.baseUrl]);
}
