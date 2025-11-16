import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { USE_1M_CONTEXT_KEY } from "@/common/constants/storage";

/**
 * Custom hook for 1M context state.
 * Persists state globally in localStorage (applies to all workspaces).
 *
 * @returns [use1MContext, setUse1MContext] tuple
 */
export function use1MContext(): [boolean, (value: boolean) => void] {
  return usePersistedState<boolean>(USE_1M_CONTEXT_KEY, false, { listener: true });
}
