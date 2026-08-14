import { useEffect, useRef, useState } from "react";
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
  /**
   * Classes with a write still in flight (state publishes on the write's
   * ack). Editors must disable a pending row's controls: a second edit built
   * from the still-unpublished rendered state would compose against the old
   * value and overwrite the first edit.
   */
  pendingWrites: Record<string, number>;
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
  // Populated by the subscription effect below; lets the write-failure revert
  // in setModelClass reuse the same stale-guarded fetch. A ref (not a
  // useCallback) keeps this within the repo's React Compiler conventions —
  // no manual memoization for identity stabilization.
  const refetchRef = useRef<() => void>(() => {
    // No-op until the subscription effect installs the real fetch.
  });
  // Newest intended map across not-yet-persisted edits: serialized writes each
  // build on the latest intent, not on the still-unpublished state.
  const pendingMapRef = useRef<Record<string, string> | null>(null);
  // Serializes writes so rapid edits persist in order and the last one wins.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  // Per-class in-flight write counts; consumers disable pending rows.
  const [pendingWrites, setPendingWrites] = useState<Record<string, number>>({});

  useEffect(() => {
    const getConfig = api?.config?.getConfig;
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!getConfig || !onConfigChanged) {
      return;
    }

    const fetchConfig = async () => {
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
    };
    refetchRef.current = () => void fetchConfig();

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
  }, [api]);

  const setModelClass = (className: string, value: string | null) => {
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
    const base = pendingMapRef.current ?? modelClasses;
    const next = { ...base };
    const trimmed = value?.trim() ?? "";
    if (!trimmed) {
      delete next[key];
    } else {
      next[key] = trimmed;
    }
    pendingMapRef.current = next;

    // Guarded lookup rather than a chained call: in partial-API environments
    // (story mocks, tests) a missing route must not throw synchronously.
    const updateModelClasses = api?.config?.updateModelClasses;
    if (!updateModelClasses) {
      pendingMapRef.current = null;
      return;
    }

    setPendingWrites((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));

    // Persist BEFORE publishing: routing reads the backend map at send time,
    // so optimistically advertising the new mapping would let a quick
    // follow-up skill invocation stream on the OLD route while the editor
    // claims the new one. The selects update on the write's ack instead.
    writeChainRef.current = writeChainRef.current
      .then(async () => {
        await updateModelClasses({ modelClasses: next });
        // Newer than any in-flight fetch: the ack is the freshest truth.
        fetchVersionRef.current++;
        setMap(next);
      })
      .catch(() => {
        // If the write fails, re-fetch so the UI reverts to the backend's
        // actual map rather than displaying classes routing never applies.
        refetchRef.current();
      })
      .finally(() => {
        if (pendingMapRef.current === next) {
          pendingMapRef.current = null;
        }
        setPendingWrites((current) => {
          const count = (current[key] ?? 0) - 1;
          if (count > 0) {
            return { ...current, [key]: count };
          }
          const { [key]: _drop, ...rest } = current;
          return rest;
        });
      });
  };

  return {
    modelClasses,
    loaded,
    pendingWrites,
    setModelClass,
  };
}
