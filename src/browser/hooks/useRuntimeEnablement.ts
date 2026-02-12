import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { RUNTIME_ENABLEMENT_KEY } from "@/common/constants/storage";
import {
  DEFAULT_RUNTIME_ENABLEMENT,
  normalizeRuntimeEnablement,
  type RuntimeEnablement,
  type RuntimeEnablementId,
} from "@/common/types/runtime";

interface RuntimeEnablementState {
  enablement: RuntimeEnablement;
  setRuntimeEnabled: (id: RuntimeEnablementId, enabled: boolean) => void;
}

export function useRuntimeEnablement(): RuntimeEnablementState {
  const { api } = useAPI();
  const [rawEnablement, setRawEnablement] = usePersistedState<unknown>(
    RUNTIME_ENABLEMENT_KEY,
    DEFAULT_RUNTIME_ENABLEMENT,
    { listener: true }
  );

  // Normalize persisted values so corrupted/legacy payloads don't break toggles.
  const enablement = normalizeRuntimeEnablement(rawEnablement);

  const setRuntimeEnabled = (id: RuntimeEnablementId, enabled: boolean) => {
    const nextMap: RuntimeEnablement = {
      ...enablement,
      [id]: enabled,
    };

    // Persist locally first so Settings reflects changes immediately and stays in sync.
    setRawEnablement(nextMap);

    // Best-effort backend write keeps ~/.mux/config.json aligned across devices.
    api?.config?.updateRuntimeEnablement({ runtimeEnablement: nextMap }).catch(() => {
      // Best-effort only.
    });
  };

  return { enablement, setRuntimeEnabled };
}
