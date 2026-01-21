import {
  usePersistedState,
  readPersistedState,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
import { getAutoRetryKey } from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

export function useAutoRetryPreference(workspaceId: string) {
  return usePersistedState<boolean>(getAutoRetryKey(workspaceId), WORKSPACE_DEFAULTS.autoRetry, {
    listener: true,
  });
}

export function readAutoRetryPreference(workspaceId: string): boolean {
  return readPersistedState<boolean>(getAutoRetryKey(workspaceId), WORKSPACE_DEFAULTS.autoRetry);
}

export function setAutoRetryPreference(workspaceId: string, value: boolean): void {
  updatePersistedState<boolean>(getAutoRetryKey(workspaceId), value);
}

export function enableAutoRetryPreference(workspaceId: string): void {
  setAutoRetryPreference(workspaceId, true);
}

export function disableAutoRetryPreference(workspaceId: string): void {
  setAutoRetryPreference(workspaceId, false);
}
