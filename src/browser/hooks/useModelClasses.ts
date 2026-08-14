import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalAPI } from "@/browser/contexts/API";

export interface ModelClassesState {
  /** Class name → model value in one-shot syntax ("haiku+0"). */
  modelClasses: Record<string, string>;
  /**
   * True once the first config fetch has landed. Writes are full-map
   * replacements built from local state, so editing before the initial load
   * would persist a near-empty map and wipe every not-yet-fetched class —
   * consumers must gate their controls on this.
   */
  loaded: boolean;
  // Arrow-function property type so consumers can destructure without
  // tripping @typescript-eslint/unbound-method.
  /** Set (or clear, with null/empty) one class's model value. */
  setModelClass: (className: string, value: string | null) => void;
}

/**
 * Reads/writes the model-classes map (skill routing indirection) from app
 * config. Mirrors useModelFallbacks: fetch on mount, subscribe to config
 * changes, optimistically apply local edits while ignoring stale fetches.
 * Writes are full-map replacements, so hand-edited custom classes survive
 * edits made through the Settings editor.
 */
export function useModelClasses(): ModelClassesState {
  const api = useOptionalAPI()?.api ?? null;
  const [modelClasses, setMap] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  // Ignore stale config fetches so backend refreshes can't overwrite newer optimistic edits.
  const fetchVersionRef = useRef(0);

  const fetchConfig = useCallback(async () => {
    const getConfig = api?.config?.getConfig;
    if (!getConfig) {
      return;
    }

    const fetchVersion = ++fetchVersionRef.current;

    try {
      const config = await getConfig();
      if (fetchVersion !== fetchVersionRef.current) {
        return;
      }
      setMap(config.modelClasses ?? {});
      setLoaded(true);
    } catch {
      // Best-effort only.
    }
  }, [api]);

  useEffect(() => {
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!onConfigChanged) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    void fetchConfig();

    (async () => {
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
          void fetchConfig();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup.
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, fetchConfig]);

  const setModelClass = useCallback(
    (className: string, value: string | null) => {
      const key = className.trim();
      // Writes are full-map replacements from local state: refuse before the
      // initial fetch lands, or an early edit would wipe every class the
      // fetch would have revealed.
      if (!key || !loaded) {
        return;
      }

      // Only the edited entry is touched. Deliberately no map-wide
      // sanitization: hand-edited entries the current build cannot parse
      // (custom models, future syntax) must survive edits made through the
      // Settings editor — a bound-but-unparseable class already fails loudly
      // at send time and is flagged inline by the editor.
      const next = { ...modelClasses };
      const trimmed = value?.trim() ?? "";
      if (!trimmed) {
        delete next[key];
      } else {
        next[key] = trimmed;
      }

      fetchVersionRef.current++;
      setMap(next);

      // Guarded lookup rather than a chained call: in partial-API environments
      // (story mocks, tests) a missing route must not throw synchronously —
      // the .catch below can only intercept async failures.
      const updateModelClasses = api?.config?.updateModelClasses;
      if (!updateModelClasses) {
        return;
      }
      updateModelClasses({ modelClasses: next }).catch(() => {
        // If the write fails, re-fetch so the UI reverts to the backend's
        // actual map rather than displaying classes routing never applies.
        void fetchConfig();
      });
    },
    [api, fetchConfig, loaded, modelClasses]
  );

  return {
    modelClasses,
    loaded,
    setModelClass,
  };
}
