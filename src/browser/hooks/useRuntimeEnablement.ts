import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { DEFAULT_RUNTIME_KEY, RUNTIME_ENABLEMENT_KEY } from "@/common/constants/storage";
import {
  DEFAULT_RUNTIME_ENABLEMENT,
  RUNTIME_ENABLEMENT_IDS,
  normalizeRuntimeEnablement,
  type RuntimeEnablement,
  type RuntimeEnablementId,
} from "@/common/types/runtime";

interface RuntimeEnablementState {
  enablement: RuntimeEnablement;
  setRuntimeEnabled: (id: RuntimeEnablementId, enabled: boolean) => void;
  defaultRuntime: RuntimeEnablementId | null;
  setDefaultRuntime: (id: RuntimeEnablementId | null) => void;
}

function normalizeDefaultRuntime(value: unknown): RuntimeEnablementId | null {
  if (typeof value !== "string") {
    return null;
  }

  return RUNTIME_ENABLEMENT_IDS.includes(value as RuntimeEnablementId)
    ? (value as RuntimeEnablementId)
    : null;
}

export function useRuntimeEnablement(): RuntimeEnablementState {
  const { api } = useAPI();
  const [rawEnablement, setRawEnablement] = usePersistedState<unknown>(
    RUNTIME_ENABLEMENT_KEY,
    DEFAULT_RUNTIME_ENABLEMENT,
    { listener: true }
  );
  const [rawDefaultRuntime, setRawDefaultRuntime] = usePersistedState<unknown>(
    DEFAULT_RUNTIME_KEY,
    null,
    { listener: true }
  );

  // Normalize persisted values so corrupted/legacy payloads don't break toggles.
  const enablement = normalizeRuntimeEnablement(rawEnablement);
  const defaultRuntime = normalizeDefaultRuntime(rawDefaultRuntime);

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

  const setDefaultRuntime = (id: RuntimeEnablementId | null) => {
    // Keep the local cache and config.json aligned for the global default runtime.
    setRawDefaultRuntime(id);

    api?.config?.updateRuntimeEnablement({ defaultRuntime: id }).catch(() => {
      // Best-effort only.
    });
  };

  return { enablement, setRuntimeEnabled, defaultRuntime, setDefaultRuntime };
}
