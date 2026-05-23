import { useEffect, useRef } from "react";

import { useAPI } from "@/browser/contexts/API";
import { updatePersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
import { AUTO_HIDE_SIDEBAR_KEY } from "@/common/constants/storage";

/** Seeded from local cache to avoid a layout flash before the backend responds. */
export function useAutoHideSidebar(): boolean {
  const { api } = useAPI();
  const fetchVersionRef = useRef(0);
  const [rawAutoHideSidebar] = usePersistedState<unknown>(AUTO_HIDE_SIDEBAR_KEY, false, {
    listener: true,
  });
  const autoHideSidebar = rawAutoHideSidebar === true;
  const autoHideSidebarRef = useRef(autoHideSidebar);
  const persistedValueRef = useRef(autoHideSidebar);
  const backendPersistedValueRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    if (persistedValueRef.current !== autoHideSidebar) {
      persistedValueRef.current = autoHideSidebar;
      const backendPersistedValue = backendPersistedValueRef.current;
      backendPersistedValueRef.current = undefined;
      if (backendPersistedValue !== autoHideSidebar) {
        // Settings writes update persisted state first, so old backend reads must not overwrite them.
        fetchVersionRef.current++;
      }
    }

    autoHideSidebarRef.current = autoHideSidebar;
  }, [autoHideSidebar]);

  useEffect(() => {
    const getConfig = api?.config?.getConfig;
    if (!getConfig) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    const setSyncedValue = (enabled: boolean) => {
      if (autoHideSidebarRef.current === enabled) {
        return;
      }

      autoHideSidebarRef.current = enabled;
      backendPersistedValueRef.current = enabled;
      updatePersistedState<boolean | undefined>(AUTO_HIDE_SIDEBAR_KEY, enabled ? true : undefined);
    };

    const refresh = () => {
      const fetchVersion = ++fetchVersionRef.current;
      getConfig()
        .then((config) => {
          if (!signal.aborted && fetchVersion === fetchVersionRef.current) {
            setSyncedValue(config.autoHideSidebar === true);
          }
        })
        .catch(() => {
          // Keep the current preference on failure.
        });
    };

    refresh();

    const onConfigChanged = api?.config?.onConfigChanged;
    if (onConfigChanged) {
      const runSubscription = async () => {
        try {
          const subscribedIterator = await onConfigChanged(undefined, { signal });
          if (signal.aborted) {
            void subscribedIterator.return?.();
            return;
          }

          iterator = subscribedIterator;
          for await (const _ of subscribedIterator) {
            if (signal.aborted) {
              break;
            }
            refresh();
          }
        } catch {
          // Subscription errors are non-fatal.
        }
      };

      void runSubscription();
    }

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api]);

  return autoHideSidebar;
}
